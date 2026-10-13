import { describe, expect, it } from 'vitest'
import {
  CELL_SIZE_DEGREES,
  RAIN_TRIGGER_ID,
  cellFromId,
  cellFromLatLon,
  cellIdFromKey,
  cellIdFromLatLon,
  keyFromCellId,
  keyFromLatLon,
  triggerIdFromKey,
} from '../src/cells'

describe('cell grid', () => {
  it('uses a 0.05 degree grid', () => {
    expect(CELL_SIZE_DEGREES).toBe(0.05)
  })

  it('packs the latitude index into the high 32 bits and the longitude index into the low 32 bits', () => {
    // Warsaw: (52.23 + 90) / 0.05 = 2844.6, (21.01 + 180) / 0.05 = 4020.2
    expect(cellIdFromLatLon(52.23, 21.01)).toBe((2844n << 32n) | 4020n)
  })

  it('gives every point of a cell the same id', () => {
    const id = cellIdFromLatLon(52.2, 21.0)
    expect(cellIdFromLatLon(52.2499, 21.0499)).toBe(id)
    expect(cellIdFromLatLon(52.225, 21.025)).toBe(id)
    expect(cellIdFromLatLon(52.25, 21.0)).not.toBe(id)
    expect(cellIdFromLatLon(52.2, 21.05)).not.toBe(id)
  })

  it('is not thrown off by binary floating point at cell edges', () => {
    // 0.15 / 0.05 is 2.9999999999999996 in floating point
    expect(cellIdFromLatLon(-89.85, -179.85)).toBe((3n << 32n) | 3n)
    expect(cellIdFromLatLon(0.3, 0.3)).toBe((1806n << 32n) | 3606n)
  })

  it('returns the centre and the bounds of a cell', () => {
    const cell = cellFromLatLon(52.23, 21.01)
    expect(cell.lat).toBe(52.225)
    expect(cell.lon).toBe(21.025)
    expect(cell.bounds).toEqual({ south: 52.2, north: 52.25, west: 21.0, east: 21.05 })
    expect(cellFromId(cell.id)).toEqual(cell)
  })

  it('round-trips ids across the globe', () => {
    for (const [lat, lon] of [
      [-90, -180],
      [-33.946, 151.173],
      [0, 0],
      [59.88, -1.296],
      [89.999, 179.999],
    ] as const) {
      const cell = cellFromLatLon(lat, lon)
      expect(cellIdFromLatLon(cell.lat, cell.lon)).toBe(cell.id)
      expect(cell.bounds.south).toBeLessThanOrEqual(lat)
      expect(cell.bounds.north).toBeGreaterThan(lat)
      expect(cell.bounds.west).toBeLessThanOrEqual(lon)
      expect(cell.bounds.east).toBeGreaterThan(lon)
    }
  })

  it('keeps the poles and the antimeridian on the grid', () => {
    expect(cellIdFromLatLon(90, 0) >> 32n).toBe(3599n)
    expect(cellIdFromLatLon(0, 180)).toBe(cellIdFromLatLon(0, -180))
    expect(cellIdFromLatLon(0, 190)).toBe(cellIdFromLatLon(0, -170))
  })

  it('rejects coordinates that are not on the globe', () => {
    expect(() => cellIdFromLatLon(90.01, 0)).toThrow(RangeError)
    expect(() => cellIdFromLatLon(Number.NaN, 0)).toThrow(RangeError)
    expect(() => cellFromId(3600n << 32n)).toThrow(RangeError)
    expect(() => cellFromId(7200n)).toThrow(RangeError)
  })
})

describe('index keys', () => {
  it('puts the trigger id above the 64-bit cell id', () => {
    const cellId = cellIdFromLatLon(52.23, 21.01)
    const key = keyFromCellId(cellId)
    expect(RAIN_TRIGGER_ID).toBe(1n)
    expect(key).toBe((1n << 64n) | cellId)
    expect(keyFromLatLon(52.23, 21.01)).toBe(key)
    expect(cellIdFromKey(key)).toBe(cellId)
    expect(triggerIdFromKey(key)).toBe(1n)
  })

  it('supports other triggers without changing the cell part', () => {
    const cellId = cellIdFromLatLon(-33.946, 151.173)
    const key = keyFromCellId(cellId, 7n)
    expect(triggerIdFromKey(key)).toBe(7n)
    expect(cellIdFromKey(key)).toBe(cellId)
  })
})
