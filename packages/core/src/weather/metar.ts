import { degreesForKm, distanceKm } from './geo'
import { type CellTarget, NO_READING, type SourceId, type SourceReading, type WeatherRequest } from './types'

export const METAR_SOURCE_ID: SourceId = 'metar'

/** A cell uses the nearest reporting station within this distance of its centre. */
export const METAR_MAX_DISTANCE_KM = 40

/** Stations report every 30 or 60 minutes; an observation older than this no longer describes the cell. */
export const METAR_MAX_AGE_SECONDS = 90 * 60

/**
 * A METAR states that it rains and how hard in three steps, not a rate. These are the rates the oracle assigns
 * to each step so that an observation can be combined with the forecast models: light rain counts as just above
 * the 1.0 mm/h trigger, drizzle and rain in the vicinity as below it.
 */
export const METAR_NOMINAL_MM_PER_HOUR = { drizzle: 0.3, light: 1.2, moderate: 5, heavy: 10 } as const

const BASE_URL = 'https://aviationweather.gov/api/data/metar'
const MAX_SPAN_LAT_DEGREES = 6
const MAX_SPAN_LON_DEGREES = 10

export type MetarArea = {
  south: number
  west: number
  north: number
  east: number
  cells: CellTarget[]
}

/**
 * Groups cells into areas small enough for one request each. The API has no "nearest station" query, so the
 * oracle asks for every station in a box around the cells and picks the nearest per cell from the answer.
 */
export function metarAreas(cells: readonly CellTarget[], radiusKm: number = METAR_MAX_DISTANCE_KM): MetarArea[] {
  const areas: MetarArea[] = []
  const ordered = [...cells].sort((a, b) => a.lon - b.lon || a.lat - b.lat || (a.key < b.key ? -1 : 1))
  for (const cell of ordered) {
    const margin = degreesForKm(radiusKm, cell.lat)
    const box = {
      south: Math.max(cell.lat - margin.lat, -90),
      north: Math.min(cell.lat + margin.lat, 90),
      west: Math.max(cell.lon - margin.lon, -180),
      east: Math.min(cell.lon + margin.lon, 180),
    }
    const home = areas.find(
      (area) =>
        Math.max(area.north, box.north) - Math.min(area.south, box.south) <= MAX_SPAN_LAT_DEGREES &&
        Math.max(area.east, box.east) - Math.min(area.west, box.west) <= MAX_SPAN_LON_DEGREES,
    )
    if (home) {
      home.south = Math.min(home.south, box.south)
      home.north = Math.max(home.north, box.north)
      home.west = Math.min(home.west, box.west)
      home.east = Math.max(home.east, box.east)
      home.cells.push(cell)
    } else {
      areas.push({ ...box, cells: [cell] })
    }
  }
  return areas
}

export function metarRequest(area: MetarArea, userAgent: string): WeatherRequest {
  const bbox = [
    Math.floor(area.south * 100) / 100,
    Math.floor(area.west * 100) / 100,
    Math.ceil(area.north * 100) / 100,
    Math.ceil(area.east * 100) / 100,
  ]
    .map((value) => value.toFixed(2))
    .join(',')
  return {
    provider: 'metar',
    url: `${BASE_URL}?bbox=${bbox}&format=json`,
    headers: { 'User-Agent': userAgent },
    keys: area.cells.map((cell) => cell.key),
  }
}

const INTENSITY = /^(\+|-|VC)?/
const DESCRIPTORS = ['MI', 'PR', 'BC', 'DR', 'BL', 'SH', 'TS', 'FZ']

/** Splits one present-weather group such as `-SHRA` or `RADZ` into its two-letter codes. */
function weatherCodes(group: string): { prefix: string; codes: string[] } {
  const prefix = INTENSITY.exec(group)?.[1] ?? ''
  const letters = group.slice(prefix.length)
  const codes: string[] = []
  for (let i = 0; i + 2 <= letters.length; i += 2) codes.push(letters.slice(i, i + 2))
  return { prefix, codes: codes.filter((code) => !DESCRIPTORS.includes(code)) }
}

/**
 * The rain rate implied by a METAR present-weather string. Rain (`RA`, with any descriptor) maps to the
 * nominal rate of its intensity; drizzle alone stays below the trigger; rain in the vicinity (`VC`), recent rain
 * (`RE`), snow and an absent string are no rain.
 */
export function rainRateFromWeather(wxString: string | null | undefined): number {
  if (!wxString) return 0
  let rate = 0
  for (const raw of wxString.trim().split(/\s+/)) {
    const group = raw.toUpperCase()
    if (group.length >= 4 && group.startsWith('RE')) continue
    const { prefix, codes } = weatherCodes(group)
    if (prefix === 'VC') continue
    if (codes.includes('RA')) {
      const nominal =
        prefix === '+'
          ? METAR_NOMINAL_MM_PER_HOUR.heavy
          : prefix === '-'
            ? METAR_NOMINAL_MM_PER_HOUR.light
            : METAR_NOMINAL_MM_PER_HOUR.moderate
      rate = Math.max(rate, nominal)
    } else if (codes.includes('DZ')) {
      rate = Math.max(rate, METAR_NOMINAL_MM_PER_HOUR.drizzle)
    }
  }
  return rate
}

type Station = { icaoId: string; lat: number; lon: number; obsTime: number; wxString?: string | null }

function isStation(value: unknown): value is Station {
  const station = value as Partial<Station> | null
  return (
    typeof station === 'object' &&
    station !== null &&
    typeof station.icaoId === 'string' &&
    typeof station.lat === 'number' &&
    typeof station.lon === 'number' &&
    typeof station.obsTime === 'number'
  )
}

export type MetarReading = SourceReading & { station: string | null; distanceKm: number | null }

/**
 * For every cell, the reading of the nearest station that reported within `maxAgeSeconds` and lies within
 * `radiusKm`. A cell without such a station gets no reading. An empty body means no station reported.
 */
export function parseMetar(
  body: string,
  cells: readonly CellTarget[],
  now: number,
  radiusKm: number = METAR_MAX_DISTANCE_KM,
  maxAgeSeconds: number = METAR_MAX_AGE_SECONDS,
): Map<bigint, MetarReading> {
  const parsed: unknown = body.trim() === '' ? [] : JSON.parse(body)
  if (!Array.isArray(parsed)) throw new Error('metar answer is not a list of stations')

  const latest = new Map<string, Station>()
  for (const entry of parsed) {
    if (!isStation(entry)) continue
    if (entry.obsTime > now + 600 || now - entry.obsTime > maxAgeSeconds) continue
    const known = latest.get(entry.icaoId)
    if (!known || entry.obsTime > known.obsTime) latest.set(entry.icaoId, entry)
  }

  const result = new Map<bigint, MetarReading>()
  for (const cell of cells) {
    let nearest: Station | null = null
    let nearestKm = Number.POSITIVE_INFINITY
    for (const station of latest.values()) {
      const km = distanceKm(cell.lat, cell.lon, station.lat, station.lon)
      if (km <= radiusKm && (km < nearestKm || (km === nearestKm && nearest !== null && station.icaoId < nearest.icaoId))) {
        nearest = station
        nearestKm = km
      }
    }
    result.set(
      cell.key,
      nearest
        ? {
            mmPerHour: rainRateFromWeather(nearest.wxString),
            observedAt: nearest.obsTime,
            station: nearest.icaoId,
            distanceKm: Math.round(nearestKm * 10) / 10,
          }
        : { ...NO_READING, station: null, distanceKm: null },
    )
  }
  return result
}
