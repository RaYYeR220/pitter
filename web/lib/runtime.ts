import type { Address, PublicClient } from 'viem'
import {
  AccountManager,
  browserHintStore,
  meraPasskeys,
  pageRelyingParty,
  type Passkeys,
  type PaymentTerms,
} from './account'
import { createChainClient } from './chain/client'
import { viemChainReader, type AccountBalances, type ChainReader, type PoolPosition } from './chain/reader'
import {
  COVER_DEFAULTS,
  PRODUCT_NAME,
  SESSION_DEFAULTS,
  configFromHealth,
  type AppConfig,
  type HealthReport,
} from './config'
import { CoverEngine } from './cover/engine'
import {
  PolicyTable,
  RpcCoverHistorySource,
  coveredUntil,
  type CoverHistorySource,
  type CoverSnapshot,
} from './cover/history'
import { CoverSelection } from './cover/selection'
import { copy } from './copy'
import { Feed, FeedFamily } from './feed'
import { IndexerCoverHistorySource, IndexerGate, createIndexerClient, poolIndexReader, reuseFor } from './indexer'
import { loadActivity, loadPoolView, type LatestActivity, type PoolView } from './pool'
import { createServiceClient, type PracticeRain, type ServiceClient } from './service/client'
import { ShiftLogManager, ShiftLogStore } from './shiftlog'

/**
 * Everything the pages work with, wired once per page load. Nothing in here outlives the tab: the account
 * key, the shift log key and the decrypted log all live in these objects and nowhere else.
 */
export interface Runtime {
  health: HealthReport
  config: AppConfig
  service: ServiceClient
  chain: PublicClient
  reader: ChainReader
  /** Every row of the cover book seen so far, shared by the cover history and the pool totals. */
  policies: PolicyTable
  /** The holder's cover for the screens: from the indexer when one is configured and fresh, else the chain. */
  history: CoverHistorySource
  account: AccountManager
  shiftLog: ShiftLogManager
  engine: CoverEngine
  selection: CoverSelection
  passkeys: Passkeys
  feeds: Feeds
}

export type { PoolView } from './pool'

/** Values read on a timer while a page shows them. */
export interface Feeds {
  health: Feed<HealthReport>
  balance: FeedFamily<Address, AccountBalances>
  history: FeedFamily<Address, CoverSnapshot>
  pool: Feed<PoolView>
  recent: Feed<LatestActivity>
  position: FeedFamily<Address, PoolPosition>
  /** Null outside practice mode. */
  rain: Feed<PracticeRain> | null
}

const unixSeconds = () => Math.floor(Date.now() / 1000)

function passkeyLabel(): string {
  const day = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date())
  return copy.account.passkeyLabel(day)
}

export async function createRuntime(service: ServiceClient = createServiceClient()): Promise<Runtime> {
  const health = await service.health()
  const config = configFromHealth(health, process.env.NEXT_PUBLIC_RPC_URL, process.env.NEXT_PUBLIC_INDEXER_URL)
  const chain = createChainClient(config)
  const reader = viemChainReader(chain, config)
  const policies = new PolicyTable(reader)
  const chainHistory = new RpcCoverHistorySource(reader, policies)

  const indexer = config.indexerUrl
    ? {
        client: createIndexerClient(config.indexerUrl),
        gate: new IndexerGate({ head: () => chain.getBlockNumber() }),
      }
    : null
  const history: CoverHistorySource = indexer
    ? new IndexerCoverHistorySource({ ...indexer, chainId: config.chainId, reader, fallback: chainHistory })
    : chainHistory
  const poolIndex = indexer ? poolIndexReader(indexer.client, config.chainId, indexer.gate) : null
  // The indexer is polled no faster than every 15 seconds; without it the chain reads keep their own pace.
  const pace = (indexed: number, chainOnly: number) => (indexer ? indexed : chainOnly)
  // While the indexer is down, the chain's logs are searched no more often than they are without one.
  const chainActivity = reuseFor(pace(45_000, 0), () => reader.recentActivity())
  const passkeys = meraPasskeys(() => pageRelyingParty(PRODUCT_NAME))

  const terms = async (): Promise<PaymentTerms> => ({
    domain: await reader.tokenDomain(),
    payee: config.contracts.coverBook,
  })

  const account = new AccountManager({
    passkeys,
    terms,
    policy: {
      lengthMs: SESSION_DEFAULTS.lengthMs,
      idleMs: SESSION_DEFAULTS.idleMs,
      maxSpendPerHour: SESSION_DEFAULTS.maxSpendPerHour,
    },
    hints: browserHintStore(),
    label: passkeyLabel,
  })

  const shiftLog = new ShiftLogManager({
    passkeys,
    store: new ShiftLogStore({ transport: service, chainId: config.chainId, now: unixSeconds }),
    credential: () => account.credential(),
    now: unixSeconds,
  })

  let minLead: Promise<number> | null = null
  const engine = new CoverEngine(
    {
      now: unixSeconds,
      signer: () => account.coverSigner(),
      quote: (request) => service.quote(request),
      relayBuy: (quote, authorization) => service.relayBuy(quote, authorization),
      balance: async (holder) => (await reader.balances(holder)).dollars,
      quoteUsed: (digest) => reader.quoteUsed(digest),
      minLead() {
        minLead ??= reader
          .rules()
          .then((rules) => rules.minLead)
          .catch((error: unknown) => {
            minLead = null
            throw error
          })
        return minLead
      },
      // Deciding where new cover starts must see a purchase made seconds ago, so it reads the chain, not the index.
      async coveredUntil(holder, key) {
        return coveredUntil(await chainHistory.snapshot(holder), key, unixSeconds())
      },
      deployment: { chainId: config.chainId, coverBook: config.contracts.coverBook },
      keepAwake: (awake) => account.keepAwake(awake),
      onBought(block) {
        if (block.policyId !== null && block.transactionHash) history.remember?.(block.policyId, block.transactionHash)
      },
    },
    { blockSeconds: COVER_DEFAULTS.blockSeconds, renewLeadSeconds: COVER_DEFAULTS.renewLeadSeconds },
  )

  const selection = new CoverSelection({ simulatorKey: config.practice?.simulator.key ?? null })

  const feeds: Feeds = {
    health: new Feed(() => service.health(), { intervalMs: 60_000 }),
    balance: new FeedFamily((holder) => new Feed(() => reader.balances(holder), { intervalMs: 10_000 })),
    history: new FeedFamily((holder) => new Feed(() => history.snapshot(holder), { intervalMs: pace(15_000, 10_000) })),
    pool: new Feed(() => loadPoolView({ reader, policies, index: poolIndex }), { intervalMs: pace(15_000, 20_000) }),
    recent: new Feed(() => loadActivity({ chain: chainActivity, index: poolIndex }), {
      intervalMs: pace(15_000, 60_000),
    }),
    position: new FeedFamily((owner) => new Feed(() => reader.position(owner), { intervalMs: 15_000 })),
    rain: config.practice ? new Feed(() => service.practiceRain(), { intervalMs: 15_000 }) : null,
  }

  return {
    health,
    config,
    service,
    chain,
    reader,
    policies,
    history,
    account,
    shiftLog,
    engine,
    selection,
    passkeys,
    feeds,
  }
}
