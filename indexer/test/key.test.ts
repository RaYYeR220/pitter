import { describe, expect, it } from 'vitest'
import { decodeKey } from '../src/key'

const RAIN = 1n
const keyOf = (triggerId: bigint, latIndex: bigint, lonIndex: bigint) =>
  (triggerId << 64n) | (latIndex << 32n) | lonIndex

describe('decodeKey', () => {
  it.each([
    ['Lisbon', 18446755128955374937n, 2574, 3417, 38.725, -9.125],
    ['New York', 18446755300754065479n, 2614, 2119, 40.725, -74.025],
    ['Sydney', 18446748892662864352n, 1122, 6624, -33.875, 151.225],
    ['the equator at Greenwich', 18446751804650688016n, 1800, 3600, 0.025, 0.025],
  ])('places the cell of %s', (_name, key, latIndex, lonIndex, lat, lon) => {
    expect(decodeKey(key)).toEqual({
      triggerId: RAIN,
      cellId: (BigInt(latIndex) << 32n) | BigInt(lonIndex),
      grid: { latIndex, lonIndex, lat, lon },
    })
  })

  it('reaches both corners of the grid', () => {
    expect(decodeKey(keyOf(RAIN, 0n, 0n)).grid).toEqual({ latIndex: 0, lonIndex: 0, lat: -89.975, lon: -179.975 })
    expect(decodeKey(keyOf(RAIN, 3599n, 7199n)).grid).toEqual({
      latIndex: 3599,
      lonIndex: 7199,
      lat: 89.975,
      lon: 179.975,
    })
  })

  it('separates the trigger from the cell', () => {
    const key = keyOf(7n, 1800n, 3600n)
    expect(decodeKey(key).triggerId).toBe(7n)
    expect(decodeKey(key).cellId).toBe(decodeKey(keyOf(RAIN, 1800n, 3600n)).cellId)
  })

  it('keeps a trigger id wider than 64 bits', () => {
    const triggerId = (1n << 191n) + 5n
    expect(decodeKey(keyOf(triggerId, 10n, 20n)).triggerId).toBe(triggerId)
  })

  it('gives no position to a cell id off the grid', () => {
    expect(decodeKey(keyOf(RAIN, 3600n, 0n)).grid).toBeUndefined()
    expect(decodeKey(keyOf(RAIN, 0n, 7200n)).grid).toBeUndefined()
    expect(decodeKey((RAIN << 64n) | ((1n << 64n) - 1n)).grid).toBeUndefined()
  })

  it('still reports the cell id of a key off the grid', () => {
    expect(decodeKey(keyOf(RAIN, 3600n, 0n)).cellId).toBe(3600n << 32n)
  })
})
