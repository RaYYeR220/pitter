export { type CellObservation, MIN_SOURCES, type Verdict, aggregate, aggregateAll } from './aggregate'
export { distanceKm } from './geo'
export {
  METAR_MAX_AGE_SECONDS,
  METAR_MAX_DISTANCE_KM,
  METAR_NOMINAL_MM_PER_HOUR,
  METAR_SOURCE_ID,
  type MetarArea,
  type MetarReading,
  metarAreas,
  metarRequest,
  parseMetar,
  rainRateFromWeather,
} from './metar'
export { MET_NORWAY_SOURCE_ID, metNorwayRequest, parseMetNorway } from './metNorway'
export {
  OPEN_METEO_MAX_LOCATIONS,
  OPEN_METEO_MODELS,
  openMeteoRequest,
  openMeteoSourceId,
  parseOpenMeteo,
} from './openMeteo'
export {
  DEFAULT_MAX_REQUESTS,
  type FetchOptions,
  type PlanOptions,
  type ReadOptions,
  type RequestFailure,
  fetchObservations,
  planRequests,
  readResponses,
  targetsFromKeys,
} from './plan'
export {
  type BuildReportOptions,
  MAX_READINGS_PER_REPORT,
  REPORT_INTERVAL_SECONDS,
  type ReportDraft,
  type SealedReport,
  type SkippedKey,
  buildReport,
  encodeReport,
  reportAbiParameters,
  sealReports,
  signReport,
} from './report'
export {
  type CellTarget,
  type FetchLike,
  type HttpResult,
  NO_READING,
  type Observations,
  RAIN_THRESHOLD_MM_PER_HOUR,
  type ReadingsBySource,
  type SourceId,
  type SourceReading,
  type WeatherProvider,
  type WeatherRequest,
} from './types'
