import {
  type CellTarget,
  type HttpResult,
  type ReportDraft,
  type SealedReport,
  type SkippedKey,
  type Verdict,
  type WeatherRequest,
  aggregateAll,
  buildReport,
  cellFromLatLon,
  keyFromCellId,
  planRequests,
  readResponses,
  reportDomain,
  sealReports,
  targetsFromKeys,
} from '@cover/core'
import type { Address, Hex } from 'viem'

/** What one oracle run needs to know. Everything else comes from the chain and the weather sources. */
export type OracleSettings = {
  chainId: number
  weatherIndex: Address
  /** Sent to the weather sources that ask callers to identify themselves. */
  userAgent: string
  thresholdMmPerHour: number
  intervalSeconds: number
  maxHttpRequests: number
  /**
   * Cell observed when no policy is open. If its sources answer, the run writes an empty report so that the
   * index heartbeat stays fresh and cover can be sold. Null disables the heartbeat.
   */
  heartbeatCell: { lat: number; lon: number } | null
  gasLimitBase: bigint
  gasLimitPerReading: bigint
}

export type Delivery = {
  /** Whether the index accepted the report. */
  accepted: boolean
  txHash: Hex | null
  detail?: string
}

/** The side effects of a run. The environment performs them; the run decides which and in what order. */
export type Effect =
  | { type: 'now' }
  | { type: 'activeCells' }
  | { type: 'observe'; cells: CellTarget[]; requests: WeatherRequest[]; now: number; thresholdMmPerHour: number }
  | { type: 'lastTo'; keys: bigint[] }
  | { type: 'reporterKey' }
  | { type: 'deliver'; report: SealedReport; gasLimit: bigint }
  | { type: 'log'; message: string }

export type DeliveredReport = {
  issuedAt: bigint
  readings: number
  wetReadings: number
  accepted: boolean
  txHash: Hex | null
}

export type RunSummary = {
  now: number
  activeCells: number
  /** Verdict per observed cell, in the order of `observedKeys`. */
  observedKeys: bigint[]
  verdicts: Verdict[]
  httpRequests: number
  skipped: SkippedKey[]
  reports: DeliveredReport[]
  outcome: 'reported' | 'heartbeat' | 'nothing-to-report' | 'no-quorum' | 'idle'
}

function* perform<T>(effect: Effect): Generator<Effect, T, unknown> {
  return (yield effect) as T
}

/** Gas a report is sent with. Monad charges the limit, not the gas used, so the limit follows the report size. */
export function gasLimitFor(settings: OracleSettings, readings: number): bigint {
  return settings.gasLimitBase + settings.gasLimitPerReading * BigInt(readings)
}

/**
 * Turns the answers of the planned requests into one verdict per cell. This is the part of a run that sees raw
 * source data; in a decentralised run every node executes it and the nodes agree on its result.
 */
export function judgeResponses(
  cells: readonly CellTarget[],
  requests: readonly WeatherRequest[],
  results: readonly HttpResult[],
  now: number,
  thresholdMmPerHour: number,
): Verdict[] {
  const { observations } = readResponses(cells, requests, results, now)
  return aggregateAll(cells, observations, thresholdMmPerHour).map((observation) => observation.verdict)
}

const VERDICT_CODES: Record<Verdict, string> = { wet: 'w', dry: 'd', unknown: 'u' }

/** One character per cell, for carrying verdicts through node consensus as a single value. */
export function encodeVerdicts(verdicts: readonly Verdict[]): string {
  return verdicts.map((verdict) => VERDICT_CODES[verdict]).join('')
}

export function decodeVerdicts(encoded: string, count: number): Verdict[] {
  if (encoded.length !== count) throw new Error(`expected ${count} verdicts, got ${encoded.length}`)
  return [...encoded].map((code) => {
    if (code === 'w') return 'wet'
    if (code === 'd') return 'dry'
    if (code === 'u') return 'unknown'
    throw new Error(`not a verdict code: ${code}`)
  })
}

/**
 * One oracle run: read the cells with open policies, ask the weather sources about them, and deliver signed
 * readings that continue each cell's timeline. Nothing is written for a cell without a quorum of sources, and
 * nothing at all when no cell has one.
 */
