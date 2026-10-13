import { privateKeyToAccount } from 'viem/accounts'
import { coreAbis, coreCells, coreSigning } from '../../src/adapters/core'
import { loadConfig } from '../../src/config'
import { buildContext, type Context, type ServiceDeps } from '../../src/context'
import { guard, type Handler } from '../../src/http/respond'
import { MemoryNonceStore } from '../../src/relayer/nonces'
import { MemoryBlobStore } from '../../src/stores/blobs'
import { MemoryLedger } from '../../src/stores/ledger'
import { MemoryRateLimiter } from '../../src/stores/rateLimiter'
import { MemoryStateStore } from '../../src/stores/state'
import { validEnv } from './env'
import { FakePricing, FakeReader, FakeRpc, FakeWeather, RecordingLogger, T0 } from './fakes'

/** The service wired to an in-memory chain, fake weather and pricing, and freshly generated keys. */
export function harness(env: Record<string, string | undefined> = {}) {
  const { settings, secrets } = loadConfig(validEnv(env))
  const underwriter = privateKeyToAccount(secrets.underwriterKey)
  const relayerAccount = privateKeyToAccount(secrets.relayerKey)
  const reporter = secrets.reporterKey ? privateKeyToAccount(secrets.reporterKey) : undefined

  const reader = new FakeReader()
  reader.domain = {
    name: 'Test Dollar',
    version: '1',
    chainId: settings.chainId,
    verifyingContract: settings.contracts.token,
  }
  const rpc = new FakeRpc()
  rpc.chain = settings.chainId
  const pricing = new FakePricing()
  const weather = new FakeWeather()
  const logger = new RecordingLogger()
  const clock = { time: T0 }
  const stores = {
    nonces: new MemoryNonceStore(),
    limiter: new MemoryRateLimiter(),
    ledger: new MemoryLedger(),
    state: new MemoryStateStore(),
    blobs: new MemoryBlobStore(),
  }

  const deps: ServiceDeps = {
    settings,
    accounts: { underwriter, relayer: relayerAccount, ...(reporter ? { reporter } : {}) },
    secrets: {
      ...(secrets.cronSecret ? { cron: secrets.cronSecret } : {}),
      ...(secrets.sandboxSecret ? { sandbox: secrets.sandboxSecret } : {}),
    },
    reader,
    rpc,
    core: { abis: coreAbis, signing: coreSigning, cells: coreCells, pricing, weather },
    stores,
    now: () => clock.time,
    logger,
  }
  const context: Context = buildContext(deps)

  return {
    settings,
    secrets,
    deps,
    context,
    reader,
    rpc,
    pricing,
    weather,
    logger,
    clock,
    stores,
    underwriter,
    relayerAccount,
    reporter,
    /** Wraps a handler the way the service does, so failures come back as responses. */
    guarded: (handler: Handler): Handler => guard('test', handler, logger),
  }
}

export type Harness = ReturnType<typeof harness>

export async function body(response: Response): Promise<any> {
  return response.json()
}

export const get = (path: string, headers: Record<string, string> = {}) =>
  new Request(`https://cover.test${path}`, { headers })

export const post = (path: string, payload: unknown, headers: Record<string, string> = {}) =>
  new Request(`https://cover.test${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof payload === 'string' ? payload : JSON.stringify(payload),
  })
