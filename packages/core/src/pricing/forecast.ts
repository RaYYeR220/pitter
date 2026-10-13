import { OPEN_METEO_MODELS } from '../weather/openMeteo'
import type { FetchLike } from '../weather/types'

const BASE_URL = 'https://api.open-meteo.com/v1/forecast'

/** Hours of forecast requested: the longest window (12 h) plus generous lead time. */
export const FORECAST_HOURS = 26

/** The models the price is taken from: the same ones the oracle reads to settle. */
export const FORECAST_MODELS: readonly string[] = OPEN_METEO_MODELS

/**
 * What one forecast model expects for one cell. Every value describes the interval that ends at its
 * timestamp, as in `Forecast`. `hourly.precipitation` is the millimetres expected in the hour.
 */
export type ModelForecast = {
  /** Open-Meteo model name, for example `icon_seamless`. */
  model: string
  minutely15: { time: number[]; precipitation: (number | null)[] }
  hourly: { time: number[]; precipitationProbability: (number | null)[]; precipitation: (number | null)[] }
}

/**
 * Precipitation forecast for one cell.
 *
 * Every value describes the interval that ends at its timestamp: `minutely15.precipitation[i]` is the
 * millimetres expected in the 15 minutes before `minutely15.time[i]`, and `hourly.precipitationProbability[i]`
 * is the chance in percent of more than 0.1 mm in the hour before `hourly.time[i]`.
 *
 * A forecast fetched with `fetchForecast` carries one entry per model in `models`, and its top-level series
 * hold, per step, the wettest value any model gave. A forecast without `models` is priced from its top-level
 * series as a single model.
 */
export type Forecast = {
  minutely15: { time: number[]; precipitation: (number | null)[] }
  hourly: { time: number[]; precipitationProbability: (number | null)[]; precipitation?: (number | null)[] }
  /** The forecast of each model that answered, in the order they were asked for. */
  models?: ModelForecast[]
}

/** Asks for the 15-minute and hourly forecast of every model the oracle settles from, in one request. */
export function forecastRequest(cell: { lat: number; lon: number }): { url: string; headers: Record<string, string> } {
  const query = [
    `latitude=${cell.lat.toFixed(3)}`,
    `longitude=${cell.lon.toFixed(3)}`,
    'minutely_15=precipitation',
    'hourly=precipitation_probability,precipitation',
    `models=${FORECAST_MODELS.join(',')}`,
    `forecast_minutely_15=${FORECAST_HOURS * 4}`,
    `forecast_hours=${FORECAST_HOURS}`,
    'timeformat=unixtime',
    'timezone=UTC',
  ].join('&')
  return { url: `${BASE_URL}?${query}`, headers: {} }
}

type Series = Record<string, unknown>

const numbers = (values: unknown): number[] =>
  Array.isArray(values) ? values.filter((value): value is number => typeof value === 'number') : []

const numbersOrNull = (values: unknown, length: number): (number | null)[] => {
  const list = Array.isArray(values) ? values : []
  return Array.from({ length }, (_, i) => {
    const value = list[i]
    return typeof value === 'number' && Number.isFinite(value) ? value : null
  })
}

const hasValue = (values: readonly (number | null)[]) => values.some((value) => value !== null)

/** The wettest value per step, or null where no model has one. */
const wettest = (series: readonly (readonly (number | null)[])[], length: number): (number | null)[] =>
  Array.from({ length }, (_, i) => {
    let max: number | null = null
    for (const values of series) {
      const value = values[i] ?? null
      if (value !== null && (max === null || value > max)) max = value
    }
    return max
  })

/** Model names in the answer, from keys such as `precipitation_icon_seamless`, in the order they appear. */
function modelNames(minutely: Series, hourly: Series): string[] {
  const names: string[] = []
  for (const key of [...Object.keys(minutely), ...Object.keys(hourly)]) {
    const name = /^precipitation_(?:probability_)?(.+)$/.exec(key)?.[1]
    if (name && name !== 'probability' && !names.includes(name)) names.push(name)
  }
  return names
}

/**
 * Reads a forecast answer. An answer for several models (keys suffixed with the model name) yields one
 * `ModelForecast` per model that has any value; an answer for the default model yields a forecast without
 * `models`.
 */
export function parseForecast(body: string): Forecast {
  const parsed = JSON.parse(body) as { minutely_15?: Series; hourly?: Series } | null
  const minutely: Series = parsed?.minutely_15 ?? {}
  const hourly: Series = parsed?.hourly ?? {}
  const minutelyTime = numbers(minutely.time)
  const hourlyTime = numbers(hourly.time)
  if (minutelyTime.length === 0 && hourlyTime.length === 0) throw new Error('forecast has no time steps')

  const names = modelNames(minutely, hourly)
  if (names.length === 0) {
    const forecast: Forecast = {
      minutely15: { time: minutelyTime, precipitation: numbersOrNull(minutely.precipitation, minutelyTime.length) },
      hourly: {
        time: hourlyTime,
        precipitationProbability: numbersOrNull(hourly.precipitation_probability, hourlyTime.length),
      },
    }
    if (Array.isArray(hourly.precipitation)) {
      forecast.hourly.precipitation = numbersOrNull(hourly.precipitation, hourlyTime.length)
    }
    return forecast
  }

  const models: ModelForecast[] = []
  for (const model of names) {
    const forecast: ModelForecast = {
      model,
      minutely15: { time: minutelyTime, precipitation: numbersOrNull(minutely[`precipitation_${model}`], minutelyTime.length) },
      hourly: {
        time: hourlyTime,
        precipitationProbability: numbersOrNull(hourly[`precipitation_probability_${model}`], hourlyTime.length),
        precipitation: numbersOrNull(hourly[`precipitation_${model}`], hourlyTime.length),
      },
    }
    // A model without a single value did not answer for this place.
    const answered =
      hasValue(forecast.minutely15.precipitation) ||
      hasValue(forecast.hourly.precipitationProbability) ||
      hasValue(forecast.hourly.precipitation)
    if (answered) models.push(forecast)
  }

  return {
    minutely15: {
      time: minutelyTime,
      precipitation: wettest(
        models.map((model) => model.minutely15.precipitation),
        minutelyTime.length,
      ),
    },
    hourly: {
      time: hourlyTime,
      precipitationProbability: wettest(
        models.map((model) => model.hourly.precipitationProbability),
        hourlyTime.length,
      ),
      precipitation: wettest(
        models.map((model) => model.hourly.precipitation),
        hourlyTime.length,
      ),
    },
    models,
  }
}

/** Fetches the forecast for a cell. Throws when the source refuses or returns something unreadable. */
export async function fetchForecast(cell: { lat: number; lon: number }, fetcher: FetchLike): Promise<Forecast> {
  const request = forecastRequest(cell)
  const response = await fetcher(request.url, { method: 'GET', headers: request.headers })
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`forecast request failed with status ${response.status}`)
  }
  return parseForecast(await response.text())
}
