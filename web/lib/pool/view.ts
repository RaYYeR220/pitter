import type { AreaWeather, ChainReader, PoolState } from '../chain/reader'
import type { PolicyTable } from '../cover/history'
import type { DataOrigin } from '../indexer/gate'
import type { IndexedArea, IndexedDay, PoolIndex } from '../indexer/queries'
import { activityFromChain, type LatestActivity } from './activity'
import { poolTotals, type PoolTotals } from './totals'

/** One UTC day of pool activity. */
export interface PoolDay {
  /** YYYY-MM-DD */
  date: string
  startsAt: number
  premiums: bigint
  payouts: bigint
  /** Added by backers. */
  deposits: bigint
  /** payouts / premiums; null on a day without premiums. */
  lossRatio: number | null
}

/** The pool and every sale it has backed. */
export interface PoolView {
  state: PoolState
  totals: PoolTotals
  /** The last days, newest first, days without activity included. Null when read from the chain alone. */
  days: PoolDay[] | null
  /** The last weather check of each area with cover, when the indexer supplied it with the areas. */
  areaWeather: ReadonlyMap<bigint, AreaWeather> | null
  origin: DataOrigin
}

const DAY = 86_400

/** `count` UTC days up to the one holding `now`, newest first, with the days the index has no row for as zeros. */
export function dailySeries(rows: readonly IndexedDay[], now: number, count: number): PoolDay[] {
  const byStart = new Map(rows.map((row) => [row.startsAt, row]))
  const today = Math.floor(now / DAY) * DAY
  return Array.from({ length: count }, (_, i): PoolDay => {
    const startsAt = today - i * DAY
    const row = byStart.get(startsAt)
    return {
      date: new Date(startsAt * 1000).toISOString().slice(0, 10),
      startsAt,
      premiums: row?.premiums ?? 0n,
      payouts: row?.payouts ?? 0n,
      deposits: row?.deposits ?? 0n,
      lossRatio: row?.lossRatio ?? null,
    }
  })
}

/** An area's last weather check, as the indexer keeps it: the latest reading was wet if it is the latest wet one. */
export function weatherOfArea(area: Pick<IndexedArea, 'lastWetAt' | 'lastReadingAt'>): AreaWeather {
  return {
    lastCheckedAt: area.lastReadingAt,
    raining: area.lastReadingAt !== null && area.lastWetAt === area.lastReadingAt,
  }
}

/** Pool totals as the indexer sums them: every policy, fee and payout since the pool opened. */
export function totalsFromIndex(index: PoolIndex): PoolTotals {
  const totals = index.totals
  if (!totals) return { covers: 0, premiums: 0n, fees: 0n, payouts: 0n, net: 0n }
  return {
    covers: totals.covers,
    premiums: totals.premiums,
    fees: totals.fees,
    payouts: totals.payouts,
    net: totals.premiums - totals.fees - totals.payouts,
  }
}

export const SERIES_DAYS = 7

export interface PoolViewSources {
  reader: Pick<ChainReader, 'pool'>
  policies: Pick<PolicyTable, 'refresh'>
  /** The indexer read; null when no indexer is configured. Resolves to null to send the read to the chain. */
  index: (() => Promise<PoolIndex | null>) | null
}

/**
 * The pool screen's figures. Capital and limits always come from the pool contract, which no event carries.
 * Totals, the daily series and the areas come from the indexer when it is fresh, and otherwise from the chain,
 * which means reading every row of the cover book.
 */
export async function loadPoolView({ reader, policies, index }: PoolViewSources): Promise<PoolView> {
  const indexed = index ? await index() : null
  if (indexed) {
    const state = await reader.pool({ areas: false })
    return {
      state: {
        ...state,
        areas: indexed.areas.map((area) => ({ key: area.key, exposure: area.exposure, openCover: area.openCover })),
      },
      totals: totalsFromIndex(indexed),
      days: dailySeries(indexed.days, state.time, SERIES_DAYS),
      areaWeather: new Map(indexed.areas.map((area) => [area.key, weatherOfArea(area)])),
      origin: 'indexer',
    }
  }
  const [state, rows] = await Promise.all([reader.pool(), policies.refresh()])
  return {
    state,
    totals: poolTotals(rows, state.feeBps),
    days: null,
    areaWeather: null,
    origin: index ? 'fallback' : 'chain',
  }
}

export interface ActivitySources {
  /** The chain's most recent blocks, searched for sales and payouts. */
  chain: () => ReturnType<ChainReader['recentActivity']>
  index: (() => Promise<PoolIndex | null>) | null
}

/** The pool's latest activity: from the indexer's whole record when it is fresh, else from the latest blocks. */
export async function loadActivity({ chain, index }: ActivitySources): Promise<LatestActivity> {
  const indexed = index ? await index() : null
  if (indexed) return { blocks: null, lines: indexed.activity, origin: 'indexer' }
  return activityFromChain(await chain(), index ? 'fallback' : 'chain')
}
