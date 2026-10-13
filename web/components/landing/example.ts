import { PRICING_DEFAULTS } from '@cover/core/pricing'
import { COVER_DEFAULTS } from '@/lib/config'

/**
 * The landing's worked example. The weather is made up; every price is worked out here with the same rule the
 * service prices cover with, so the example cannot drift from the product:
 *
 *   premium = payout per second x chance of heavy rain x seconds x (1 + margin), rounded up to a millionth
 */

const BPS = 10_000n
const PPM = 1_000_000n

/** What cover costs for `seconds` at a chance of heavy rain given in millionths. */
export function examplePremium(ratePerSecond: bigint, chancePpm: bigint, seconds: number): bigint {
  const loaded = ratePerSecond * chancePpm * BigInt(seconds) * (BPS + BigInt(PRICING_DEFAULTS.loadBps))
  const denominator = PPM * BPS
  return (loaded + denominator - 1n) / denominator
}

const MINUTE = 60
const BLOCK = COVER_DEFAULTS.blockSeconds
const RATE = COVER_DEFAULTS.defaultRate
/** The lowest chance anything is priced at: a dry afternoon. */
const FLOOR_PPM = BigInt(PRICING_DEFAULTS.floorBps) * 100n
/** What the hourly forecast gives the evening when the rest of the shift is locked. */
const EVENING_PPM = 40_000n
/** What the 15-minute forecast gives the next ten minutes once it sees the rain coming. */
const STORM_PPM = 700_000n

/** Clock times of the example, minutes after midnight. */
export const EXAMPLE_TIMES = {
  start: 16 * 60,
  lock: 17 * 60,
  seen: 18 * 60 + 30,
  rain: 18 * 60 + 41,
  dry: 19 * 60 + 4,
  end: 22 * 60,
} as const

const payBlocks = (EXAMPLE_TIMES.lock - EXAMPLE_TIMES.start) / (BLOCK / MINUTE)
const wetMinutes = EXAMPLE_TIMES.dry - EXAMPLE_TIMES.rain

/** The payout in parts, one per weather check, as the rain crossed each one. */
const checks = [18 * 60 + 45, 18 * 60 + 50, 18 * 60 + 55, 19 * 60, 19 * 60 + 5]
const parts = checks.map((at, i) => {
  const from = Math.max(EXAMPLE_TIMES.rain, i === 0 ? EXAMPLE_TIMES.rain : checks[i - 1]!)
  const to = Math.min(EXAMPLE_TIMES.dry, at)
  return { at, minutes: to - from, amount: RATE * BigInt((to - from) * MINUTE) }
})

const dryPerMinute = examplePremium(RATE, FLOOR_PPM, MINUTE)
const blockCost = examplePremium(RATE, FLOOR_PPM, BLOCK)
const payAsYouGo = blockCost * BigInt(payBlocks)
const locked = examplePremium(RATE, EVENING_PPM, (EXAMPLE_TIMES.end - EXAMPLE_TIMES.lock) * MINUTE)
const stormBlock = examplePremium(RATE, STORM_PPM, BLOCK)
const paid = RATE * BigInt(wetMinutes * MINUTE)

export const EXAMPLE = {
  ratePerSecond: RATE,
  ratePerMinute: RATE * BigInt(MINUTE),
  floorChance: Number(FLOOR_PPM) / 1e6,
  eveningChance: Number(EVENING_PPM) / 1e6,
  stormChance: Number(STORM_PPM) / 1e6,
  loadBps: PRICING_DEFAULTS.loadBps,
  blockMinutes: BLOCK / MINUTE,
  payBlocks,
  dryPerMinute,
  blockCost,
  payAsYouGo,
  locked,
  stormBlock,
  wetMinutes,
  parts,
  paid,
  cost: payAsYouGo + locked,
  ahead: paid - payAsYouGo - locked,
} as const

/**
 * Dollars to the last millionth that matters, at least to the cent: the example's small prices are exact, so
 * that ten minutes at $0.0015 a minute reads $0.015, not a rounded $0.02 that would not add up.
 */
export function formatExact(units: bigint, options: { sign?: boolean } = {}): string {
  const negative = units < 0n
  const absolute = negative ? -units : units
  const prefix = negative ? '−' : options.sign && absolute > 0n ? '+' : ''
  const whole = absolute / 1_000_000n
  let fraction = (absolute % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '')
  if (fraction.length < 2) fraction = fraction.padEnd(2, '0')
  return `${prefix}$${whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${fraction}`
}

/** The pool example: one area a few cents short of room for the next ten minutes. */
const AREA_LIMIT = 2_500_000_000n
const AREA_USED = 2_499_200_000n
export const POOL_EXAMPLE = {
  limit: AREA_LIMIT,
  used: AREA_USED,
  left: AREA_LIMIT - AREA_USED,
  /** The most the next ten minutes could pay: what has to fit under the limit. */
  needed: RATE * BigInt(BLOCK),
  share: Number((AREA_USED * 10_000n) / AREA_LIMIT) / 10_000,
} as const
