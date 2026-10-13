import { HTTPFacilitatorClient } from '@x402/core/server'
import { createPublicClient, defineChain, http, type PublicClient } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { createCorePorts } from './adapters/core'
import { viemCoverReader } from './chain/reader'
import { loadConfig, type Secrets } from './config'
import type { ServiceDeps, Stores } from './context'
import type { Logger } from './http/respond'
import type { CorePorts } from './ports'
import { migrate, pgDatabase } from './postgres/database'
import { PostgresNonceStore } from './postgres/nonces'
import { PostgresBlobStore, PostgresLedger, PostgresRateLimiter, PostgresStateStore } from './postgres/stores'
import { MemoryNonceStore } from './relayer/nonces'
import { viemRelayerRpc } from './relayer/rpc'
import { createService, type Service } from './service'
import { MemoryBlobStore } from './stores/blobs'
import { MemoryLedger } from './stores/ledger'
import { MemoryRateLimiter } from './stores/rateLimiter'
import { MemoryStateStore } from './stores/state'
import type { Clock } from './types'

const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11'
const MONAD_CHAINS = new Set([143, 10143])
const RPC_TIMEOUT_MS = 10_000
const POOL_SIZE = 4

export interface EnvOverrides {
  /** Used for the node, the weather sources and the forecast. Defaults to the platform `fetch`. */
  fetch?: typeof fetch
  now?: Clock
  logger?: Logger
  /** Replaces parts of the core package, for example the weather sources in a test. */
  core?: Partial<CorePorts>
  stores?: Partial<Stores>
}

/**
 * Writes one JSON line per event. Errors are reduced to their name and message, and the node URL, which can
 * carry an API key, is masked wherever it appears.
 */
export function consoleLogger(secrets: Pick<Secrets, 'rpcUrl'>): Logger {
  const mask = (text: string) => text.split(secrets.rpcUrl).join('[node]')
  const plain = (value: unknown): unknown => {
    if (value instanceof Error) return { name: value.name, message: mask(value.message).slice(0, 2_000) }
    if (typeof value === 'bigint') return value.toString()
    if (typeof value === 'string') return mask(value)
    return value
  }
  const write =
    (level: 'info' | 'warn' | 'error') =>
    (message: string, fields: Record<string, unknown> = {}) => {
      const entry: Record<string, unknown> = { level, message }
      for (const [name, value] of Object.entries(fields)) entry[name] = plain(value)
      console[level](JSON.stringify(entry))
    }
  return { info: write('info'), warn: write('warn'), error: write('error') }
}

async function postgresStores(databaseUrl: string): Promise<Stores> {
  const { default: pg } = await import('pg')
  const db = pgDatabase(new pg.Pool({ connectionString: databaseUrl, max: POOL_SIZE }))
  await migrate(db)
  return {
    nonces: new PostgresNonceStore(db),
    limiter: new PostgresRateLimiter(db),
    ledger: new PostgresLedger(db),
    state: new PostgresStateStore(db),
    blobs: new PostgresBlobStore(db),
  }
}

function memoryStores(): Stores {
  return {
    nonces: new MemoryNonceStore(),
    limiter: new MemoryRateLimiter(),
    ledger: new MemoryLedger(),
    state: new MemoryStateStore(),
    blobs: new MemoryBlobStore(),
  }
}

/** Everything `createService` needs, built from environment variables alone. */
export async function depsFromEnv(
  env: Record<string, string | undefined>,
  overrides: EnvOverrides = {},
): Promise<ServiceDeps> {
  const { settings, secrets } = loadConfig(env)
  const fetchFn = overrides.fetch ?? fetch

  const monad = MONAD_CHAINS.has(settings.chainId)
  const chain = defineChain({
    id: settings.chainId,
    name: `chain ${settings.chainId}`,
    nativeCurrency: { name: 'Monad', symbol: 'MON', decimals: 18 },
    rpcUrls: { default: { http: [secrets.rpcUrl] } },
    ...(monad ? { contracts: { multicall3: { address: MULTICALL3 } } } : {}),
  })
  const client = createPublicClient({
    chain,
    transport: http(secrets.rpcUrl, { fetchFn, timeout: RPC_TIMEOUT_MS, retryCount: 1 }),
    ...(monad ? { batch: { multicall: true } } : {}),
  }) as PublicClient

  const core = {
    ...createCorePorts({ fetch: fetchFn, userAgent: settings.weather.userAgent }),
    ...overrides.core,
  }
  const stores = {
    ...(secrets.databaseUrl ? await postgresStores(secrets.databaseUrl) : memoryStores()),
    ...overrides.stores,
  }

  return {
    settings,
    accounts: {
      underwriter: privateKeyToAccount(secrets.underwriterKey),
      relayer: privateKeyToAccount(secrets.relayerKey),
      ...(secrets.reporterKey ? { reporter: privateKeyToAccount(secrets.reporterKey) } : {}),
    },
    secrets: {
      ...(secrets.cronSecret ? { cron: secrets.cronSecret } : {}),
      ...(secrets.sandboxSecret ? { sandbox: secrets.sandboxSecret } : {}),
    },
    reader: viemCoverReader(client, core.abis, settings),
    rpc: viemRelayerRpc(client, { receiptTimeoutMs: settings.relayer.receiptTimeoutMs }),
    core,
    stores,
    ...(settings.x402.enabled ? { facilitator: new HTTPFacilitatorClient({ url: settings.x402.facilitatorUrl }) } : {}),
    logger: overrides.logger ?? consoleLogger(secrets),
    ...(overrides.now ? { now: overrides.now } : {}),
  }
}

/**
 * The service as configured by the environment: in-memory stores unless `DATABASE_URL` is set, in which case
 * the tables are created on first use and every store is shared through Postgres.
 */
export async function createServiceFromEnv(
  env: Record<string, string | undefined> = process.env,
  overrides: EnvOverrides = {},
): Promise<Service> {
  return createService(await depsFromEnv(env, overrides))
}
