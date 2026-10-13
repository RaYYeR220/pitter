import type { PoolPosition } from '../chain/reader'

/** Where a backer stands with leaving the pool. */
export type LeaveState =
  /** Nothing in the pool, nothing asked. */
  | { phase: 'none' }
  /** In the pool, and has not asked to leave. */
  | { phase: 'in'; shares: bigint; value: bigint }
  /** Asked to leave; the notice is running. */
  | { phase: 'waiting'; shares: bigint; claimableAt: number; remainingMs: number }
  /**
   * The notice is over. `partly` when some of it still backs cover that has not ended and can only be taken
   * out once that cover is settled.
   */
  | { phase: 'ready'; shares: bigint; claimableShares: bigint; claimableAssets: bigint; partly: boolean }

/** `nowMs` is unix milliseconds; the countdown runs against the chain's `claimableAt`. */
export function leaveState(position: PoolPosition, nowMs: number): LeaveState {
  const { request } = position
  if (request) {
    const remainingMs = request.claimableAt * 1000 - nowMs
    if (remainingMs > 0)
      return { phase: 'waiting', shares: request.shares, claimableAt: request.claimableAt, remainingMs }
    return {
      phase: 'ready',
      shares: request.shares,
      claimableShares: position.claimableShares,
      claimableAssets: position.claimableAssets,
      partly: position.claimableShares < request.shares,
    }
  }
  if (position.shares > 0n) return { phase: 'in', shares: position.shares, value: position.value }
  return { phase: 'none' }
}

/** Whether the backer's own account can pay the network fee of leaving. */
export type FeeCheck =
  | { ok: true }
  /** The account holds no MON at all. */
  | { ok: false; reason: 'no_balance' }
  /** It holds some, less than the transaction costs at the current price. */
  | { ok: false; reason: 'too_little'; needed: bigint; balance: bigint }

export function feeCheck(native: bigint, estimatedCost: bigint | null): FeeCheck {
  if (native === 0n) return { ok: false, reason: 'no_balance' }
  if (estimatedCost !== null && native < estimatedCost) {
    return { ok: false, reason: 'too_little', needed: estimatedCost, balance: native }
  }
  return { ok: true }
}
