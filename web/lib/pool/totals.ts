import type { ActivityEvent, PolicyRow, RecentActivity } from '../chain/reader'

const BPS = 10_000n

/** What the pool has taken in and paid out since the book opened. */
export interface PoolTotals {
  covers: number
  /** Premiums paid by holders, fee included. */
  premiums: bigint
  /** The share of the premiums that went to the treasury rather than the pool. */
  fees: bigint
  /** Paid out to holders. */
  payouts: bigint
  /** Premiums kept by the pool minus payouts. Negative when it rained more than was priced. */
  net: bigint
}

/**
 * Totals over every row of the cover book. The book keeps each policy's premium and what it has paid, so the
 * totals need no event history; the fee is worked out per policy and rounded down, as the book takes it.
 *
 * @param feeBps The book's current fee. A fee changed after sales were made would make this an estimate.
 */
export function poolTotals(rows: readonly PolicyRow[], feeBps: number): PoolTotals {
  let premiums = 0n
  let fees = 0n
  let payouts = 0n
  for (const row of rows) {
    premiums += row.premium
    fees += (row.premium * BigInt(feeBps)) / BPS
    payouts += row.paid
  }
  return { covers: rows.length, premiums, fees, payouts, net: premiums - fees - payouts }
}

/** Sales and payouts in a stretch of recent blocks, summed. */
export interface RecentTotals {
  fromBlock: bigint
  toBlock: bigint
  blocks: number
  sold: number
  premiums: bigint
  payouts: bigint
  events: ActivityEvent[]
}

export function recentTotals(activity: RecentActivity): RecentTotals {
  let sold = 0
  let premiums = 0n
  let payouts = 0n
  for (const event of activity.events) {
    if (event.kind === 'bought') {
      sold++
      premiums += event.amount
    } else {
      payouts += event.amount
    }
  }
  return {
    fromBlock: activity.fromBlock,
    toBlock: activity.toBlock,
    blocks: Number(activity.toBlock - activity.fromBlock) + 1,
    sold,
    premiums,
    payouts,
    events: activity.events,
  }
}
