import { tooManyRequests } from '../http/errors'

export interface RateRule {
  /** Requests allowed per window. */
  limit: number
  windowSeconds: number
}

export interface RateDecision {
  allowed: boolean
  retryAfterSeconds: number
}

/** Counts requests per bucket in fixed windows. Implementations must count atomically. */
export interface RateLimiter {
  hit(bucket: string, rule: RateRule, now: number): Promise<RateDecision>
}

export function windowStart(now: number, windowSeconds: number): number {
  return Math.floor(now / windowSeconds) * windowSeconds
}

export function decide(count: number, rule: RateRule, now: number): RateDecision {
  if (count <= rule.limit) return { allowed: true, retryAfterSeconds: 0 }
  const retryAfterSeconds = Math.max(1, windowStart(now, rule.windowSeconds) + rule.windowSeconds - now)
  return { allowed: false, retryAfterSeconds }
}

/** Process-local limiter for development and tests. It does not coordinate between server instances. */
export class MemoryRateLimiter implements RateLimiter {
  private readonly counters = new Map<string, { start: number; count: number }>()
  private readonly maxBuckets: number

  constructor(maxBuckets = 50_000) {
    this.maxBuckets = maxBuckets
  }

  async hit(bucket: string, rule: RateRule, now: number): Promise<RateDecision> {
    const start = windowStart(now, rule.windowSeconds)
    const counter = this.counters.get(bucket)
    const count = counter && counter.start === start ? counter.count + 1 : 1

    if (!counter && this.counters.size >= this.maxBuckets) this.prune(now, rule.windowSeconds)
    this.counters.set(bucket, { start, count })
    return decide(count, rule, now)
  }

  private prune(now: number, windowSeconds: number): void {
    const cutoff = windowStart(now, windowSeconds)
    for (const [bucket, counter] of this.counters) {
      if (counter.start < cutoff) this.counters.delete(bucket)
    }
    if (this.counters.size >= this.maxBuckets) this.counters.clear()
  }
}

/** Counts one request against each bucket in order and refuses with 429 at the first one that is full. */
export async function enforceLimits(
  limiter: RateLimiter,
  now: number,
  checks: ReadonlyArray<{ bucket: string; rule: RateRule }>,
): Promise<void> {
  for (const { bucket, rule } of checks) {
    const decision = await limiter.hit(bucket, rule, now)
    if (!decision.allowed) throw tooManyRequests(decision.retryAfterSeconds)
  }
}
