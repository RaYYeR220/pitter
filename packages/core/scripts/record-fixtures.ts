// Records one snapshot of the real weather sources for the unit tests:
//   WEATHER_USER_AGENT="<who you are and a contact>" pnpm --filter @cover/core record:fixtures
// The snapshot keeps the response shapes of the sources and drops what the oracle never reads.
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cellFromLatLon, keyFromCellId } from '../src/cells'
import { forecastRequest } from '../src/pricing/forecast'
import { distanceKm } from '../src/weather/geo'
import { planRequests } from '../src/weather/plan'
import type { CellTarget, WeatherRequest } from '../src/weather/types'

const userAgent = process.env.WEATHER_USER_AGENT
if (!userAgent) throw new Error('set WEATHER_USER_AGENT to a string that identifies you (MET Norway requires it)')

const here = dirname(fileURLToPath(import.meta.url))
const fixturesDir = join(here, '..', 'test', 'fixtures')

const PLACES: [name: string, lat: number, lon: number][] = [
  ['warsaw', 52.23, 21.01],
  ['sumburgh', 59.88, -1.296],
  ['manchester', 53.354, -2.275],
  ['shawbury', 52.795, -2.665],
  ['aberdeen', 57.205, -2.205],
  ['amsterdam', 52.315, 4.79],
  ['bergen', 60.39, 5.32],
  ['spadeadam', 55.05, -2.554],
  ['alpena', 45.0716, -83.5645],
  ['ho-chi-minh', 10.817, 106.667],
  ['moscow', 55.973, 37.415],
  ['sydney', -33.946, 151.173],
  ['mid-atlantic', 45.0, -30.0],
]

// A block of neighbouring cells around Warsaw, for tests that need more cells than one report holds.
const BLOCK = { name: 'warsaw-block', lat: 52.03, lon: 20.81, rows: 5, columns: 5 }

type NamedCell = CellTarget & { name: string }

function namedCell(name: string, lat: number, lon: number): NamedCell {
  const cell = cellFromLatLon(lat, lon)
  return { name, key: keyFromCellId(cell.id), lat: cell.lat, lon: cell.lon }
}

const cells: NamedCell[] = PLACES.map(([name, lat, lon]) => namedCell(name, lat, lon))
for (let row = 0; row < BLOCK.rows; row++) {
  for (let column = 0; column < BLOCK.columns; column++) {
    const cell = namedCell(`${BLOCK.name}-${row}-${column}`, BLOCK.lat + row * 0.05, BLOCK.lon + column * 0.05)
    if (!cells.some((known) => known.key === cell.key)) cells.push(cell)
  }
}

async function get(request: { url: string; headers: Record<string, string> }) {
  const response = await fetch(request.url, { headers: request.headers })
  const text = await response.text()
  console.log(`${response.status}  ${text.length.toString().padStart(7)} bytes  ${request.url.slice(0, 110)}`)
  return { status: response.status, text }
}

const json = (text: string): unknown => (text.trim() === '' ? [] : JSON.parse(text))

function trimMetar(body: unknown, request: WeatherRequest): unknown {
  if (!Array.isArray(body)) return body
  const targets = cells.filter((cell) => request.keys.includes(cell.key))
  return body
    .filter((station) => targets.some((cell) => distanceKm(cell.lat, cell.lon, station.lat, station.lon) <= 80))
    .map(({ icaoId, obsTime, lat, lon, wxString, rawOb, name }) => ({ icaoId, obsTime, lat, lon, wxString, rawOb, name }))
}

function trimMetNorway(body: unknown): unknown {
  const forecast = body as { type: unknown; geometry: unknown; properties: { meta: unknown; timeseries: unknown[] } }
  return {
    type: forecast.type,
    geometry: forecast.geometry,
    properties: { meta: forecast.properties.meta, timeseries: forecast.properties.timeseries.slice(0, 4) },
  }
}

const recordedAt = Math.floor(Date.now() / 1000)
const requests = planRequests(cells, { userAgent })
const exchanges = []
for (const request of requests) {
  const { status, text } = await get(request)
  let body = status >= 200 && status < 300 ? json(text) : text
  if (status === 200 && request.provider === 'metar') body = trimMetar(body, request)
  if (status === 200 && request.provider === 'met-norway') body = trimMetNorway(body)
  exchanges.push({ provider: request.provider, url: request.url, status, bytes: text.length, body })
}

mkdirSync(fixturesDir, { recursive: true })
writeFileSync(
  join(fixturesDir, 'weather.json'),
  `${JSON.stringify(
    {
      recordedAt,
      cells: cells.map((cell) => ({ name: cell.name, key: cell.key.toString(), lat: cell.lat, lon: cell.lon })),
      exchanges,
    },
    null,
    1,
  )}\n`,
)

const forecasts = []
for (const name of ['warsaw', 'sumburgh', 'manchester']) {
  const cell = cells.find((candidate) => candidate.name === name)
  if (!cell) continue
  const request = forecastRequest(cell)
  const { status, text } = await get(request)
  forecasts.push({ name, key: cell.key.toString(), lat: cell.lat, lon: cell.lon, url: request.url, status, bytes: text.length, body: json(text) })
}
writeFileSync(join(fixturesDir, 'forecast.json'), `${JSON.stringify({ recordedAt, forecasts }, null, 1)}\n`)
console.log(`recorded at ${recordedAt} (${new Date(recordedAt * 1000).toISOString()})`)
