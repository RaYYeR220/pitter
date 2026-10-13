import {
  type CellTarget,
  type Observations,
  RAIN_THRESHOLD_MM_PER_HOUR,
  type ReadingsBySource,
} from './types'

/** Sources that must answer before a cell is judged. */
export const MIN_SOURCES = 2

/** `unknown` means too few sources answered: the oracle says nothing about the cell. */
export type Verdict = 'wet' | 'dry' | 'unknown'

export type CellObservation = {
  key: bigint
  verdict: Verdict
  /** Median intensity of the sources that answered, or null without a verdict. */
  medianMmPerHour: number | null
  /** Number of sources that answered. */
  answered: number
  readings: ReadingsBySource
}

const SCALE = 1000

/**
 * Judges one cell from what its sources said: wet when at least two sources answered and the median of their
 * intensities is at or above the threshold. With fewer than two answers there is no verdict.
 */
export function aggregate(
  cell: CellTarget,
  readingsBySource: ReadingsBySource,
  threshold: number = RAIN_THRESHOLD_MM_PER_HOUR,
): CellObservation {
  // Intensities are compared in thousandths of a millimetre so that the median of an even count is exact.
  const values = Object.values(readingsBySource)
    .map((reading) => reading.mmPerHour)
    .filter((value): value is number => value !== null && Number.isFinite(value))
    .map((value) => Math.round(value * SCALE))
    .sort((a, b) => a - b)

  if (values.length < MIN_SOURCES) {
    return { key: cell.key, verdict: 'unknown', medianMmPerHour: null, answered: values.length, readings: readingsBySource }
  }

  const middle = values.length >> 1
  const twiceMedian = values.length % 2 === 1 ? 2 * values[middle]! : values[middle - 1]! + values[middle]!
  const wet = twiceMedian >= 2 * Math.round(threshold * SCALE)
  return {
    key: cell.key,
    verdict: wet ? 'wet' : 'dry',
    medianMmPerHour: twiceMedian / (2 * SCALE),
    answered: values.length,
    readings: readingsBySource,
  }
}

/** Judges every cell, in the order given. A cell the sources were never asked about has no verdict. */
export function aggregateAll(
  cells: readonly CellTarget[],
  observations: Observations,
  threshold: number = RAIN_THRESHOLD_MM_PER_HOUR,
): CellObservation[] {
  return cells.map((cell) => aggregate(cell, observations.get(cell.key) ?? {}, threshold))
}
