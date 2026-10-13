import { type CellTarget, NO_READING, type ReadingsBySource, type SourceId, type WeatherRequest } from './types'

/**
 * Forecast models read through Open-Meteo. Each is run by a different weather service and all three cover the
 * globe (the regional high-resolution runs are used where they exist), so they count as separate sources.
 */
export const OPEN_METEO_MODELS = ['icon_seamless', 'gfs_seamless', 'meteofrance_seamless'] as const

/** Locations per request. A response is about 0.5 KB per location with three models. */
export const OPEN_METEO_MAX_LOCATIONS = 200

const BASE_URL = 'https://api.open-meteo.com/v1/forecast'
const STEP_SECONDS = 900
const DEFAULT_MAX_AGE_SECONDS = 60 * 60

export const openMeteoSourceId = (model: string): SourceId => `open-meteo:${model}`

const coordinate = (value: number) => value.toFixed(3)

/**
 * One request for the latest 15-minute precipitation of every cell from every model. With several locations the
 * API answers with an array in the order of the coordinates.
 */
export function openMeteoRequest(cells: readonly CellTarget[], models: readonly string[] = OPEN_METEO_MODELS): WeatherRequest {
  const query = [
    `latitude=${cells.map((cell) => coordinate(cell.lat)).join(',')}`,
    `longitude=${cells.map((cell) => coordinate(cell.lon)).join(',')}`,
    'minutely_15=precipitation',
    `models=${models.join(',')}`,
    'past_minutely_15=1',
    'forecast_minutely_15=1',
    'timeformat=unixtime',
    'timezone=UTC',
  ].join('&')
  return { provider: 'open-meteo', url: `${BASE_URL}?${query}`, headers: {}, keys: cells.map((cell) => cell.key) }
}

type Minutely15 = { time?: unknown } & Record<string, unknown>

/**
 * Reads the newest step that has already ended. A step is the precipitation of the 15 minutes before its
 * timestamp, so the intensity is four times the value. A model that has no data for a location, or whose
 * newest step is older than `maxAgeSeconds`, gives no reading.
 */
export function parseOpenMeteo(
  body: string,
  cells: readonly CellTarget[],
  models: readonly string[],
  now: number,
  maxAgeSeconds: number = DEFAULT_MAX_AGE_SECONDS,
): Map<bigint, ReadingsBySource> {
  const parsed: unknown = JSON.parse(body)
  const locations = Array.isArray(parsed) ? parsed : [parsed]
  if (locations.length !== cells.length) {
    throw new Error(`open-meteo answered for ${locations.length} locations, expected ${cells.length}`)
  }

  const result = new Map<bigint, ReadingsBySource>()
  cells.forEach((cell, index) => {
    const series = (locations[index] as { minutely_15?: Minutely15 } | null)?.minutely_15
    const times = Array.isArray(series?.time) ? (series.time as unknown[]) : []
    const readings: ReadingsBySource = {}
    for (const model of models) {
      const column = series?.[`precipitation_${model}`] ?? (models.length === 1 ? series?.precipitation : undefined)
      readings[openMeteoSourceId(model)] = latestStep(times, column, now, maxAgeSeconds)
    }
    result.set(cell.key, readings)
  })
  return result
}

function latestStep(times: unknown[], column: unknown, now: number, maxAgeSeconds: number) {
  if (!Array.isArray(column)) return NO_READING
  for (let i = times.length - 1; i >= 0; i--) {
    const time = times[i]
    const value = column[i]
    if (typeof time !== 'number' || time > now) continue
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) continue
    if (now - time > maxAgeSeconds) return NO_READING
    return { mmPerHour: roundIntensity(value * (3600 / STEP_SECONDS)), observedAt: time }
  }
  return NO_READING
}

const roundIntensity = (mmPerHour: number) => Math.round(mmPerHour * 1000) / 1000
