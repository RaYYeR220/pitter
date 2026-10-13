import type { CellObservation } from '../weather/aggregate'
import { METAR_NOMINAL_MM_PER_HOUR, METAR_SOURCE_ID } from '../weather/metar'
import { RAIN_THRESHOLD_MM_PER_HOUR, type ReadingsBySource } from '../weather/types'
import type { Forecast, ModelForecast } from './forecast'

export const PRICING_DEFAULTS = {
  /** Lowest probability of rain any slot is priced at, in basis points. */
  floorBps: 100,
  /** Margin added on top of the expected payout, in basis points. */
  loadBps: 2500,
  thresholdMmPerHour: RAIN_THRESHOLD_MM_PER_HOUR,
  /** How far ahead the 15-minute forecast is consulted. Later slots are priced from the hourly forecast. */
  nowcastHorizonSeconds: 2 * 60 * 60,
  /** Lowest probability of rain, in basis points, for slots near in time while a settlement source reports rain. */
  observedWetBps: 9000,
  /** How far ahead of the quote the observation floor reaches. */
  observationWindowSeconds: 60 * 60,
} as const

/** Model name given to a forecast that does not name its models. */
export const DEFAULT_FORECAST_MODEL = 'best_match'

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
  /**
   * Intensity the driving model forecast for the slot: its 15-minute forecast within the nowcast horizon, its
   * hourly amount beyond it. Null when that model has no such value.
   */
  forecastMmPerHour: number | null
  /** The driving model's chance in percent of rain within the slot's hour; null when it gives none. */
  precipitationProbability: number | null
  /** Probability, between 0 and 1, that a second of this slot is wet. This is what the slot is priced at. */
  probabilityWet: number
  /**
   * Which input of the driving model set the probability: the 15-minute forecast, the hourly forecast, or the
   * floor when every model is below it.
   */
  basis: 'nowcast' | 'hourly' | 'floor'
  /**
   * The model that drove the slot: the wettest of the models the oracle settles from (ties go to the first in
   * `FORECAST_MODELS`). `best_match` for a forecast that names no models. Always set by `quotePremium`.
   */
  model?: string
  /**
   * True when a settlement source reported rain at quote time and that lifted the slot to the observation
   * floor. `basis` then still names the forecast input. Always set by `quotePremium`.
   */
  observationFloor?: boolean
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
  /** The forecast models the price was taken from. Always set by `quotePremium`. */
  models?: string[]
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
  /**
   * What the settlement sources say about the cell now: the readings the oracle aggregates
   * (`fetchObservations(...).observations.get(key)`) or the cell's observation from `aggregate`. When any
   * source reports rain at or above the trigger, or the nearest airport reports rain, slots that start within
   * `observationWindowSeconds` are priced at `observedWetBps` or more.
   */
  observed?: ReadingsBySource | CellObservation
  observedWetBps?: number
  observationWindowSeconds?: number
}

type Lookup = (time: number) => number | null

type ModelLookup = {
  model: string
  nowcast: Lookup
  hourlyProbability: Lookup
  hourlyPrecipitation: Lookup
}

type Estimate = {
  model: string
  ppm: number
  forecastMmPerHour: number | null
  precipitationProbability: number | null
  basis: 'nowcast' | 'hourly'
}

const lookup = (times: readonly number[], values: readonly (number | null)[] | undefined): Lookup => {
  const byTime = new Map<number, number | null>()
  times.forEach((time, i) => byTime.set(time, values?.[i] ?? null))
  return (time: number) => byTime.get(time) ?? null
}

function modelsOf(forecast: Forecast): ModelLookup[] {
  const models: readonly ModelForecast[] =
    forecast.models && forecast.models.length > 0
      ? forecast.models
      : [
          {
            model: DEFAULT_FORECAST_MODEL,
            minutely15: forecast.minutely15,
            hourly: {
              time: forecast.hourly.time,
              precipitationProbability: forecast.hourly.precipitationProbability,
              precipitation: forecast.hourly.precipitation ?? [],
            },
          },
        ]
  return models.map((model) => ({
    model: model.model,
    nowcast: lookup(model.minutely15.time, model.minutely15.precipitation),
    hourlyProbability: lookup(model.hourly.time, model.hourly.precipitationProbability),
    hourlyPrecipitation: lookup(model.hourly.time, model.hourly.precipitation),
  }))
}

const roundMm = (value: number) => Math.round(value * 1000) / 1000

/**
 * One model's estimate for a slot: its intensity relative to the trigger (rain at or above the trigger counts
 * as certain), but never less than its chance of rain in the slot's hour. Null when the model has neither.
 */
function estimate(model: ModelLookup, gridEnd: number, hourEnd: number, nearTerm: boolean, threshold: number): Estimate | null {
  const quarter = nearTerm ? model.nowcast(gridEnd) : null
  const hourly = model.hourlyPrecipitation(hourEnd)
  const forecastMmPerHour =
    quarter !== null ? roundMm(quarter * (HOUR_SECONDS / SLOT_SECONDS)) : hourly !== null ? roundMm(hourly) : null
  const precipitationProbability = model.hourlyProbability(hourEnd)
  if (forecastMmPerHour === null && precipitationProbability === null) return null

  const intensityPpm = forecastMmPerHour === null ? -1 : Math.round(Math.min(Math.max(forecastMmPerHour, 0) / threshold, 1) * PPM)
  const probabilityPpm =
    precipitationProbability === null ? -1 : Math.round(Math.min(Math.max(precipitationProbability, 0), 100) * (PPM / 100))
  const intensityBasis = quarter !== null ? 'nowcast' : 'hourly'
  return {
    model: model.model,
    ppm: Math.max(intensityPpm, probabilityPpm, 0),
    forecastMmPerHour,
    precipitationProbability,
    basis: intensityPpm >= probabilityPpm ? intensityBasis : 'hourly',
  }
}

