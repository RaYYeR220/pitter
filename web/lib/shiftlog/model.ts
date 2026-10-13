/** One exact position on a shift. This is the data that never leaves the device unencrypted. */
export interface TrailPoint {
  /** Unix seconds. */
  at: number
  lat: number
  lon: number
  /** Accuracy in metres, when the device reported one. */
  accuracy?: number
}

export interface ShiftEntry {
  id: string
  startedAt: number
  endedAt: number | null
  label: string
  note: string
  trail: TrailPoint[]
  /** When the entry last changed; the newer copy wins when two devices edited the log. */
  updatedAt: number
}

export interface ShiftLog {
  version: 1
  shifts: ShiftEntry[]
  /** Whether old routes were dropped to keep the log under the storage limit. */
  trimmed: boolean
}

export const MAX_LABEL = 80
export const MAX_NOTE = 2000

export function emptyLog(): ShiftLog {
  return { version: 1, shifts: [], trimmed: false }
}

const clip = (text: string, max: number) => text.slice(0, max)

export function newShift(id: string, startedAt: number, label = ''): ShiftEntry {
  return { id, startedAt, endedAt: null, label: clip(label, MAX_LABEL), note: '', trail: [], updatedAt: startedAt }
}

const replace = (log: ShiftLog, id: string, change: (shift: ShiftEntry) => ShiftEntry): ShiftLog => ({
  ...log,
  shifts: log.shifts.map((shift) => (shift.id === id ? change(shift) : shift)),
})

/** Adds a shift at the top of the log. */
export function addShift(log: ShiftLog, shift: ShiftEntry): ShiftLog {
  return { ...log, shifts: [shift, ...log.shifts.filter((entry) => entry.id !== shift.id)] }
}

export function editShift(
  log: ShiftLog,
  id: string,
  changes: { label?: string; note?: string; endedAt?: number | null },
  now: number,
): ShiftLog {
  return replace(log, id, (shift) => ({
    ...shift,
    ...(changes.label !== undefined ? { label: clip(changes.label, MAX_LABEL) } : {}),
    ...(changes.note !== undefined ? { note: clip(changes.note, MAX_NOTE) } : {}),
    ...(changes.endedAt !== undefined ? { endedAt: changes.endedAt } : {}),
    updatedAt: now,
  }))
}

export function removeShift(log: ShiftLog, id: string): ShiftLog {
  return { ...log, shifts: log.shifts.filter((shift) => shift.id !== id) }
}

export function addPoint(log: ShiftLog, id: string, point: TrailPoint): ShiftLog {
  return replace(log, id, (shift) => ({ ...shift, trail: [...shift.trail, point], updatedAt: point.at }))
}

/**
 * Combines the copy in memory with the copy in storage after both changed. Entries are matched by id and the
 * one edited last wins; nothing that exists in only one copy is lost.
 */
export function mergeLogs(local: ShiftLog, stored: ShiftLog): ShiftLog {
  const byId = new Map<string, ShiftEntry>()
  for (const shift of [...stored.shifts, ...local.shifts]) {
    const known = byId.get(shift.id)
    if (!known || shift.updatedAt >= known.updatedAt) byId.set(shift.id, shift)
  }
  return {
    version: 1,
    shifts: [...byId.values()].sort((a, b) => b.startedAt - a.startedAt),
    trimmed: local.trimmed || stored.trimmed,
  }
}

type WirePoint = [at: number, lat: number, lon: number, accuracy?: number]

interface WireLog {
  v: 1
  trimmed?: boolean
  shifts: Array<{ id: string; s: number; e: number | null; l: string; n: string; u: number; t: WirePoint[] }>
}

/** Serialises the log compactly: a route of a thousand points should stay well under the storage limit. */
export function encodeLog(log: ShiftLog): Uint8Array<ArrayBuffer> {
  const wire: WireLog = {
    v: 1,
    ...(log.trimmed ? { trimmed: true } : {}),
    shifts: log.shifts.map((shift) => ({
      id: shift.id,
      s: shift.startedAt,
      e: shift.endedAt,
      l: shift.label,
      n: shift.note,
      u: shift.updatedAt,
      t: shift.trail.map((point) =>
        point.accuracy === undefined
          ? [point.at, point.lat, point.lon]
          : [point.at, point.lat, point.lon, point.accuracy],
      ),
    })),
  }
  return new TextEncoder().encode(JSON.stringify(wire))
}

export class ShiftLogFormatError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ShiftLogFormatError'
  }
}

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

/** Reads a decrypted log. Throws `ShiftLogFormatError` when the bytes are not one. */
export function decodeLog(bytes: Uint8Array): ShiftLog {
  let wire: unknown
  try {
    wire = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    throw new ShiftLogFormatError('the log is not readable text')
  }
  const root = wire as Partial<WireLog> | null
  if (!root || root.v !== 1 || !Array.isArray(root.shifts)) throw new ShiftLogFormatError('not a version 1 shift log')

  const shifts = root.shifts.map((entry): ShiftEntry => {
    if (
      !entry ||
      typeof entry.id !== 'string' ||
      !finite(entry.s) ||
      !(entry.e === null || finite(entry.e)) ||
      typeof entry.l !== 'string' ||
      typeof entry.n !== 'string' ||
      !Array.isArray(entry.t)
    ) {
      throw new ShiftLogFormatError('a shift entry is malformed')
    }
    return {
      id: entry.id,
      startedAt: entry.s,
      endedAt: entry.e,
      label: entry.l,
      note: entry.n,
      updatedAt: finite(entry.u) ? entry.u : entry.s,
      trail: entry.t.map((point) => {
        if (!Array.isArray(point) || !finite(point[0]) || !finite(point[1]) || !finite(point[2])) {
          throw new ShiftLogFormatError('a route point is malformed')
        }
        return {
          at: point[0],
          lat: point[1],
          lon: point[2],
          ...(finite(point[3]) ? { accuracy: point[3] } : {}),
        }
      }),
    }
  })
  return { version: 1, shifts, trimmed: root.trimmed === true }
}

/**
 * Makes the log fit into `maxBytes` once serialised by dropping the routes of the oldest shifts first. Names
 * and notes are kept. The result says whether anything was dropped.
 */
export function fitLog(log: ShiftLog, maxBytes: number): ShiftLog {
  if (encodeLog(log).length <= maxBytes) return log

  const oldestFirst = [...log.shifts].sort((a, b) => a.startedAt - b.startedAt)
  let fitted: ShiftLog = { ...log, trimmed: true }
  for (const shift of oldestFirst) {
    if (shift.trail.length === 0) continue
    fitted = replace(fitted, shift.id, (entry) => ({ ...entry, trail: [] }))
    if (encodeLog(fitted).length <= maxBytes) return fitted
  }
  return fitted
}
