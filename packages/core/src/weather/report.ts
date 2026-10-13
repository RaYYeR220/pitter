import { type Hex, encodeAbiParameters } from 'viem'
import { type Reading, type TypedDomain, hashReport, signDigest } from '../eip712'
import type { CellObservation, Verdict } from './aggregate'

/** How often the oracle runs, and how far back the first reading of a new key reaches. */
export const REPORT_INTERVAL_SECONDS = 300

/** Readings per report. A report of 20 readings for new cells costs about 1.7M gas. */
export const MAX_READINGS_PER_REPORT = 20

const MINUTE = 60

/** Readings and issue time of one report, before it is signed. */
export type ReportDraft = {
  readings: Reading[]
  issuedAt: bigint
}

export type SkippedKey = {
  key: bigint
  /** `no-verdict`: too few sources answered. `already-reported`: the index already covers this minute. */
  reason: 'no-verdict' | 'already-reported'
}

export type BuildReportOptions = {
  /** What the sources said, as cell observations or as a verdict per key. */
  observations: readonly CellObservation[] | ReadonlyMap<bigint, Verdict>
  intervalSeconds?: number
  /**
   * Longest stretch one reading may cover. A key whose last reading is older than this is picked up one
   * interval back, and the time in between stays unreported: the oracle did not observe it.
   */
  maxSpanSeconds?: number
  maxReadings?: number
  /**
   * When there is nothing to write but at least one observed cell has a verdict, emit one empty report. It
   * tells the index that the oracle and its sources are alive.
   */
  heartbeat?: boolean
}

function verdictsByKey(observations: BuildReportOptions['observations']): ReadonlyMap<bigint, Verdict> {
  if (!Array.isArray(observations)) return observations as ReadonlyMap<bigint, Verdict>
  return new Map((observations as readonly CellObservation[]).map((observation) => [observation.key, observation.verdict]))
}

/**
 * Builds the readings for the active keys at `now` (unix seconds).
 *
 * Every key with a verdict gets one reading that ends at the last full minute and starts where the key's
 * previous reading ended (`lastToByKey`), so readings chain without gaps or overlap; a key that was never
 * reported starts one interval back. A wet verdict marks the whole reading wet, a dry one marks none of it. Keys
 * without a verdict get no reading. The readings are split into reports of at most `maxReadings`, issued one
 * second apart so that they are accepted in order, the last one at `now`.
 */
export function buildReport(
  activeKeys: readonly bigint[],
  lastToByKey: ReadonlyMap<bigint, bigint>,
  now: number,
  options: BuildReportOptions,
): { reports: ReportDraft[]; skipped: SkippedKey[] } {
  const interval = BigInt(options.intervalSeconds ?? REPORT_INTERVAL_SECONDS)
  const maxSpan = BigInt(options.maxSpanSeconds ?? 3 * (options.intervalSeconds ?? REPORT_INTERVAL_SECONDS))
  const maxReadings = Math.max(1, options.maxReadings ?? MAX_READINGS_PER_REPORT)
  const verdicts = verdictsByKey(options.observations)
  const to = BigInt(Math.floor(now / MINUTE) * MINUTE)

  const readings: Reading[] = []
  const skipped: SkippedKey[] = []
  const seen = new Set<bigint>()
  for (const key of activeKeys) {
    if (seen.has(key)) continue
    seen.add(key)

    const verdict = verdicts.get(key) ?? 'unknown'
    if (verdict === 'unknown') {
      skipped.push({ key, reason: 'no-verdict' })
      continue
    }
    const lastTo = lastToByKey.get(key) ?? 0n
    if (lastTo >= to) {
      skipped.push({ key, reason: 'already-reported' })
      continue
    }
    const from = lastTo > 0n && to - lastTo <= maxSpan ? lastTo : to - interval
    readings.push({ key, from, to, wetSeconds: verdict === 'wet' ? Number(to - from) : 0 })
  }

  const chunks: Reading[][] = []
  for (let i = 0; i < readings.length; i += maxReadings) chunks.push(readings.slice(i, i + maxReadings))
  if (chunks.length === 0 && options.heartbeat && [...verdicts.values()].some((verdict) => verdict !== 'unknown')) {
    chunks.push([])
  }

  const reports = chunks.map((chunk, index) => ({
    readings: chunk,
    issuedAt: BigInt(now - (chunks.length - 1 - index)),
  }))
  return { reports, skipped }
}

/** The reporter's EIP-712 signature over a report, as `WeatherIndex` verifies it. */
export function signReport(readings: readonly Reading[], issuedAt: bigint, privateKey: Hex, domain: TypedDomain): Hex {
  return signDigest(hashReport(readings, issuedAt, domain), privateKey)
}

export const reportAbiParameters = [
  {
    name: 'readings',
    type: 'tuple[]',
    components: [
      { name: 'key', type: 'uint256' },
      { name: 'from', type: 'uint64' },
      { name: 'to', type: 'uint64' },
      { name: 'wetSeconds', type: 'uint32' },
    ],
  },
  { name: 'issuedAt', type: 'uint64' },
  { name: 'signature', type: 'bytes' },
] as const

/** The bytes `WeatherIndex.submit` and `WeatherIndex.onReport` accept: `abi.encode(readings, issuedAt, signature)`. */
export function encodeReport(readings: readonly Reading[], issuedAt: bigint, signature: Hex): Hex {
  return encodeAbiParameters(reportAbiParameters, [readings, issuedAt, signature])
}

export type SealedReport = ReportDraft & {
  digest: Hex
  signature: Hex
  /** Ready for `WeatherIndex.submit` or for delivery through a forwarder. */
  payload: Hex
}

/** Signs and encodes report drafts, keeping their order. Deliver them in that order. */
export function sealReports(drafts: readonly ReportDraft[], privateKey: Hex, domain: TypedDomain): SealedReport[] {
  return drafts.map((draft) => {
    const digest = hashReport(draft.readings, draft.issuedAt, domain)
    const signature = signDigest(digest, privateKey)
    return { ...draft, digest, signature, payload: encodeReport(draft.readings, draft.issuedAt, signature) }
  })
}
