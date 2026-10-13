import { RAIN_THRESHOLD_MM_PER_HOUR } from '../weather/types'
import type { Forecast } from './forecast'

export const PRICING_DEFAULTS = {
  /** Lowest probability of rain any slot is priced at, in basis points. */
  floorBps: 100,
  /** Margin added on top of the expected payout, in basis points. */
  loadBps: 2500,
  thresholdMmPerHour: RAIN_THRESHOLD_MM_PER_HOUR,
  /** How far ahead the 15-minute forecast is consulted. Later slots are priced from the hourly probability. */
  nowcastHorizonSeconds: 2 * 60 * 60,
} as const

const SLOT_SECONDS = 900
const HOUR_SECONDS = 3600
const MINUTE_SECONDS = 60
const PPM = 1_000_000
const BPS = 10_000

/** Thrown when the forecast has no data for part of the window: the cover cannot be priced. */
export class ForecastUnavailableError extends Error {
  constructor(start: number, end: number) {
    super(`no forecast for ${new Date(start * 1000).toISOString()} - ${new Date(end * 1000).toISOString()}`)
    this.name = 'ForecastUnavailableError'
  }
}

/** One stretch of the window with the forecast it was priced from. */
export type PriceSlot = {
  /** Unix seconds. */
  start: number
  end: number
  seconds: number
  /** Forecast intensity for the slot's quarter-hour; null when the slot lies beyond the nowcast horizon or has no value. */
  forecastMmPerHour: number | null
  /** Chance in percent of rain within the slot's hour; null when the forecast has no value. */
  precipitationProbability: number | null
  /** Probability, between 0 and 1, that a second of this slot is wet. This is what the slot is priced at. */
  probabilityWet: number
  /** Which input set the probability: the 15-minute forecast, the hourly chance of rain, or the floor. */
  basis: 'nowcast' | 'hourly' | 'floor'
}

export type PremiumQuote = {
  key: bigint
  /** Token base units charged for the window. */
  premium: bigint
  /** Most the policy can pay: the rate times the length of the window. */
  maxPayout: bigint
  /** Expected payout before the load, rounded down. */
  expectedPayout: bigint
  expectedWetSeconds: number
  loadBps: number
  floorBps: number
  slots: PriceSlot[]
}

export type QuotePremiumInput = {
  cell: { key: bigint }
  /** Window start and end in unix seconds, both on a full minute. */
  start: number
  end: number
  /** Token base units paid per wet second. */
  ratePerSecond: bigint
  forecast: Forecast
  /** Unix seconds at which the quote is made. */
  now: number
  loadBps?: number
  floorBps?: number
  thresholdMmPerHour?: number
  nowcastHorizonSeconds?: number
}

const lookup = (times: readonly number[], values: readonly (number | null)[]) => {
  const byTime = new Map<number, number | null>()
  times.forEach((time, i) => byTime.set(time, values[i] ?? null))
  return (time: number) => byTime.get(time) ?? null
}

/**
 * Prices a window of cover:
 *
 *   premium = rate x sum over slots of P(wet) x seconds x (1 + load)
 *
 * The window is cut along the forecast's 15-minute grid. Within the nowcast horizon a slot's P(wet) is the
 * forecast intensity relative to the trigger (rain at or above the trigger counts as certain), but never less
 * than the hourly chance of rain: a dry nowcast with rain likely within the hour must not make cover cheap.
 * Beyond the horizon P(wet) is the hourly chance of rain. Every slot is priced at the floor or above. The
 * hourly chance is the chance of any rain in that hour, which is at least the chance of rain above the trigger,
 * so the price errs towards the pool.
 */
export function quotePremium(input: QuotePremiumInput): PremiumQuote {
  const { start, end, ratePerSecond, forecast, now } = input
  const loadBps = input.loadBps ?? PRICING_DEFAULTS.loadBps
  const floorBps = input.floorBps ?? PRICING_DEFAULTS.floorBps
  const threshold = input.thresholdMmPerHour ?? PRICING_DEFAULTS.thresholdMmPerHour
  const horizon = input.nowcastHorizonSeconds ?? PRICING_DEFAULTS.nowcastHorizonSeconds

  if (!Number.isInteger(start) || !Number.isInteger(end) || start % MINUTE_SECONDS !== 0 || end % MINUTE_SECONDS !== 0) {
    throw new RangeError('the window must start and end on a full minute')
  }
  if (end <= start) throw new RangeError('the window must end after it starts')
  if (ratePerSecond <= 0n) throw new RangeError('the rate must be positive')
  if (loadBps < 0 || floorBps < 0 || floorBps > BPS || threshold <= 0) throw new RangeError('invalid pricing parameters')

  const nowcastAt = lookup(forecast.minutely15.time, forecast.minutely15.precipitation)
  const hourlyAt = lookup(forecast.hourly.time, forecast.hourly.precipitationProbability)
  const floorPpm = floorBps * (PPM / BPS)

  const slots: PriceSlot[] = []
  let weightedPpmSeconds = 0
  for (let slotStart = start; slotStart < end; ) {
    const gridEnd = Math.floor(slotStart / SLOT_SECONDS) * SLOT_SECONDS + SLOT_SECONDS
    const slotEnd = Math.min(gridEnd, end)
    const seconds = slotEnd - slotStart

    // Forecast values describe the interval that ends at their timestamp.
    const nearTerm = slotStart - now < horizon
    const millimetres = nearTerm ? nowcastAt(gridEnd) : null
    const forecastMmPerHour = millimetres === null ? null : Math.round(millimetres * (HOUR_SECONDS / SLOT_SECONDS) * 1000) / 1000
    const precipitationProbability = hourlyAt(Math.floor(slotStart / HOUR_SECONDS) * HOUR_SECONDS + HOUR_SECONDS)
    if (forecastMmPerHour === null && precipitationProbability === null) throw new ForecastUnavailableError(slotStart, slotEnd)

    const nowcastPpm = forecastMmPerHour === null ? -1 : Math.round(Math.min(forecastMmPerHour / threshold, 1) * PPM)
    const hourlyPpm = precipitationProbability === null ? -1 : Math.round(Math.min(Math.max(precipitationProbability, 0), 100) * (PPM / 100))
    let ppm = Math.max(nowcastPpm, hourlyPpm)
    let basis: PriceSlot['basis'] = nowcastPpm >= hourlyPpm ? 'nowcast' : 'hourly'
    if (ppm <= floorPpm) {
      ppm = floorPpm
      basis = 'floor'
    }

    weightedPpmSeconds += ppm * seconds
    slots.push({
      start: slotStart,
      end: slotEnd,
      seconds,
      forecastMmPerHour,
      precipitationProbability,
      probabilityWet: ppm / PPM,
      basis,
    })
    slotStart = slotEnd
  }

  const weighted = BigInt(weightedPpmSeconds)
  const loaded = ratePerSecond * weighted * BigInt(BPS + loadBps)
  const denominator = BigInt(PPM) * BigInt(BPS)
  return {
    key: input.cell.key,
    premium: (loaded + denominator - 1n) / denominator,
    maxPayout: ratePerSecond * BigInt(end - start),
    expectedPayout: (ratePerSecond * weighted) / BigInt(PPM),
    expectedWetSeconds: weightedPpmSeconds / PPM,
    loadBps,
    floorBps,
    slots,
  }
}
