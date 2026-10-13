/**
 * Gas limits for every call the relayer makes.
 *
 * Monad charges for the gas limit, not for the gas used, so a limit is a price. Each one is the worst case
 * measured for the call plus headroom, and none is higher than it has to be. The measurements come from two
 * places that agree: `contracts/snapshots/Gas.json` (isolated transactions under the Monad gas schedule,
 * intrinsic cost included) and the service's integration tests on a local Monad chain (`test/integration`),
 * which also see the very first use of each storage slot and build the worst cases on purpose. Both use the
 * test dollar; native USDC adds a proxy hop and its own checks to every token call, which the headroom allows
 * for.
 *
 * The limits are fixed here on purpose: nothing a caller sends can raise what a relay costs.
 */

/** Measured 520,278 for the first policy of a new cell; snapshot 485,136. */
export const BUY_WITH_AUTHORIZATION_GAS = 700_000n

/** Measured 454,680 for the first policy of a new cell; snapshot 320,117 for a cell that is already active. */
export const BUY_GAS = 640_000n

/** Measured 178,777 for a first deposit; snapshot 161,221. */
export const DEPOSIT_WITH_AUTHORIZATION_GAS = 280_000n

/** Measured 103,023 for a transfer to an address that held nothing. */
export const TRANSFER_WITH_AUTHORIZATION_GAS = 160_000n

/** Measured 52,103. */
export const APPROVE_GAS = 90_000n

/** Measured 109,468 for the first drip, 92,468 afterwards. */
export const DRIP_GAS = 150_000n

/** No relayed call may ask for more than this. */
export const MAX_RELAY_GAS = 3_000_000n

/**
 * Closing a policy walks the book's `oldestOpenId` forward over the policies that closed before it, at most
 * this many (`OLDEST_OPEN_STEPS` in the book).
 */
export const OLDEST_OPEN_STEPS_PER_CLOSE = 32

/** One step of that walk: a cold read of the next policy. Measured 8,304 per step under the Monad schedule. */
export const OLDEST_OPEN_STEP_GAS = 8_500n

/** What one close may spend walking the mark: 32 cold steps, 272,000. */
export const CLOSE_WALK_GAS = OLDEST_OPEN_STEP_GAS * BigInt(OLDEST_OPEN_STEPS_PER_CLOSE)

/**
 * `expire` of one policy: pays what was reported, closes it, frees the last slot of its cell, releases the rest
 * of its exposure and walks the mark 32 steps. Measured 473,970 for exactly that.
 */
export const EXPIRE_GAS = 560_000n

const SETTLE_BASE_GAS = 160_000n
const SETTLE_POLICY_GAS = 150_000n

/**
 * `settleMany` over `count` policies, `closing` of which may close. Every policy is budgeted as a payout to an
 * address that held nothing in a cell of its own, and every close as one that frees its cell and walks the
 * mark the full 32 steps. Measured: 498,113 for one such policy, 378,686 for each further one (3,527,599 for
 * nine); a payout that does not close is the same less the walk.
 *
 * Closing policies are not cheap to budget: more than six of them do not fit under `MAX_RELAY_GAS`, so a
 * batch has to be cut to size with `settlementBatches` before it is sent.
 */
export function settleManyGas(count: number, closing: number = count): bigint {
  const closes = Math.min(Math.max(closing, 0), count)
  return SETTLE_BASE_GAS + SETTLE_POLICY_GAS * BigInt(count) + CLOSE_WALK_GAS * BigInt(closes)
}

/**
 * Cuts settlements into `settleMany` batches, in order: at most `maxCount` each, and never one whose gas limit
 * is above `MAX_RELAY_GAS`, which the relayer would refuse on every tick.
 */
export function settlementBatches<T>(items: readonly T[], mayClose: (item: T) => boolean, maxCount: number): T[][] {
  const batches: T[][] = []
  let batch: T[] = []
  let closing = 0
  for (const item of items) {
    const closes = mayClose(item) ? 1 : 0
    if (
      batch.length > 0 &&
      (batch.length >= maxCount || settleManyGas(batch.length + 1, closing + closes) > MAX_RELAY_GAS)
    ) {
      batches.push(batch)
      batch = []
      closing = 0
    }
    batch.push(item)
    closing += closes
  }
  if (batch.length > 0) batches.push(batch)
  return batches
}

/** Most steps one `syncOldestOpen` may be asked to walk: what fits under `MAX_RELAY_GAS`. */
export const MAX_SYNC_STEPS = 320

/**
 * `syncOldestOpen(steps)`: one cold read per step and one write of the mark. Measured 30,732 with nothing to
 * walk, 166,566 for 16 steps and 432,294 for 48.
 */
export function syncOldestOpenGas(steps: number): bigint {
  return 50_000n + OLDEST_OPEN_STEP_GAS * BigInt(Math.max(steps, 0))
}

/**
 * `submit` of a report. Measured 55,513 for an empty heartbeat, 100,438 with one reading of a cell that
 * already has a timeline and 134,746 with one that starts a timeline; the snapshot's ten-reading reports
 * give the same 45,000 and 79,000 per reading.
 */
export function submitGas(readings: { known: number; fresh: number }): bigint {
  return 75_000n + 52_000n * BigInt(readings.known) + 92_000n * BigInt(readings.fresh)
}
