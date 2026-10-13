import type { FacilitatorClient } from '@x402/core/server'
import type { LocalAccount } from 'viem'
import { Calls, assertAbisMatchAllowlist, buildAllowlist } from './chain/calls'
import type { CoverReader } from './chain/reader'
import type { Settings } from './config'
import { silentLogger, type Logger } from './http/respond'
import type { CorePorts } from './ports'
import { QuoteEngine } from './quote/engine'
import type { NonceStore } from './relayer/nonces'
import { Relayer } from './relayer/relayer'
import type { RelayerRpc } from './relayer/rpc'
import type { BlobStore } from './stores/blobs'
import type { Ledger } from './stores/ledger'
import type { RateLimiter } from './stores/rateLimiter'
import type { StateStore } from './stores/state'
import type { Clock, DigestSigner } from './types'

export interface Stores {
  nonces: NonceStore
  limiter: RateLimiter
  ledger: Ledger
  state: StateStore
  blobs: BlobStore
}

/** Everything the service depends on. Nothing is read from globals: clients, keys, storage and time come in here. */
export interface ServiceDeps {
  settings: Settings
  accounts: {
    /** Signs quotes. */
    underwriter: DigestSigner
    /** Pays gas for relayed transactions. */
    relayer: LocalAccount
    /** Signs weather reports; without it the keeper settles but does not report. */
    reporter?: DigestSigner
  }
  /** Shared secrets for the protected endpoints. An endpoint without its secret stays closed. */
  secrets: {
    cron?: string
    sandbox?: string
  }
  reader: CoverReader
  rpc: RelayerRpc
  core: CorePorts
  stores: Stores
  /** x402 facilitator; required when the paid cover endpoint is enabled. */
  facilitator?: FacilitatorClient
  /** Current time in unix seconds. */
  now?: Clock
  logger?: Logger
}

/** The wired-up internals the handlers share. */
export interface Context {
  settings: Settings
  secrets: ServiceDeps['secrets']
  now: Clock
  logger: Logger
  reader: CoverReader
  relayer: Relayer
  calls: Calls
  core: CorePorts
  stores: Stores
  underwriter: DigestSigner
  reporter: DigestSigner | undefined
  quotes: QuoteEngine
  facilitator: FacilitatorClient | undefined
}

export function buildContext(deps: ServiceDeps): Context {
  const { settings, core, stores, reader } = deps
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000))
  const logger = deps.logger ?? silentLogger

  const allowlist = buildAllowlist(settings)
  assertAbisMatchAllowlist(
    core.abis,
    allowlist.list().map((entry) => entry.name),
  )

  const relayer = new Relayer({
    chainId: settings.chainId,
    account: deps.accounts.relayer,
    rpc: deps.rpc,
    nonces: stores.nonces,
    allowlist,
    maxFeePerGas: settings.relayer.maxFeePerGas,
    maxPriorityFeePerGas: settings.relayer.maxPriorityFeePerGas,
    minBalance: settings.relayer.minBalance,
    now,
  })

  const quotes = new QuoteEngine({
    settings,
    reader,
    cells: core.cells,
    pricing: core.pricing,
    signing: core.signing,
    underwriter: deps.accounts.underwriter,
    now,
    logger,
  })

  return {
    settings,
    secrets: deps.secrets,
    now,
    logger,
    reader,
    relayer,
    calls: new Calls(core.abis, settings.contracts),
    core,
    stores,
    underwriter: deps.accounts.underwriter,
    reporter: deps.accounts.reporter,
    quotes,
    facilitator: deps.facilitator,
  }
}
