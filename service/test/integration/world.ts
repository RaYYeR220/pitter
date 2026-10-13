import { coverBookAbi, coverPoolAbi, testDollarAbi } from '@cover/core/abi'
import { x402Facilitator } from '@x402/core/facilitator'
import type { FacilitatorClient } from '@x402/core/server'
import { toFacilitatorEvmSigner } from '@x402/evm'
import { ExactEvmScheme } from '@x402/evm/exact/facilitator'
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  parseEther,
  parseTransaction,
  publicActions,
  type Address,
  type Hex,
  type PublicClient,
  type TransactionSerializedEIP1559,
} from 'viem'
import { generatePrivateKey, privateKeyToAccount, privateKeyToAddress, type PrivateKeyAccount } from 'viem/accounts'
import { coreCells, coreWeather } from '../../src/adapters/core'
import { depsFromEnv } from '../../src/env'
import type { Pricing } from '../../src/ports'
import { RELAYED_FUNCTIONS, selectorOf, type RelayedFunction } from '../../src/relayer/allowlist'
import { MemoryNonceStore } from '../../src/relayer/nonces'
import { createService, type Service } from '../../src/service'
import { MemoryBlobStore } from '../../src/stores/blobs'
import { MemoryLedger } from '../../src/stores/ledger'
import { MemoryRateLimiter } from '../../src/stores/rateLimiter'
import { MemoryStateStore } from '../../src/stores/state'
import { deployContracts, startChain, type Deployment, type LocalChain } from '../helpers/chain'
import { RecordingLogger } from '../helpers/fakes'
import { signAuthorization } from '../helpers/signing'

export const CRON_SECRET = 'integration-cron-secret-0123456789'
export const SANDBOX_SECRET = 'integration-sandbox-secret-012345'
export const SIMULATOR = { lat: 1.025, lon: 1.025 }
export const SIMULATOR_KEY = coreCells.keyAt(SIMULATOR.lat, SIMULATOR.lon)
export const CHAIN_ID = 31337
export const DRIP = 1_000_000_000n
export const RATE = 1_000n
export const DURATION = 600
export const MAX_PAYOUT = RATE * BigInt(DURATION)
export const PREMIUM = (MAX_PAYOUT * 5n) / 100n
export const FEE = (PREMIUM * 500n) / 10_000n

/** Charges 5% of the maximum payout, so every expected balance can be computed by hand. */
const flatPricing: Pricing = {
  async price({ start, end, ratePerSecond }) {
    return { premium: (ratePerSecond * BigInt(end - start) * 5n) / 100n, inputs: { model: 'flat 5%' } }
  },
}

/** The official x402 facilitator logic, settling on the local chain from its own funded key. */
function localFacilitator(url: string, key: Hex): FacilitatorClient {
  const account = privateKeyToAccount(key)
  const local = defineChain({
    id: CHAIN_ID,
    name: 'local',
    nativeCurrency: { name: 'Monad', symbol: 'MON', decimals: 18 },
    rpcUrls: { default: { http: [url] } },
  })
  const wallet = createWalletClient({ account, chain: local, transport: http(url) }).extend(publicActions)
  const signer = toFacilitatorEvmSigner({
    address: account.address,
    readContract: (args) => wallet.readContract(args as never),
    verifyTypedData: (args) => wallet.verifyTypedData(args as never),
    writeContract: (args) => wallet.writeContract(args as never),
    sendTransaction: (args) => wallet.sendTransaction(args),
    waitForTransactionReceipt: (args) => wallet.waitForTransactionReceipt(args),
    getCode: (args) => wallet.getCode(args),
  })
  const facilitator = new x402Facilitator().register(`eip155:${CHAIN_ID}`, new ExactEvmScheme(signer))
  return {
    verify: (payload, requirements) => facilitator.verify(payload, requirements),
    settle: (payload, requirements) => facilitator.settle(payload, requirements),
    getSupported: async () => ({ kinds: [], extensions: [], signers: {} }),
  }
}