function isCellObservation(observed: ReadingsBySource | CellObservation): observed is CellObservation {
  const candidate = observed as Partial<CellObservation>
  return typeof candidate.verdict === 'string' && typeof candidate.readings === 'object' && candidate.readings !== null
}

/** Whether a settlement source reports rain now: any source at or above the trigger, or rain at the airport. */
function reportsRain(observed: ReadingsBySource | CellObservation | undefined, threshold: number): boolean {
  if (!observed) return false
  if (isCellObservation(observed) && observed.verdict === 'wet') return true
  const readings = isCellObservation(observed) ? observed.readings : observed
  for (const source of Object.keys(readings).sort()) {
    const value = readings[source]?.mmPerHour
    if (typeof value !== 'number' || !Number.isFinite(value)) continue
    if (value >= threshold) return true
    if (source === METAR_SOURCE_ID && value >= METAR_NOMINAL_MM_PER_HOUR.light) return true
  }
  return false
}

/**
 * Prices a window of cover from the same sources that settle it:
 *
 *   premium = rate x sum over slots of P(wet) x seconds x (1 + load)
 *
 * The window is cut along the forecast's 15-minute grid. For each slot every model gives an estimate: within
 * the nowcast horizon its 15-minute intensity relative to the trigger, beyond it its hourly amount, and in both
 * cases never less than its hourly chance of rain, so a dry nowcast with rain likely within the hour does not
 * make cover cheap. The slot takes the wettest model's estimate, not an average: a buyer who watches the
 * sources cannot find a moment where one of them points to rain and the price does not. Every slot is priced at
 * the floor or above. While a settlement source already reports rain (`observed`), slots that start within the
 * observation window are priced at the observation floor or above.
 */
export function quotePremium(input: QuotePremiumInput): PremiumQuote {
  const { start, end, ratePerSecond, forecast, now } = input
  const loadBps = input.loadBps ?? PRICING_DEFAULTS.loadBps
  const floorBps = input.floorBps ?? PRICING_DEFAULTS.floorBps
  const threshold = input.thresholdMmPerHour ?? PRICING_DEFAULTS.thresholdMmPerHour
  const horizon = input.nowcastHorizonSeconds ?? PRICING_DEFAULTS.nowcastHorizonSeconds
  const observedWetBps = input.observedWetBps ?? PRICING_DEFAULTS.observedWetBps
  const observationWindow = input.observationWindowSeconds ?? PRICING_DEFAULTS.observationWindowSeconds

  if (!Number.isInteger(start) || !Number.isInteger(end) || start % MINUTE_SECONDS !== 0 || end % MINUTE_SECONDS !== 0) {
    throw new RangeError('the window must start and end on a full minute')
  }
  if (end <= start) throw new RangeError('the window must end after it starts')
  if (ratePerSecond <= 0n) throw new RangeError('the rate must be positive')
  if (loadBps < 0 || floorBps < 0 || floorBps > BPS || threshold <= 0) throw new RangeError('invalid pricing parameters')
  if (observedWetBps < 0 || observedWetBps > BPS || observationWindow < 0) throw new RangeError('invalid pricing parameters')

  const models = modelsOf(forecast)
  const floorPpm = floorBps * (PPM / BPS)
  const observedPpm = reportsRain(input.observed, threshold) ? observedWetBps * (PPM / BPS) : 0

  const slots: PriceSlot[] = []
  let weightedPpmSeconds = 0
  for (let slotStart = start; slotStart < end; ) {
    const gridEnd = Math.floor(slotStart / SLOT_SECONDS) * SLOT_SECONDS + SLOT_SECONDS
    const slotEnd = Math.min(gridEnd, end)
    const seconds = slotEnd - slotStart

    // Forecast values describe the interval that ends at their timestamp.
    const nearTerm = slotStart - now < horizon
    const hourEnd = Math.floor(slotStart / HOUR_SECONDS) * HOUR_SECONDS + HOUR_SECONDS
    let wettest: Estimate | null = null
    for (const model of models) {
      const candidate = estimate(model, gridEnd, hourEnd, nearTerm, threshold)
      if (candidate !== null && (wettest === null || candidate.ppm > wettest.ppm)) wettest = candidate
    }
    if (wettest === null) throw new ForecastUnavailableError(slotStart, slotEnd)

    let ppm = wettest.ppm
    let basis: PriceSlot['basis'] = wettest.basis
    let observationFloor = false
    if (slotStart - now < observationWindow && ppm < observedPpm) {
      ppm = observedPpm
      observationFloor = true
    }
    if (ppm <= floorPpm) {
      ppm = floorPpm
      basis = 'floor'
    }

    weightedPpmSeconds += ppm * seconds
    slots.push({
      start: slotStart,
      end: slotEnd,
      seconds,
      forecastMmPerHour: wettest.forecastMmPerHour,
      precipitationProbability: wettest.precipitationProbability,
      probabilityWet: ppm / PPM,
      basis,
      model: wettest.model,
      observationFloor,
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
    models: models.map((model) => model.model),
  }
}
