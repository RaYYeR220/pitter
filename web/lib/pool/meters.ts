import type { PoolState } from '../chain/reader'

const BPS = 10_000n

export interface Meter {
  used: bigint
  limit: bigint
  /** What can still be taken on before the limit; never negative. */
  room: bigint
  /** Share of the limit in use, 0 to 1 and beyond when the pool shrank under existing cover. */
  share: number
}

export interface AreaMeter extends Meter {
  key: bigint
  openCover: bigint
}

export interface PoolMeters {
  /** Everything deposited, including capital that has asked to leave. */
  total: bigint
  /** Capital still backing new cover: what the limits are measured against. */
  active: bigint
  /** Capital that asked to leave and earns nothing more. */
  leaving: bigint
  /** Most that open cover could still pay out, against the pool's limit. */
  pool: Meter
  /** The limit for any one area. */
  areaLimit: bigint
  /** Most exposed first. */
  areas: AreaMeter[]
  /** What can leave the pool right now. */
  free: bigint
}

function meter(used: bigint, limit: bigint): Meter {
  const room = limit > used ? limit - used : 0n
  const share = limit > 0n ? Number((used * 10_000n) / limit) / 10_000 : used > 0n ? Infinity : 0
  return { used, limit, room, share }
}

/**
 * The pool's limits as the contracts enforce them: open cover against `maxUtilizationBps` of the active
 * capital, and each area against `maxCellBps` of it. Capital that asked to leave counts towards neither.
 */
export function poolMeters(pool: PoolState): PoolMeters {
  const globalLimit = (pool.activeAssets * BigInt(pool.maxUtilizationBps)) / BPS
  const areaLimit = (pool.activeAssets * BigInt(pool.maxCellBps)) / BPS
  return {
    total: pool.totalAssets,
    active: pool.activeAssets,
    leaving: pool.totalAssets > pool.activeAssets ? pool.totalAssets - pool.activeAssets : 0n,
    pool: meter(pool.lockedExposure, globalLimit),
    areaLimit,
    areas: pool.areas
      .map((area) => ({ key: area.key, openCover: area.openCover, ...meter(area.exposure, areaLimit) }))
      .sort((a, b) => (a.used === b.used ? 0 : a.used > b.used ? -1 : 1)),
    free: pool.freeAssets,
  }
}
