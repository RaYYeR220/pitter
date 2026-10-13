import { coverBookAbi, coverPoolAbi, testDollarAbi, weatherIndexAbi } from '@cover/core/abi'
import { cellFromKey, keyFromLatLon } from '@cover/core/cells'
import { hashQuote, hashReport, quoteDomain, reportDomain } from '@cover/core/eip712'
import { fetchForecast, quotePremium, type Forecast } from '@cover/core/pricing'
import {
  MIN_SOURCES,
  aggregateAll,
  buildReport,
  encodeReport,
  fetchObservations,
  targetsFromKeys,
  type CellObservation,
  type FetchLike,
  type Verdict,
} from '@cover/core/weather'
import type { Abi } from 'viem'
import type { Cells, ContractAbis, CorePorts, Pricing, Signing, WeatherReporter } from '../ports'

/**
 * The test dollar's ABI covers everything the service calls on the dollar token; native USDC exposes the same
 * functions under the same selectors.
 */
export const coreAbis: ContractAbis = {
  coverBook: coverBookAbi as Abi,
  coverPool: coverPoolAbi as Abi,
  weatherIndex: weatherIndexAbi as Abi,
  token: testDollarAbi as Abi,
}

export const coreSigning: Signing = {
  quoteDigest: (quote, chainId, coverBook) => hashQuote(quote, quoteDomain(chainId, coverBook)),
  reportDigest: (readings, issuedAt, chainId, weatherIndex) =>
    hashReport(readings, issuedAt, reportDomain(chainId, weatherIndex)),
  encodeReport,
}

export const coreCells: Cells = {
  keyAt: (lat, lon) => keyFromLatLon(lat, lon),
  locate: (key) => {
    const { lat, lon } = cellFromKey(key)
    return { lat, lon }
  },
}

export interface CoreOptions {
  /** Used for every request to a weather or forecast source. */
  fetch: FetchLike
  /** Identifies the operator to the sources that ask for it. */
  userAgent: string
  /** How long a cell's forecast is reused before it is fetched again. */
  forecastTtlSeconds?: number
  /** How long a cell's current observation is reused before the weather sources are asked again. */
  observationTtlSeconds?: number
  /** How long to wait for the weather sources before treating the observation as unavailable. */
  observationTimeoutMs?: number
  /** How long to wait for the forecast before the quote is refused. */
  forecastTimeoutMs?: number
}

/** What the settlement sources said about a cell at quote time, as shown to the buyer. */
export interface ObservationSummary {
  /**
   * `live`: enough sources answered to judge the cell. `unavailable`: they did not, and the quote was priced
   * as if it might be raining now.
   */
  status: 'live' | 'unavailable'
  verdict: 'wet' | 'dry' | 'unknown'
  /** Sources that answered for the cell. */
  sources: number
  /** Unix seconds at which the sources were asked. */
  observedAt: number
}

/** The warning a quote carries when it was priced without current observations. */
export const OBSERVATIONS_UNAVAILABLE = 'observations_unavailable'

interface Observed {
  summary: ObservationSummary
  /** Passed to `quotePremium`. */
  input: CellObservation
}

const MAX_CACHED_CELLS = 512

/** A failed observation is kept only briefly, so the quote recovers soon after the sources do. */
const FAILED_OBSERVATION_TTL_SECONDS = 15

function withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not answer in time`)), ms)
  })
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer))
}

/** A short-lived cache of one value per cell that shares the request in flight. */
function cellCache<T>(capacity: number) {
  const entries = new Map<bigint, { expiresAt: number; value: Promise<T> }>()
  return {
    get(key: bigint, now: number, load: () => Promise<T>, ttl: (value: T) => number): Promise<T> {
      const cached = entries.get(key)
      if (cached && now < cached.expiresAt) return cached.value

      const value = load()
      const entry = { expiresAt: Number.POSITIVE_INFINITY, value }
      if (entries.size >= capacity) entries.clear()
      entries.set(key, entry)
      value.then(
        (resolved) => {
          entry.expiresAt = now + ttl(resolved)
        },
        () => {
          if (entries.get(key) === entry) entries.delete(key)
        },
      )
      return value
    },
  }
}

/**
 * Prices from the forecast at the centre of the cell and from what the settlement sources report there now,
 * so every holder in a cell is quoted from the same data.
 *
 * Both are kept briefly per cell: quotes arrive in bursts, and a burst must not fan out to the weather
 * providers. When the sources cannot be read, or too few of them answer to judge the cell, the quote is still
 * priced from the forecast, but as if it might be raining now: the slots of the next hour are lifted to the
 * observation floor, the inputs say so, and the quote carries the `observations_unavailable` warning. A
 * missing observation can make cover dearer, never cheaper.
 */
export function corePricing(options: CoreOptions): Pricing {
  const forecastTtl = options.forecastTtlSeconds ?? 120
  const observationTtl = options.observationTtlSeconds ?? 60
  const observationTimeout = options.observationTimeoutMs ?? 4_000
  const forecastTimeout = options.forecastTimeoutMs ?? 8_000
  const forecasts = cellCache<Forecast>(MAX_CACHED_CELLS)
  const observations = cellCache<Observed>(MAX_CACHED_CELLS)

  const possiblyWet = (key: bigint, sources: number, observedAt: number): Observed => ({
    summary: { status: 'unavailable', verdict: 'unknown', sources, observedAt },
    input: { key, verdict: 'wet', medianMmPerHour: null, answered: sources, readings: {} },
  })

  async function observe(key: bigint, now: number): Promise<Observed> {
    const cells = targetsFromKeys([key])
    if (cells.length === 0) return possiblyWet(key, 0, now)
    try {
      const { observations: readings } = await withTimeout(
        fetchObservations(cells, { fetch: options.fetch, userAgent: options.userAgent, now }),
        observationTimeout,
        'the weather sources',
      )
      const [observation] = aggregateAll(cells, readings)
      if (!observation || observation.answered < MIN_SOURCES) return possiblyWet(key, observation?.answered ?? 0, now)
      return {
        summary: { status: 'live', verdict: observation.verdict, sources: observation.answered, observedAt: now },
        input: observation,
      }
    } catch {
      return possiblyWet(key, 0, now)
    }
  }

  return {
    async price({ key, start, end, ratePerSecond, now }) {
      const [forecast, observed] = await Promise.all([
        forecasts.get(
          key,
          now,
          () => withTimeout(fetchForecast(cellFromKey(key), options.fetch), forecastTimeout, 'the forecast'),
          () => forecastTtl,
        ),
        observations.get(
          key,
          now,
          () => observe(key, now),
          (result) =>
            result.summary.status === 'live'
              ? observationTtl
              : Math.min(observationTtl, FAILED_OBSERVATION_TTL_SECONDS),
        ),
      ])
      const { premium, expectedPayout, expectedWetSeconds, loadBps, floorBps, models, slots } = quotePremium({
        cell: { key },
        start,
        end,
        ratePerSecond,
        forecast,
        now,
        observed: observed.input,
      })
      return {
        premium,
        inputs: {
          expectedPayout,
          expectedWetSeconds,
          loadBps,
          floorBps,
          models: models ?? [],
          observation: observed.summary,
          slots: slots.map((slot) => ({
            ...slot,
            model: slot.model ?? null,
            observationFloor: slot.observationFloor ?? false,
          })),
        },
        warnings: observed.summary.status === 'live' ? [] : [OBSERVATIONS_UNAVAILABLE],
      }
    },
  }
}

/** Observes cells through the shared weather module, the same one the oracle workflow runs. */
export function coreWeather(options: CoreOptions): WeatherReporter {
  return {
    async observe(keys, now) {
      const cells = targetsFromKeys(keys)
      const verdicts = new Map<bigint, boolean>()
      if (cells.length === 0) return verdicts

      const { observations } = await fetchObservations(cells, {
        fetch: options.fetch,
        userAgent: options.userAgent,
        now,
      })
      for (const observation of aggregateAll(cells, observations)) {
        if (observation.verdict !== 'unknown') verdicts.set(observation.key, observation.verdict === 'wet')
      }
      return verdicts
    },

    buildReadings({ verdicts, lastTo, now, firstReadingSeconds }) {
      const observations = new Map<bigint, Verdict>([...verdicts].map(([key, wet]) => [key, wet ? 'wet' : 'dry']))
      const { reports } = buildReport([...verdicts.keys()], lastTo, now, {
        observations,
        intervalSeconds: firstReadingSeconds,
        maxReadings: Number.MAX_SAFE_INTEGER,
      })
      return reports.flatMap((report) => report.readings)
    },
  }
}

export function createCorePorts(options: CoreOptions): CorePorts {
  return {
    abis: coreAbis,
    signing: coreSigning,
    cells: coreCells,
    pricing: corePricing(options),
    weather: coreWeather(options),
  }
}
