/** Side of a grid cell in degrees (about 5.5 km north to south). */
export const CELL_SIZE_DEGREES = 0.05

/** Trigger 1: rain of at least 1.0 mm/h. */
export const RAIN_TRIGGER_ID = 1n

const MICRO = 1_000_000
const CELL_MICRO = 50_000
const LAT_CELLS = 3_600
const LON_CELLS = 7_200
const CELL_ID_BITS = 64n
const CELL_ID_MASK = (1n << CELL_ID_BITS) - 1n
const INDEX_MASK = 0xffff_ffffn

export type CellBounds = { south: number; north: number; west: number; east: number }

export type Cell = {
  /** `(latIndex << 32) | lonIndex` */
  id: bigint
  latIndex: number
  lonIndex: number
  /** Latitude of the cell centre. */
  lat: number
  /** Longitude of the cell centre. */
  lon: number
  bounds: CellBounds
}

const latFromIndex = (index: number, offsetMicro: number) => (index * CELL_MICRO + offsetMicro - 90 * MICRO) / MICRO
const lonFromIndex = (index: number, offsetMicro: number) => (index * CELL_MICRO + offsetMicro - 180 * MICRO) / MICRO

function buildCell(latIndex: number, lonIndex: number): Cell {
  return {
    id: (BigInt(latIndex) << 32n) | BigInt(lonIndex),
    latIndex,
    lonIndex,
    lat: latFromIndex(latIndex, CELL_MICRO / 2),
    lon: lonFromIndex(lonIndex, CELL_MICRO / 2),
    bounds: {
      south: latFromIndex(latIndex, 0),
      north: latFromIndex(latIndex, CELL_MICRO),
      west: lonFromIndex(lonIndex, 0),
      east: lonFromIndex(lonIndex, CELL_MICRO),
    },
  }
}

/** The cell that contains a point. Longitudes wrap around the antimeridian. */
export function cellFromLatLon(lat: number, lon: number): Cell {
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90) {
    throw new RangeError(`not a point on the globe: ${lat}, ${lon}`)
  }
  const latMicro = Math.round(lat * MICRO) + 90 * MICRO
  const lonMicro = (((Math.round(lon * MICRO) + 180 * MICRO) % (360 * MICRO)) + 360 * MICRO) % (360 * MICRO)
  const latIndex = Math.min(Math.floor(latMicro / CELL_MICRO), LAT_CELLS - 1)
  const lonIndex = Math.floor(lonMicro / CELL_MICRO)
  return buildCell(latIndex, lonIndex)
}

export function cellIdFromLatLon(lat: number, lon: number): bigint {
  return cellFromLatLon(lat, lon).id
}

export function cellFromId(id: bigint): Cell {
  const latIndex = Number(id >> 32n)
  const lonIndex = Number(id & INDEX_MASK)
  if (id < 0n || id > CELL_ID_MASK || latIndex >= LAT_CELLS || lonIndex >= LON_CELLS) {
    throw new RangeError(`not a cell id: ${id}`)
  }
  return buildCell(latIndex, lonIndex)
}

/** Weather index key of a cell: `(triggerId << 64) | cellId`. */
export function keyFromCellId(cellId: bigint, triggerId: bigint = RAIN_TRIGGER_ID): bigint {
  return (triggerId << CELL_ID_BITS) | cellId
}

export function keyFromLatLon(lat: number, lon: number, triggerId: bigint = RAIN_TRIGGER_ID): bigint {
  return keyFromCellId(cellIdFromLatLon(lat, lon), triggerId)
}

export function cellIdFromKey(key: bigint): bigint {
  return key & CELL_ID_MASK
}

export function triggerIdFromKey(key: bigint): bigint {
  return key >> CELL_ID_BITS
}

export function cellFromKey(key: bigint): Cell {
  return cellFromId(cellIdFromKey(key))
}
