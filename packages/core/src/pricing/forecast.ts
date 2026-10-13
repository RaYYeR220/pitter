import type { FetchLike } from '../weather/types'

const BASE_URL = 'https://api.open-meteo.com/v1/forecast'

/** Hours of forecast requested: the longest window (12 h) plus generous lead time. */
export const FORECAST_HOURS = 26

/**
 * Precipitation forecast for one cell.
 *
 * Every value describes the interval that ends at its timestamp: `minutely15.precipitation[i]` is the
 * millimetres expected in the 15 minutes before `minutely15.time[i]`, and `hourly.precipitationProbability[i]`
 * is the chance in percent of more than 0.1 mm in the hour before `hourly.time[i]`.
 */
export type Forecast = {
  minutely15: { time: number[]; precipitation: (number | null)[] }
  hourly: { time: number[]; precipitationProbability: (number | null)[] }
}

export function forecastRequest(cell: { lat: number; lon: number }): { url: string; headers: Record<string, string> } {
  const query = [
    `latitude=${cell.lat.toFixed(3)}`,
    `longitude=${cell.lon.toFixed(3)}`,
    'minutely_15=precipitation',
    'hourly=precipitation_probability',
    `forecast_minutely_15=${FORECAST_HOURS * 4}`,
    `forecast_hours=${FORECAST_HOURS}`,
    'timeformat=unixtime',
    'timezone=UTC',
  ].join('&')
  return { url: `${BASE_URL}?${query}`, headers: {} }
}

const numbers = (values: unknown): number[] =>
  Array.isArray(values) ? values.filter((value): value is number => typeof value === 'number') : []

const numbersOrNull = (values: unknown, length: number): (number | null)[] => {
  const list = Array.isArray(values) ? values : []
  return Array.from({ length }, (_, i) => {
    const value = list[i]
    return typeof value === 'number' && Number.isFinite(value) ? value : null
  })
}

export function parseForecast(body: string): Forecast {
  const parsed = JSON.parse(body) as {
    minutely_15?: { time?: unknown; precipitation?: unknown }
    hourly?: { time?: unknown; precipitation_probability?: unknown }
  } | null
  const minutelyTime = numbers(parsed?.minutely_15?.time)
  const hourlyTime = numbers(parsed?.hourly?.time)
  if (minutelyTime.length === 0 && hourlyTime.length === 0) throw new Error('forecast has no time steps')
  return {
    minutely15: {
      time: minutelyTime,
      precipitation: numbersOrNull(parsed?.minutely_15?.precipitation, minutelyTime.length),
    },
    hourly: {
      time: hourlyTime,
      precipitationProbability: numbersOrNull(parsed?.hourly?.precipitation_probability, hourlyTime.length),
    },
  }
}

/** Fetches the forecast for a cell. Throws when the source refuses or returns something unreadable. */
export async function fetchForecast(cell: { lat: number; lon: number }, fetch: FetchLike): Promise<Forecast> {
  const request = forecastRequest(cell)
  const response = await fetch(request.url, { method: 'GET', headers: request.headers })
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`forecast request failed with status ${response.status}`)
  }
  return parseForecast(await response.text())
}
