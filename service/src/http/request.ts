import type { Context } from '../context'
import type { RateRule } from '../stores/rateLimiter'
import { enforceLimits } from '../stores/rateLimiter'
import { clientIp } from './client'
import { ServiceError } from './errors'

export function requireMethod(request: Request, ...methods: string[]): void {
  if (methods.includes(request.method)) return
  throw new ServiceError(405, 'method_not_allowed', 'Method not allowed', { headers: { allow: methods.join(', ') } })
}

/** Path segments after `prefix`, with the service base path removed. Null when the path is elsewhere. */
export function pathAfter(request: Request, basePath: string, prefix: string): string[] | null {
  const { pathname } = new URL(request.url)
  const root = `${basePath}${prefix}`
  if (pathname !== root && !pathname.startsWith(`${root}/`)) return null
  return pathname
    .slice(root.length)
    .split('/')
    .filter((segment) => segment.length > 0)
}

export const perWindow = (context: Context, limit: number): RateRule => ({
  limit,
  windowSeconds: context.settings.limits.windowSeconds,
})

/** Counts the request against the per-IP limit of `scope`. */
export async function limitByIp(context: Context, request: Request, scope: string, limit: number): Promise<void> {
  const ip = clientIp(request, context.settings.clientIp)
  await enforceLimits(context.stores.limiter, context.now(), [
    { bucket: `${scope}:ip:${ip}`, rule: perWindow(context, limit) },
  ])
}

/** Counts the request against the per-address limit of `scope`. */
export async function limitByAddress(context: Context, scope: string, address: string, limit: number): Promise<void> {
  await enforceLimits(context.stores.limiter, context.now(), [
    { bucket: `${scope}:address:${address.toLowerCase()}`, rule: perWindow(context, limit) },
  ])
}
