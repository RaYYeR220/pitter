import type { AreaWeather } from '../chain/reader'
import { phaseOf, type CoverRecord, type CoverSnapshot } from './history'

/** Cover bought back to back, or nearly so, counts as one shift. */
export const SHIFT_GAP_SECONDS = 30 * 60

/** A run of cover with no long break in it. */
export interface Shift {
  start: number
  end: number
  /** Newest first. */
  records: CoverRecord[]
  cost: bigint
  /** Sent to the holder. */
  paid: bigint
  /** Confirmed by the weather record, not yet sent. */
  confirmed: bigint
  /** Whether any of it is still running or waiting for its last weather check. */
  open: boolean
}

/** Groups a holder's cover into shifts, newest first. */
export function groupShifts(records: readonly CoverRecord[], gapSeconds = SHIFT_GAP_SECONDS): Shift[] {
  const ordered = [...records].sort((a, b) => a.start - b.start)
  const shifts: Shift[] = []
  for (const record of ordered) {
    const current = shifts.at(-1)
    if (current && record.start <= current.end + gapSeconds) {
      current.records.unshift(record)
      current.end = Math.max(current.end, record.end)
      current.cost += record.premium
      current.paid += record.paid
      current.confirmed += record.confirmed
      current.open ||= !record.closed
    } else {
      shifts.push({
        start: record.start,
        end: record.end,
        records: [record],
        cost: record.premium,
        paid: record.paid,
        confirmed: record.confirmed,
        open: !record.closed,
      })
    }
  }
  return shifts.reverse()
}

/**
 * What a piece of cover has probably earned since the last weather check: if that check found rain, the rate
 * for every covered second since. It is a projection, not a debt; the next check replaces it with fact.
 */
export function provisionalOf(record: CoverRecord, weather: AreaWeather | undefined, now: number): bigint {
  if (record.closed || !weather?.raining || weather.lastCheckedAt === null) return 0n
  const from = Math.max(record.start, weather.lastCheckedAt)
  const to = Math.min(now, record.end)
  if (to <= from) return 0n
  const room = record.maxPayout - record.paid - record.confirmed
  const amount = record.ratePerSecond * BigInt(to - from)
  return amount < room ? amount : room > 0n ? room : 0n
}

/** How the current shift stands: what was paid, what is confirmed, and what is still only likely. */
export interface Accrual {
  /** The shift being shown: the one running now, or the last one while its payouts are still settling. */
  shift: Shift | null
  /** Whether cover is running at this moment. */
  running: boolean
  /** End of the paid-up cover that is running or about to start. */
  coveredUntil: number | null
  paid: bigint
  confirmed: bigint
  provisional: bigint
  cost: bigint
  /** The payout rate of the cover running now, per second. */
  ratePerSecond: bigint | null
  /** The last weather check for the area of the running cover. */
  weather: AreaWeather | null
}

const NONE: Accrual = {
  shift: null,
  running: false,
  coveredUntil: null,
  paid: 0n,
  confirmed: 0n,
  provisional: 0n,
  cost: 0n,
  ratePerSecond: null,
  weather: null,
}

/**
 * The live view of a holder's cover at `now`.
 *
 * Paid and confirmed come from the chain. Provisional covers the stretch the weather record has not reached
 * yet, and is only ever shown as such.
 */
export function computeAccrual(snapshot: CoverSnapshot, now: number): Accrual {
  const shift = groupShifts(snapshot.records).find((entry) => entry.open || entry.end + SHIFT_GAP_SECONDS > now)
  if (!shift) return NONE

  const live = shift.records.filter((record) => phaseOf(record, now) === 'active')
  const pending = shift.records.filter((record) => !record.closed && record.end > now)
  const current = live[0] ?? pending.at(-1) ?? shift.records[0]!
  const weather = snapshot.weather.get(current.key) ?? null

  let provisional = 0n
  for (const record of shift.records) provisional += provisionalOf(record, snapshot.weather.get(record.key), now)

  return {
    shift,
    running: live.length > 0,
    coveredUntil: pending.length > 0 ? Math.max(...pending.map((record) => record.end)) : null,
    paid: shift.paid,
    confirmed: shift.confirmed,
    provisional,
    cost: shift.cost,
    ratePerSecond: live[0]?.ratePerSecond ?? null,
    weather,
  }
}
