import { RAIN_TRIGGER_ID, cellFromKey, triggerIdFromKey } from '../cells'
import { METAR_SOURCE_ID, metarAreas, metarRequest, parseMetar } from './metar'
import { MET_NORWAY_SOURCE_ID, metNorwayRequest, parseMetNorway } from './metNorway'
import {
  OPEN_METEO_MAX_LOCATIONS,
  OPEN_METEO_MODELS,
  openMeteoRequest,
  openMeteoSourceId,
  parseOpenMeteo,
} from './openMeteo'
import {
  type CellTarget,
  type FetchLike,
  type HttpResult,
  NO_READING,
  type Observations,
  type ReadingsBySource,
  type SourceId,
  type WeatherRequest,
} from './types'

/** Requests one oracle run may make. The Chainlink Runtime Environment allows 15 HTTP calls per execution. */
export const DEFAULT_MAX_REQUESTS = 15

export type PlanOptions = {
  /** Sent to the sources that ask callers to identify themselves. Name the operator and a contact. */
  userAgent: string
  maxRequests?: number
  models?: readonly string[]
}

/**
 * The cells behind a list of index keys, in the order given. Keys of other triggers and keys that are not on
 * the grid are left out: the oracle has nothing to say about them.
 */
export function targetsFromKeys(keys: readonly bigint[]): CellTarget[] {
  const targets: CellTarget[] = []
  const seen = new Set<bigint>()
  for (const key of keys) {
    if (seen.has(key) || triggerIdFromKey(key) !== RAIN_TRIGGER_ID) continue
    seen.add(key)
    try {
      const cell = cellFromKey(key)
      targets.push({ key, lat: cell.lat, lon: cell.lon })
    } catch {
      // not a cell of the grid
    }
  }
  return targets
}

/**
 * Decides which requests to make for `cells` without exceeding `maxRequests`:
 * first the forecast models (every cell in one request), then airport observations (one request per area),
 * then MET Norway (one request per cell) for as many cells as the remaining budget allows.
 */
export function planRequests(cells: readonly CellTarget[], options: PlanOptions): WeatherRequest[] {
  const maxRequests = options.maxRequests ?? DEFAULT_MAX_REQUESTS
  const models = options.models ?? OPEN_METEO_MODELS
  const requests: WeatherRequest[] = []
  if (cells.length === 0) return requests

  for (let i = 0; i < cells.length && requests.length < maxRequests; i += OPEN_METEO_MAX_LOCATIONS) {
    requests.push(openMeteoRequest(cells.slice(i, i + OPEN_METEO_MAX_LOCATIONS), models))
  }
  for (const area of metarAreas(cells)) {
    if (requests.length >= maxRequests) break
    requests.push(metarRequest(area, options.userAgent))
  }
  for (const cell of cells) {
    if (requests.length >= maxRequests) break
    requests.push(metNorwayRequest(cell, options.userAgent))
  }
  return requests
}

export type RequestFailure = { provider: WeatherRequest['provider']; url: string; reason: string }

export type ReadOptions = {
  models?: readonly string[]
}

const sourcesOf = (request: WeatherRequest, models: readonly string[]): SourceId[] =>
  request.provider === 'open-meteo'
    ? models.map(openMeteoSourceId)
    : [request.provider === 'metar' ? METAR_SOURCE_ID : MET_NORWAY_SOURCE_ID]

function parse(
  request: WeatherRequest,
  body: string,
  cells: readonly CellTarget[],
  models: readonly string[],
  now: number,
): Map<bigint, ReadingsBySource> {
  switch (request.provider) {
    case 'open-meteo':
      return parseOpenMeteo(body, cells, models, now)
    case 'metar': {
      const readings = new Map<bigint, ReadingsBySource>()
      for (const [key, reading] of parseMetar(body, cells, now)) {
        readings.set(key, { [METAR_SOURCE_ID]: { mmPerHour: reading.mmPerHour, observedAt: reading.observedAt } })
      }
      return readings
    }
    case 'met-norway': {
      const cell = cells[0]
      return cell ? new Map([[cell.key, { [MET_NORWAY_SOURCE_ID]: parseMetNorway(body, now) }]]) : new Map()
    }
  }
}

/**
 * Turns the outcome of every planned request into readings per cell and source. A request that failed, was
 * refused or returned something unreadable leaves its cells without a reading from that source; nothing is
 * assumed in its place.
 */
export function readResponses(
  cells: readonly CellTarget[],
  requests: readonly WeatherRequest[],
  results: readonly HttpResult[],
  now: number,
  options: ReadOptions = {},
): { observations: Observations; failures: RequestFailure[] } {
  const models = options.models ?? OPEN_METEO_MODELS
  const byKey = new Map(cells.map((cell) => [cell.key, cell]))
  const observations: Observations = new Map(cells.map((cell) => [cell.key, {}]))
  const failures: RequestFailure[] = []

  requests.forEach((request, index) => {
    const result = results[index] ?? null
    const requestCells = request.keys.map((key) => byKey.get(key)).filter((cell): cell is CellTarget => cell !== undefined)
    let readings: Map<bigint, ReadingsBySource> | null = null
    let reason: string | null = null

    if (result === null) {
      reason = 'no response'
    } else if (result.status < 200 || result.status >= 300) {
      reason = `status ${result.status}`
    } else {
      try {
        readings = parse(request, result.body, requestCells, models, now)
      } catch (error) {
        reason = error instanceof Error ? error.message : 'unreadable response'
      }
    }
    if (reason !== null) failures.push({ provider: request.provider, url: request.url, reason })

    for (const cell of requestCells) {
      const target = observations.get(cell.key)
      if (!target) continue
      const fromSource = readings?.get(cell.key)
      for (const source of sourcesOf(request, models)) {
        target[source] = fromSource?.[source] ?? NO_READING
      }
    }
  })
  return { observations, failures }
}

export type FetchOptions = PlanOptions & {
  fetch: FetchLike
  /** Unix seconds; readings are judged fresh or stale against it. */
  now: number
}

/** Plans the requests, performs them with the given `fetch` and reads the answers. Never throws on a source failure. */
export async function fetchObservations(
  cells: readonly CellTarget[],
  options: FetchOptions,
): Promise<{ observations: Observations; requests: WeatherRequest[]; failures: RequestFailure[] }> {
  const requests = planRequests(cells, options)
  const results = await Promise.all(
    requests.map(async (request): Promise<HttpResult> => {
      try {
        const response = await options.fetch(request.url, { method: 'GET', headers: request.headers })
        return { status: response.status, body: await response.text() }
      } catch {
        return null
      }
    }),
  )
  const { observations, failures } = readResponses(cells, requests, results, options.now, options)
  return { observations, requests, failures }
}
