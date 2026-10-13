import { type CellTarget, NO_READING, type SourceId, type SourceReading, type WeatherRequest } from './types'

export const MET_NORWAY_SOURCE_ID: SourceId = 'met-norway'

const BASE_URL = 'https://api.met.no/weatherapi/locationforecast/2.0/compact'
const DEFAULT_MAX_AGE_SECONDS = 2 * 60 * 60

/** MET Norway answers for one location per request and requires a User-Agent that identifies the caller. */
export function metNorwayRequest(cell: CellTarget, userAgent: string): WeatherRequest {
  return {
    provider: 'met-norway',
    url: `${BASE_URL}?lat=${cell.lat.toFixed(3)}&lon=${cell.lon.toFixed(3)}`,
    headers: { 'User-Agent': userAgent },
    keys: [cell.key],
  }
}

type TimeStep = {
  time?: unknown
  data?: { next_1_hours?: { details?: { precipitation_amount?: unknown } } }
}

/**
 * Reads the precipitation of the hour that contains `now`: the newest hourly step that has started. The value
 * is millimetres over that hour, which is already an intensity in mm/h.
 */
export function parseMetNorway(body: string, now: number, maxAgeSeconds: number = DEFAULT_MAX_AGE_SECONDS): SourceReading {
  const parsed = JSON.parse(body) as { properties?: { timeseries?: unknown } } | null
  const series = parsed?.properties?.timeseries
  if (!Array.isArray(series)) throw new Error('met-norway answer has no time series')

  let best: SourceReading = NO_READING
  for (const step of series as TimeStep[]) {
    const time = typeof step?.time === 'string' ? Math.floor(Date.parse(step.time) / 1000) : Number.NaN
    const amount = step?.data?.next_1_hours?.details?.precipitation_amount
    if (!Number.isFinite(time) || time > now || now - time > maxAgeSeconds) continue
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) continue
    if (best.observedAt === null || time > best.observedAt) best = { mmPerHour: amount, observedAt: time }
  }
  return best
}