const nameOf = (selector: string) =>
  (Object.keys(RELAYED_FUNCTIONS) as RelayedFunction[]).find((name) => selectorOf(name) === selector) ?? selector

export interface TickOutcome {
  report: { status: string; reason?: string; readings: Array<Record<string, unknown>>; transactions: Hex[] }
  settlement: {
    settled: Array<{ id: string; paid: string; closed: boolean }>
    expired: Array<{ id: string; paid: string }>
    failures: string[]
  }
}

/**
 * A local chain following the Monad gas rules, the contracts deployed on it by the project's deploy script,
 * and the service running in-process against it with generated keys. Weather and pricing are stand-ins;
 * everything else is the real thing.
 */
export async function startWorld() {
  const keys = {
    deployer: generatePrivateKey(),
    underwriter: generatePrivateKey(),
    relayer: generatePrivateKey(),
    reporter: generatePrivateKey(),
    facilitator: generatePrivateKey(),
  }
  const underwriter = privateKeyToAccount(keys.underwriter)
  const relayerAddress = privateKeyToAddress(keys.relayer)
  const treasury = privateKeyToAddress(generatePrivateKey())

  const chain: LocalChain = await startChain()
  let contracts: Deployment
  try {
    for (const key of [keys.deployer, keys.relayer, keys.facilitator]) {
      await chain.setBalance(privateKeyToAddress(key), parseEther('1000'))
    }
    contracts = deployContracts(chain, keys.deployer, {
      reporter: privateKeyToAddress(keys.reporter),
      underwriter: underwriter.address,
      treasury,
    })
  } catch (error) {
    chain.stop()
    throw error
  }
  const client = createPublicClient({ transport: http(chain.url) }) as PublicClient

  const clock = { now: 0 }
  const logger = new RecordingLogger()
  const verdicts = new Map<bigint, boolean>()
  const gas: Array<{ name: string; limit: bigint; used: bigint }> = []
  const nodeMethods = new Set<string>()

  /** Notes which JSON-RPC methods the service calls on the node. */
  const observedFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (typeof init?.body === 'string') {
      const sent = JSON.parse(init.body) as { method: string } | Array<{ method: string }>
      for (const call of Array.isArray(sent) ? sent : [sent]) nodeMethods.add(call.method)
    }
    return fetch(input, init)
  }) as typeof fetch

  const deps = await depsFromEnv(
    {
      CHAIN_ID: String(CHAIN_ID),
      RPC_URL: chain.url,
      TOKEN_ADDRESS: contracts.token,
      COVER_BOOK_ADDRESS: contracts.coverBook,
      COVER_POOL_ADDRESS: contracts.coverPool,
      WEATHER_INDEX_ADDRESS: contracts.weatherIndex,
      UNDERWRITER_PRIVATE_KEY: keys.underwriter,
      RELAYER_PRIVATE_KEY: keys.relayer,
      REPORTER_PRIVATE_KEY: keys.reporter,
      CRON_SECRET,
      SANDBOX_ENABLED: 'true',
      SANDBOX_SECRET,
      SANDBOX_SIMULATOR_KEY: SIMULATOR_KEY.toString(),
      X402_ENABLED: 'true',
      QUOTE_MAX_RATE_PER_SECOND: '1000000',
      RATE_SANDBOX_PER_IP: '1000',
      RATE_RELAY_PER_IP: '1000',
      RATE_RELAY_PER_ADDRESS: '1000',
    },
    {
      now: () => clock.now,
      logger,
      fetch: observedFetch,
      core: {
        pricing: flatPricing,
        weather: {
          observe: async (cells) =>
            new Map(cells.filter((key) => verdicts.has(key)).map((key) => [key, verdicts.get(key)!])),
          buildReadings: coreWeather({ fetch: async () => ({ status: 503, text: async () => '' }), userAgent: 'test' })
            .buildReadings,
        },
      },
    },
  )
  deps.facilitator = localFacilitator(chain.url, keys.facilitator)
  const send = deps.rpc.send.bind(deps.rpc)
  deps.rpc.send = async (serialized) => {
    const receipt = await send(serialized)
    const transaction = parseTransaction(serialized as TransactionSerializedEIP1559)
    gas.push({ name: nameOf(transaction.data!.slice(0, 10)), limit: transaction.gas!, used: receipt.gasUsed })
    return receipt
  }
  let service: Service = createService(deps)

  /** Brings the service clock in line with the chain. */
  const sync = async () => (clock.now = await chain.time())
  await sync()

  const at = (path: string) => `http://cover.local${path}`
  const get = (path: string, headers: Record<string, string> = {}) => service.fetch(new Request(at(path), { headers }))
  const post = (path: string, payload: unknown, headers: Record<string, string> = {}) =>
    service.fetch(
      new Request(at(path), {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(payload),
      }),
    )
  const sandbox = (path: string, payload: unknown) => post(path, payload, { 'x-sandbox-secret': SANDBOX_SECRET })

  const tokenDomain = () => ({
    name: 'Test Dollar',
    version: '1',
    chainId: CHAIN_ID,
    verifyingContract: contracts.token,
  })

  return {
    chain,
    contracts,
    client,
    keys,
    underwriter,
    relayerAddress,
    treasury,
    clock,
    logger,
    verdicts,
    gas,
    nodeMethods,
    sync,
    get,
    post,
    sandbox,
    tokenDomain,
    stop: () => chain.stop(),

    /** Replaces the service with one that remembers nothing, as after a restart without a database. */
    restart() {
      deps.stores = {
        nonces: new MemoryNonceStore(),
        limiter: new MemoryRateLimiter(),
        ledger: new MemoryLedger(),
        state: new MemoryStateStore(),
        blobs: new MemoryBlobStore(),
      }
      service = createService(deps)
    },

    async tick(): Promise<TickOutcome> {
      await sync()
      const response = await post('/cron/tick', {}, { 'x-cron-secret': CRON_SECRET })
      if (response.status !== 200) throw new Error(`the keeper tick answered ${response.status}`)
      await sync()
      return (await response.json()) as TickOutcome
    },

    /** The next window that can still be bought: it starts on a minute at least 90 seconds from now. */
    nextWindow() {
      const start = Math.ceil((clock.now + 90) / 60) * 60
      return { start, end: start + DURATION }
    },

    balanceOf: (owner: Address) =>
      client.readContract({ address: contracts.token, abi: testDollarAbi, functionName: 'balanceOf', args: [owner] }),
    relayerNonce: () => client.getTransactionCount({ address: relayerAddress }),
    policyCount: () =>
      client.readContract({ address: contracts.coverBook, abi: coverBookAbi, functionName: 'policyCount' }),
    lockedExposure: () =>
      client.readContract({ address: contracts.coverPool, abi: coverPoolAbi, functionName: 'lockedExposure' }),

    /** A relay body for buying `quote`, with the premium authorised by `signer`. */
    async buyBody(quote: Record<string, string>, quoteSig: Hex, digest: Hex, signer: PrivateKeyAccount) {
      const authorization = await signAuthorization(signer, 'ReceiveWithAuthorization', tokenDomain(), {
        from: quote.holder as Address,
        to: contracts.coverBook,
        value: BigInt(quote.premium!),
        nonce: digest,
        validBefore: BigInt(clock.now + 3_600),
      })
      return { quote, quoteSig, ...authorization }
    },

    /** Gives each address test dollars from the faucet. */
    async fund(owners: readonly Address[]) {
      for (const address of owners) {
        const response = await sandbox('/sandbox/drip', { address })
        if (response.status !== 200) throw new Error(`drip answered ${response.status}`)
      }
    },
  }
}

export type World = Awaited<ReturnType<typeof startWorld>>

export const json = (response: Response): Promise<any> => response.json()
