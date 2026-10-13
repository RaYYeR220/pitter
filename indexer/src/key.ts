const MICRO = 1_000_000
const CELL_MICRO = 50_000
const LAT_CELLS = 3_600
const LON_CELLS = 7_200
const CELL_ID_BITS = 64n
const CELL_ID_MASK = (1n << CELL_ID_BITS) - 1n
const INDEX_BITS = 32n
const INDEX_MASK = (1n << INDEX_BITS) - 1n

/** Where a cell sits on the 0.05 degree grid. `lat` and `lon` are the cell centre. */
export type GridPosition = { latIndex: number; lonIndex: number; lat: number; lon: number }

export type DecodedKey = {
  triggerId: bigint
  /** `(latIndex << 32) | lonIndex` */
  cellId: bigint
  /** Undefined when the cell id is not on the grid: the contracts accept any key. */
  grid: GridPosition | undefined
}

/** Splits a weather index key, `(triggerId << 64) | cellId`, into its trigger and its cell. */
export function decodeKey(key: bigint): DecodedKey {
  const cellId = key & CELL_ID_MASK
  return { triggerId: key >> CELL_ID_BITS, cellId, grid: gridPosition(cellId) }
}

function gridPosition(cellId: bigint): GridPosition | undefined {
  const latIndex = Number(cellId >> INDEX_BITS)
  const lonIndex = Number(cellId & INDEX_MASK)
  if (latIndex >= LAT_CELLS || lonIndex >= LON_CELLS) return undefined
  return {
    latIndex,
    lonIndex,
    lat: (latIndex * CELL_MICRO + CELL_MICRO / 2 - 90 * MICRO) / MICRO,
    lon: (lonIndex * CELL_MICRO + CELL_MICRO / 2 - 180 * MICRO) / MICRO,
  }
}
