import 'server-only'
import { CRON_SECRET_HEADER, SANDBOX_SECRET_HEADER, type Handler } from './service-module'
import { errorJson, getService, serverConfig, startFailure } from './service'

/** Headers passed on to the service, so its per-address limits see the real client. */
const FORWARDED = ['x-forwarded-for', 'x-real-ip', 'content-type']

/** One weather check at a time, and not more often than this, whoever asks. */
const WEATHER_CHECK_INTERVAL_MS = 20_000
let lastWeatherCheck = 0

type Target = 'drip' | 'storm' | 'tick'

/**
 * Calls a protected service handler on behalf of the browser in practice mode. The shared secret is added
 * here, on the server; it never reaches the page. Outside practice mode every route answers 404.
 */
export async function practice(request: Request, target: Target): Promise<Response> {
  let secrets
  let settings
  try {
    ;({ settings, secrets } = serverConfig())
  } catch (error) {
    return startFailure(error)
  }
  if (!settings.sandbox.enabled || settings.chainId === 143 || !secrets.sandboxSecret) {
    return errorJson(404, 'not_found', 'Not found')
  }

  if (target === 'tick') {
    if (!secrets.cronSecret) return errorJson(503, 'not_configured', 'The weather check is not available here')
    const now = Date.now()
    const wait = lastWeatherCheck + WEATHER_CHECK_INTERVAL_MS - now
    if (wait > 0) {
      const seconds = String(Math.ceil(wait / 1000))
      return errorJson(429, 'rate_limited', 'The weather was checked a moment ago', { 'retry-after': seconds })
    }
    lastWeatherCheck = now
  }

  let service
  try {
    service = await getService()
  } catch (error) {
    return startFailure(error)
  }

  const headers = new Headers()
  for (const name of FORWARDED) {
    const value = request.headers.get(name)
    if (value) headers.set(name, value)
  }
  let handler: Handler
  if (target === 'tick') {
    headers.set(CRON_SECRET_HEADER, secrets.cronSecret!)
    handler = service.handlers.cronTick
  } else {
    headers.set(SANDBOX_SECRET_HEADER, secrets.sandboxSecret)
    handler = target === 'drip' ? service.handlers.sandboxDrip : service.handlers.sandboxStorm
  }

  const body = request.method === 'GET' ? null : target === 'tick' ? null : await request.arrayBuffer()
  return handler(
    new Request(new URL(`/api/sandbox/${target}`, request.url), {
      method: target === 'tick' ? 'POST' : request.method,
      headers,
      ...(body ? { body } : {}),
    }),
  )
}