export function* oracleRun(settings: OracleSettings): Generator<Effect, RunSummary, unknown> {
  const now = yield* perform<number>({ type: 'now' })
  const activeKeys = yield* perform<bigint[]>({ type: 'activeCells' })
  const targets = targetsFromKeys(activeKeys)

  const summary: RunSummary = {
    now,
    activeCells: activeKeys.length,
    observedKeys: [],
    verdicts: [],
    httpRequests: 0,
    skipped: [],
    reports: [],
    outcome: 'idle',
  }

  let cells = targets
  if (cells.length === 0 && settings.heartbeatCell) {
    const cell = cellFromLatLon(settings.heartbeatCell.lat, settings.heartbeatCell.lon)
    cells = [{ key: keyFromCellId(cell.id), lat: cell.lat, lon: cell.lon }]
  }
  if (cells.length === 0) {
    yield* perform<void>({ type: 'log', message: 'no open policies and no heartbeat cell: nothing to do' })
    return summary
  }

  const requests = planRequests(cells, { userAgent: settings.userAgent, maxRequests: settings.maxHttpRequests })
  const verdicts = yield* perform<Verdict[]>({
    type: 'observe',
    cells,
    requests,
    now,
    thresholdMmPerHour: settings.thresholdMmPerHour,
  })
  summary.observedKeys = cells.map((cell) => cell.key)
  summary.verdicts = verdicts
  summary.httpRequests = requests.length

  const verdictByKey = new Map(cells.map((cell, index) => [cell.key, verdicts[index] ?? 'unknown']))
  const judged = targets.filter((cell) => verdictByKey.get(cell.key) !== 'unknown')
  if (![...verdictByKey.values()].some((verdict) => verdict !== 'unknown')) {
    summary.skipped = targets.map((cell) => ({ key: cell.key, reason: 'no-verdict' as const }))
    summary.outcome = 'no-quorum'
    yield* perform<void>({ type: 'log', message: `no cell reached a quorum of sources (${cells.length} observed): nothing written` })
    return summary
  }

  const lastToByKey = new Map<bigint, bigint>()
  if (judged.length > 0) {
    const keys = judged.map((cell) => cell.key)
    const lastTo = yield* perform<bigint[]>({ type: 'lastTo', keys })
    keys.forEach((key, index) => lastToByKey.set(key, lastTo[index] ?? 0n))
  }

  const { reports, skipped } = buildReport(
    targets.map((cell) => cell.key),
    lastToByKey,
    now,
    { observations: verdictByKey, intervalSeconds: settings.intervalSeconds, heartbeat: true },
  )
  summary.skipped = skipped
  if (reports.length === 0) {
    summary.outcome = 'nothing-to-report'
    return summary
  }

  yield* deliverReports(settings, reports, summary)
  summary.outcome = reports.some((report) => report.readings.length > 0) ? 'reported' : 'heartbeat'
  return summary
}

function* deliverReports(settings: OracleSettings, reports: ReportDraft[], summary: RunSummary): Generator<Effect, void, unknown> {
  const reporterKey = yield* perform<Hex>({ type: 'reporterKey' })
  const sealed = sealReports(reports, reporterKey, reportDomain(settings.chainId, settings.weatherIndex))
  for (const report of sealed) {
    const delivery = yield* perform<Delivery>({
      type: 'deliver',
      report,
      gasLimit: gasLimitFor(settings, report.readings.length),
    })
    const wetReadings = report.readings.filter((reading) => reading.wetSeconds > 0).length
    summary.reports.push({
      issuedAt: report.issuedAt,
      readings: report.readings.length,
      wetReadings,
      accepted: delivery.accepted,
      txHash: delivery.txHash,
    })
    const state = delivery.accepted ? 'delivered' : `NOT accepted${delivery.detail ? ` (${delivery.detail})` : ''}`
    yield* perform<void>({
      type: 'log',
      message: `report issuedAt=${report.issuedAt} readings=${report.readings.length} wet=${wetReadings} ${state} tx=${delivery.txHash ?? 'none'}`,
    })
  }
}

type MaybePromise<T> = T | Promise<T>

/** How an environment performs the effects of a run. */
export type Handlers<Async extends boolean = false> = {
  now(): Async extends true ? MaybePromise<number> : number
  activeCells(): Async extends true ? MaybePromise<bigint[]> : bigint[]
  observe(effect: Extract<Effect, { type: 'observe' }>): Async extends true ? MaybePromise<Verdict[]> : Verdict[]
  lastTo(keys: bigint[]): Async extends true ? MaybePromise<bigint[]> : bigint[]
  reporterKey(): Async extends true ? MaybePromise<Hex> : Hex
  deliver(report: SealedReport, gasLimit: bigint): Async extends true ? MaybePromise<Delivery> : Delivery
  log(message: string): void
}

function dispatch(effect: Effect, handlers: Handlers<boolean>): unknown {
  switch (effect.type) {
    case 'now':
      return handlers.now()
    case 'activeCells':
      return handlers.activeCells()
    case 'observe':
      return handlers.observe(effect)
    case 'lastTo':
      return handlers.lastTo(effect.keys)
    case 'reporterKey':
      return handlers.reporterKey()
    case 'deliver':
      return handlers.deliver(effect.report, effect.gasLimit)
    case 'log':
      return handlers.log(effect.message)
  }
}

/** Runs the oracle where every effect completes synchronously, as capabilities do inside a workflow. */
export function runOracleSync(settings: OracleSettings, handlers: Handlers<false>): RunSummary {
  const run = oracleRun(settings)
  let step = run.next()
  while (!step.done) step = run.next(dispatch(step.value, handlers))
  return step.value
}

/** Runs the oracle where effects may be asynchronous, as they are in a regular process. */
export async function runOracle(settings: OracleSettings, handlers: Handlers<true>): Promise<RunSummary> {
  const run = oracleRun(settings)
  let step = run.next()
  while (!step.done) step = run.next(await dispatch(step.value, handlers))
  return step.value
}
