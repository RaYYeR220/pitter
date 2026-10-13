import 'server-only'
import { ConfigError, createServiceFromEnv, loadConfig, type Service } from './service-module'

const BASE_PATH = '/api'

interface Holder {
  service?: Promise<Service>
}

const holder = globalThis as typeof globalThis & { __pitterService?: Holder }
const state: Holder = (holder.__pitterService ??= {})

/** Raised when the deployment is not configured; the message names variables, never values. */
export class NotConfigured extends Error {
  readonly problems: readonly string[]

  constructor(problems: readonly string[]) {
    super('the service is not configured')
    this.name = 'NotConfigured'
    this.problems = problems
  }
}

function environment(): Record<string, string | undefined> {
  const env = { ...process.env }
  if (env.BASE_PATH !== undefined && env.BASE_PATH !== '' && env.BASE_PATH !== BASE_PATH) {
    throw new NotConfigured([`BASE_PATH: the web app mounts the service under ${BASE_PATH}`])
  }
  env.BASE_PATH = BASE_PATH
  return env
}

/** The settings and secrets of this deployment, parsed once per call. Never returned to a client. */
export function serverConfig() {
  try {
    return loadConfig(environment())
  } catch (error) {
    if (error instanceof ConfigError) throw new NotConfigured(error.problems)
    throw error
  }
}

/**
 * The service, built once per server process from the environment. A failed start is not cached, so fixing
 * the environment and retrying works without a restart.
 */
export function getService(): Promise<Service> {
  state.service ??= (async () => {
    try {
      return await createServiceFromEnv(environment())
    } catch (error) {
      if (error instanceof ConfigError) throw new NotConfigured(error.problems)
      throw error
    }
  })().catch((error: unknown) => {
    state.service = undefined
    throw error
  })
  return state.service
}

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
}

/** An error in the service's own format. */
export function errorJson(status: number, code: string, message: string, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ error: { code, message } }), { status, headers: { ...JSON_HEADERS, ...extra } })
}

export function json(body: unknown, status = 200): Response {
  return new Response(
    JSON.stringify(body, (_key, value: unknown) => (typeof value === 'bigint' ? value.toString() : value)),
    { status, headers: JSON_HEADERS },
  )
}

/** Answers a failure to start the service without revealing anything about the environment. */
export function startFailure(error: unknown): Response {
  if (error instanceof NotConfigured) {
    console.error(JSON.stringify({ level: 'error', message: 'service not configured', problems: error.problems }))
    return errorJson(503, 'not_configured', 'The service is not configured')
  }
  console.error(
    JSON.stringify({ level: 'error', message: 'service failed to start', error: error instanceof Error ? error.name : 'unknown' }),
  )
  return errorJson(503, 'unavailable', 'The service is not available right now')
}
