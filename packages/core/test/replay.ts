import type { CellTarget, FetchLike, WeatherProvider } from '../src/weather/types'
import forecastFixture from './fixtures/forecast.json'
import weatherFixture from './fixtures/weather.json'

/**
 * Replays the recorded snapshot of the weather sources (`fixtures/weather.json`, one call to each real endpoint)
 * as if the sources were live: it answers any subset of the recorded cells the way the real endpoints would.
 */

type Exchange = { provider: string; url: string; status: number; bytes: number; body: unknown }
type Station = { icaoId: string; lat: number; lon: number }

const exchanges = weatherFixture.exchanges as Exchange[]

/** Unix seconds at which the snapshot was taken. Use it as "now" when reading the snapshot. */
export const recordedAt: number = weatherFixture.recordedAt

export const recordedCells: (CellTarget & { name: string })[] = weatherFixture.cells.map((cell) => ({
  name: cell.name,
  key: BigInt(cell.key),
  lat: cell.lat,
  lon: cell.lon,
}))

/** A recorded cell by name, e.g. `warsaw`, `sumburgh`, `manchester`, `warsaw-block-0-0`. */
export function recordedCell(name: string): CellTarget {
  const cell = recordedCells.find((candidate) => candidate.name === name)
  if (!cell) throw new Error(`no recorded cell named ${name}`)
  return { key: cell.key, lat: cell.lat, lon: cell.lon }
}

export const recordedForecasts = forecastFixture.forecasts.map((forecast) => ({
  name: forecast.name,
  key: BigInt(forecast.key),
  lat: forecast.lat,
  lon: forecast.lon,
  url: forecast.url,
  body: JSON.stringify(forecast.body),
}))

const param = (url: string, name: string) => new RegExp(`[?&]${name}=([^&]*)`).exec(url)?.[1] ?? ''

function openMeteo(url: string): { status: number; body: string } {
  const recorded = exchanges.find((exchange) => exchange.provider === 'open-meteo')
  if (!recorded) return { status: 404, body: '' }
  const coordinates = (source: string) => {
    const lats = param(source, 'latitude').split(',')
    const lons = param(source, 'longitude').split(',')
    return lats.map((lat, i) => `${lat},${lons[i]}`)
  }
  const known = coordinates(recorded.url)
  const locations = recorded.body as unknown[]
  const answer = []
  for (const coordinate of coordinates(url)) {
    const index = known.indexOf(coordinate)
    if (index < 0) return { status: 400, body: JSON.stringify({ error: true, reason: `not recorded: ${coordinate}` }) }
    answer.push(locations[index])
  }
  return { status: 200, body: JSON.stringify(answer.length === 1 ? answer[0] : answer) }
}

function metar(url: string): { status: number; body: string } {
  const [south, west, north, east] = param(url, 'bbox').split(',').map(Number) as [number, number, number, number]
  const stations = new Map<string, Station>()
  for (const exchange of exchanges) {
    if (exchange.provider !== 'metar' || !Array.isArray(exchange.body)) continue
    for (const station of exchange.body as Station[]) {
      if (station.lat >= south && station.lat <= north && station.lon >= west && station.lon <= east) {
        stations.set(station.icaoId, station)
      }
    }
  }
  return stations.size === 0 ? { status: 204, body: '' } : { status: 200, body: JSON.stringify([...stations.values()]) }
}

function metNorway(url: string): { status: number; body: string } {
  const recorded = exchanges.find((exchange) => exchange.provider === 'met-norway' && exchange.url === url)
  return recorded ? { status: 200, body: JSON.stringify(recorded.body) } : { status: 404, body: '' }
}

const providerOf = (url: string): WeatherProvider | 'forecast' | null => {
  if (url.startsWith('https://api.open-meteo.com/')) return url.includes('hourly=') ? 'forecast' : 'open-meteo'
  if (url.startsWith('https://aviationweather.gov/')) return 'metar'
  if (url.startsWith('https://api.met.no/')) return 'met-norway'
  return null
}

export type ReplayOptions = {
  /** Sources that answer with `status` instead of their recorded data. */
  down?: readonly WeatherProvider[]
  /** Status the sources listed in `down` answer with. Defaults to 503. */
  status?: number
  /** Sources whose requests fail without an answer. */
  unreachable?: readonly WeatherProvider[]
  /** Every requested URL is appended here. */
  calls?: string[]
}

/** Answers one GET the way the recorded sources did. Returns null for a request that never completes. */
export function replay(url: string, options: ReplayOptions = {}): { status: number; body: string } | null {
  options.calls?.push(url)
  const provider = providerOf(url)
  if (provider === null) return { status: 404, body: '' }
  if (provider === 'forecast') {
    const forecast = recordedForecasts.find((candidate) => candidate.url === url)
    return forecast ? { status: 200, body: forecast.body } : { status: 400, body: '' }
  }
  if (options.unreachable?.includes(provider)) return null
  if (options.down?.includes(provider)) return { status: options.status ?? 503, body: 'service unavailable' }
  if (provider === 'open-meteo') return openMeteo(url)
  if (provider === 'metar') return metar(url)
  return metNorway(url)
}

/** A `fetch` backed by the recorded snapshot. */
export function replayFetch(options: ReplayOptions = {}): FetchLike {
  return async (url) => {
    const answer = replay(url, options)
    if (answer === null) throw new TypeError('fetch failed')
    return { status: answer.status, text: async () => answer.body }
  }
}
