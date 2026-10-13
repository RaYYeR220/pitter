import { coverBookAbi, coverPoolAbi, testDollarAbi, weatherIndexAbi } from '@cover/core/abi'
import { cellFromKey, keyFromLatLon } from '@cover/core/cells'
import { hashQuote, hashReport, quoteDomain, reportDomain } from '@cover/core/eip712'
import { fetchForecast, quotePremium, type Forecast } from '@cover/core/pricing'
import {
  aggregateAll,
  buildReport,
  encodeReport,
  fetchObservations,
  targetsFromKeys,
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
}

const MAX_CACHED_FORECASTS = 512

/**
 * Prices from the forecast at the centre of the cell, so every holder in a cell is quoted from the same
 * data. Forecasts are kept briefly: quotes arrive in bursts and the forecast changes every fifteen minutes.
 */
export function corePricing(options: CoreOptions): Pricing {
  const ttl = options.forecastTtlSeconds ?? 120
  const cache = new Map<bigint, { at: number; forecast: Promise<Forecast> }>()

  function forecastFor(key: bigint, now: number): Promise<Forecast> {
    const cached = cache.get(key)
    if (cached && now - cached.at < ttl) return cached.forecast

    const forecast = fetchForecast(cellFromKey(key), options.fetch)
    forecast.catch(() => {
      if (cache.get(key)?.forecast === forecast) cache.delete(key)
    })
    if (cache.size >= MAX_CACHED_FORECASTS) cache.clear()
    cache.set(key, { at: now, forecast })
    return forecast
  }

  return {
    async price({ key, start, end, ratePerSecond, now }) {
      const forecast = await forecastFor(key, now)
      const { premium, expectedPayout, expectedWetSeconds, loadBps, floorBps, slots } = quotePremium({
        cell: { key },
        start,
        end,
        ratePerSecond,
        forecast,
        now,
      })
      return { premium, inputs: { expectedPayout, expectedWetSeconds, loadBps, floorBps, slots } }
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
