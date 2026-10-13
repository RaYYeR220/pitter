import type { CoverReader, Policy } from '../chain/reader'

export interface Settleable {
  policy: Policy
  /** Amount a settlement would pay right now. */
  claimable: bigint
  /** Whether the settlement would also close the policy. */
  closes: boolean
  /**
   * Whether a settlement sent now could close it: it would, or its window is over (or about to be) and a report
   * landing first would finish it. A close walks the book's oldest-open mark and is budgeted for that.
   */
  mayClose: boolean
}

/** How far ahead of the chain clock a window's end counts as over, for budgeting a close. */
const CLOSE_SLACK_SECONDS = 120

/**
 * Of the given policies, those a settlement would change: there is a payout to push, or the whole window has
 * been reported and the policy can be closed and its exposure released. Settling anything else only burns gas.
 */
export async function findSettleable(reader: CoverReader, policies: readonly Policy[]): Promise<Settleable[]> {
  const open = policies.filter((policy) => !policy.closed)
  if (open.length === 0) return []

  const keys = [...new Set(open.map((policy) => policy.key))]
  const [head, lastTo, claimable] = await Promise.all([
    reader.head(),
    reader.lastTo(keys),
    reader.claimable(open.map((policy) => policy.id)),
  ])

  const result: Settleable[] = []
  open.forEach((policy, i) => {
    const reported = Number(lastTo.get(policy.key) ?? 0n)
    const confirmedUntil = Math.min(head.timestamp, policy.end, reported)
    if (confirmedUntil <= policy.settledUntil) return
    const amount = claimable[i] ?? 0n
    const closes = confirmedUntil === policy.end
    const mayClose = closes || policy.end <= head.timestamp + CLOSE_SLACK_SECONDS
    if (amount > 0n || closes) result.push({ policy, claimable: amount, closes, mayClose })
  })
  return result
}

/** Raised to abandon a settlement that another transaction has already made pointless. */
export class NothingToSettle extends Error {
  constructor() {
    super('nothing to settle')
    this.name = 'NothingToSettle'
  }
}
