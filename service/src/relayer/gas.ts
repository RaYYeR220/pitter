/**
 * Gas limits for every call the relayer makes.
 *
 * Monad charges for the gas limit, not for the gas used, so each limit is the worst case recorded in
 * `contracts/snapshots/Gas.json` (isolated transactions under the Monad gas schedule, intrinsic cost included)
 * plus headroom for native USDC, whose proxy and compliance checks cost more than the test dollar the snapshot
 * was taken with. The limits are fixed here on purpose: nothing a caller sends can raise what a relay costs.
 */

/** Snapshot worst case 485,136 (first policy in a new cell). */
export const BUY_WITH_AUTHORIZATION_GAS = 650_000n

/** Snapshot 320,117 for an active cell; a new cell adds about 91,000. */
export const BUY_GAS = 560_000n

/** Snapshot 161,221. */
export const DEPOSIT_WITH_AUTHORIZATION_GAS = 260_000n

/** A token transfer authorised by signature. */
export const TRANSFER_WITH_AUTHORIZATION_GAS = 140_000n

export const APPROVE_GAS = 90_000n

export const DRIP_GAS = 130_000n

/** No relayed call may ask for more than this. */
export const MAX_RELAY_GAS = 3_000_000n

/**
 * `settleMany` over `count` policies. Snapshot: 218,722 for one payout that closes its policy, 339,112 for
 * three. Each further policy can touch a different holder, cell and timeline, so it is budgeted close to a
 * full settlement rather than at the marginal cost the snapshot's mixed batch shows.
 */
export function settleManyGas(count: number): bigint {
  return 90_000n + 190_000n * BigInt(count)
}

/**
 * `submit` of a report. Snapshot: about 64,000 for the empty heartbeat, 46,000 for each further reading of a
 * cell that already has a timeline and 84,000 for each reading that starts one.
 */
export function submitGas(readings: { known: number; fresh: number }): bigint {
  return 110_000n + 55_000n * BigInt(readings.known) + 95_000n * BigInt(readings.fresh)
}
