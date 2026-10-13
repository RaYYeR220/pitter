export interface ClientIpSettings {
  /** Header the hosting platform writes the client address into. */
  header: string
  /** Number of trusted proxies that append to the header; the entry that many places from the end is used. */
  trustedHops: number
}

const UNKNOWN = 'unknown'

/**
 * Address the request came from, as reported by the trusted proxy. Requests without a usable header share one
 * bucket, so a caller cannot escape the per-IP limits by omitting or mangling it.
 */
export function clientIp(request: Request, settings: ClientIpSettings): string {
  const raw = request.headers.get(settings.header)
  if (!raw) return UNKNOWN
  const entries = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
  const candidate = entries[entries.length - settings.trustedHops]
  if (!candidate || candidate.length > 64 || !/^[0-9a-fA-F:.]+$/.test(candidate)) return UNKNOWN
  return candidate.toLowerCase()
}
