/**
 * Gas limits for every call the relayer makes.
 *
 * Monad charges for the gas limit, not for the gas used, so a limit is a price. Each one is the worst case
 * measured for the call plus headroom, and none is higher than it has to be. The measurements come from two
 * places that agree: `contracts/snapshots/Gas.json` (isolated transactions under the Monad gas schedule,
 * intrinsic cost included) and the receipts of the service's integration tests on a local Monad chain, which
 * also see the very first use of each storage slot. Both use the test dollar; native USDC adds a proxy hop
 * and its own checks to every token call, which the headroom allows for.
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
 * `settleMany` over `count` policies. Measured 189,525 for one payout; snapshot 218,722 for a payout that
 * closes its policy and 339,112 for a mixed batch of three. Each further policy can touch a different
 * holder, cell and timeline, so it is budgeted close to a full settlement rather than at the marginal cost
 * the mixed batch shows.
 */
export function settleManyGas(count: number): bigint {
  return 90_000n + 190_000n * BigInt(count)
}

/**
 * `submit` of a report. Measured 55,513 for an empty heartbeat, 100,438 with one reading of a cell that
 * already has a timeline and 134,746 with one that starts a timeline; the snapshot's ten-reading reports
 * give the same 45,000 and 79,000 per reading.
 */
export function submitGas(readings: { known: number; fresh: number }): bigint {
  return 75_000n + 52_000n * BigInt(readings.known) + 92_000n * BigInt(readings.fresh)
}
