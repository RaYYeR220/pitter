/** Rain of at least this intensity makes a cell wet. */
export const RAIN_THRESHOLD_MM_PER_HOUR = 1.0

/** `open-meteo:<model>`, `metar` or `met-norway`. */
export type SourceId = string

/** What one source says about one cell. `mmPerHour` is null when the source has no usable answer. */
export type SourceReading = {
  mmPerHour: number | null
  /** Unix seconds the value refers to, or null when there is no value. */
  observedAt: number | null
}

/** A cell the oracle reports on: its index key and the coordinates of its centre. */
export type CellTarget = {
  key: bigint
  lat: number
  lon: number
}

export type WeatherProvider = 'open-meteo' | 'metar' | 'met-norway'

/** One HTTP GET the oracle makes, and the cells it answers for. */
export type WeatherRequest = {
  provider: WeatherProvider
  url: string
  headers: Record<string, string>
  keys: bigint[]
}

/** Outcome of a request: the status and body, or null when the request itself failed. */
export type HttpResult = { status: number; body: string } | null

/** The part of the Fetch API the weather module needs. The platform `fetch` satisfies it. */
export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string> },
) => Promise<{ status: number; text(): Promise<string> }>

export type ReadingsBySource = Record<SourceId, SourceReading>

/** Per cell key, what every source said. */
export type Observations = Map<bigint, ReadingsBySource>

export const NO_READING: SourceReading = { mmPerHour: null, observedAt: null }
