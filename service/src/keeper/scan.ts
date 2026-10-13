import type { Json } from '../stores/ledger'

/**
 * Where the keeper's walk over the policies stands.
 *
 * Every policy below `low` is known to be closed. `next` is where the next tick starts reading. A tick reads
 * at most `limit` ids from `next` and moves `next` past them; at the end of the book it wraps back to `low`.
 * So a policy that stays open (one the oracle never finishes, waiting for `expire`) can hold `low` back but
 * never the walk itself: every open policy is read at least once every ceil((policyCount - low + 1) / limit)
 * ticks.
 */
export interface ScanCursor {
  low: bigint
  next: bigint
}

export interface ScanRange {
  from: bigint
  to: bigint
}

const ID = /^[1-9]\d{0,30}$/

const id = (value: unknown): bigint | null => (typeof value === 'string' && ID.test(value) ? BigInt(value) : null)

/** Reads a stored cursor. A bare id, as earlier versions stored it, is the low mark. */
export function parseCursor(stored: Json | null): ScanCursor {
  const legacy = id(stored)
  if (legacy !== null) return { low: legacy, next: legacy }
  if (stored && typeof stored === 'object' && !Array.isArray(stored)) {
    const low = id(stored.low)
    const next = id(stored.next)
    if (low !== null) return { low, next: next !== null && next >= low ? next : low }
  }
  return { low: 1n, next: 1n }
}

export const cursorToJson = (cursor: ScanCursor): Json => ({ low: cursor.low.toString(), next: cursor.next.toString() })

/** The ids this tick reads, or null when every policy is known to be closed. */
export function planScan(cursor: ScanCursor, policyCount: bigint, limit: number): ScanRange | null {
  if (cursor.low > policyCount || limit < 1) return null
  const from = cursor.next >= cursor.low && cursor.next <= policyCount ? cursor.next : cursor.low
  const last = from + BigInt(limit) - 1n
  return { from, to: last < policyCount ? last : policyCount }
}

/**
 * The cursor after reading `scan`. `firstOpen` is the lowest id in the range that was still open. The low mark
 * only moves when the range started at it, so it never skips an open policy.
 */
export function advanceCursor(
  cursor: ScanCursor,
  scan: ScanRange,
  firstOpen: bigint | null,
  policyCount: bigint,
): ScanCursor {
  const low = scan.from === cursor.low ? (firstOpen ?? scan.to + 1n) : cursor.low
  return { low, next: scan.to >= policyCount ? low : scan.to + 1n }
}
