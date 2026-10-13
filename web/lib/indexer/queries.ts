import type { Address, Hex } from 'viem'
import type { ActivityLine } from '../pool/activity'
import { IndexerError } from './client'
import { big, flag, floatOrNull, hash, int, intOrNull, isRecord, list, record, text } from './parse'

/**
 * The queries the app runs against the indexer (see `indexer/queries.md`), one per screen refresh. Each also
 * asks `_meta` how far the index has got on the chain, so its freshness is checked without a second query.
 */

/** How far the indexer has processed one chain. */
export interface IndexProgress {
  /** Last block whose events are in the index. */
  progressBlock: bigint
  /** False while the indexer is still catching up with the chain from its start block. */
  isReady: boolean
}

/** What an indexer query returned, with how far the index had got when it answered. */
export interface Indexed<T> {
  value: T
  /** Null when the indexer does not index the chain at all. */
  progress: IndexProgress | null
}

const META = `_meta(where: { chainId: { _eq: $chainId } }) { progressBlock isReady }`

function progressOf(data: Record<string, unknown>): IndexProgress | null {
  const rows = list(data._meta, '_meta')
  if (rows.length === 0) return null
  const row = record(rows[0], '_meta[0]')
  return { progressBlock: big(row.progressBlock, '_meta.progressBlock'), isReady: flag(row.isReady, '_meta.isReady') }
}

// --- A holder's cover --------------------------------------------------------------------------------------------

/** Most of a holder's cover one query returns, newest first. Totals cover every policy regardless. */
export const HOLDER_COVER_LIMIT = 200

export const HOLDER_COVER = `query HolderCover($chainId: Int!, $holder: String!, $limit: Int!) {
  ${META}
  Holder_by_pk(chainId: $chainId, id: $holder) { policyCount totalPremiums totalPaid }
  Policy(
    where: { chainId: { _eq: $chainId }, holder_id: { _eq: $holder } }
    order_by: [{ boughtAt: desc }, { start: desc }]
    limit: $limit
  ) {
    id key start end ratePerSecond premium maxPayout paid settledUntil status boughtAt boughtTxHash
    settlements(order_by: { timestamp: asc }) { amount settledUntil closed txHash timestamp }
  }
}`

export interface IndexedSettlement {
  /** Zero when the settled time was dry. */
  amount: bigint
  settledUntil: number
  closed: boolean
  transactionHash: Hex
  timestamp: number
}

export type PolicyStatus = 'OPEN' | 'SETTLED' | 'EXPIRED'

export interface IndexedPolicy {
  id: bigint
  key: bigint
  start: number
  end: number
  ratePerSecond: bigint
  premium: bigint
  maxPayout: bigint
  paid: bigint
  settledUntil: number
  status: PolicyStatus
  boughtAt: number
  purchase: Hex
  /** Oldest first. */
  settlements: IndexedSettlement[]
}

export interface HolderCover {
  /** Every policy of the holder, summed by the indexer; null for an address that never held one. */
  totals: { covers: number; premiums: bigint; paid: bigint } | null
  /** Newest first, at most `HOLDER_COVER_LIMIT`. */
  policies: IndexedPolicy[]
}

const STATUSES = new Set<string>(['OPEN', 'SETTLED', 'EXPIRED'])

function policyOf(value: unknown, at: string): IndexedPolicy {
  const row = record(value, at)
  const status = text(row.status, `${at}.status`)
  if (!STATUSES.has(status)) throw new IndexerError('shape', `${at}.status is ${status}`)
  return {
    id: big(row.id, `${at}.id`),
    key: big(row.key, `${at}.key`),
    start: int(row.start, `${at}.start`),
    end: int(row.end, `${at}.end`),
    ratePerSecond: big(row.ratePerSecond, `${at}.ratePerSecond`),
    premium: big(row.premium, `${at}.premium`),
    maxPayout: big(row.maxPayout, `${at}.maxPayout`),
    paid: big(row.paid, `${at}.paid`),
    settledUntil: int(row.settledUntil, `${at}.settledUntil`),
    status: status as PolicyStatus,
    boughtAt: int(row.boughtAt, `${at}.boughtAt`),
    purchase: hash(row.boughtTxHash, `${at}.boughtTxHash`),
    settlements: list(row.settlements, `${at}.settlements`).map((entry, i) => {
      const settlement = record(entry, `${at}.settlements[${i}]`)
      return {
        amount: big(settlement.amount, `${at}.settlements[${i}].amount`),
        settledUntil: int(settlement.settledUntil, `${at}.settlements[${i}].settledUntil`),
        closed: flag(settlement.closed, `${at}.settlements[${i}].closed`),
        transactionHash: hash(settlement.txHash, `${at}.settlements[${i}].txHash`),
        timestamp: int(settlement.timestamp, `${at}.settlements[${i}].timestamp`),
      }
    }),
  }
}

export function parseHolderCover(data: unknown): Indexed<HolderCover> {
  const root = record(data, 'data')
  const holder = root.Holder_by_pk
  return {
    progress: progressOf(root),
    value: {
      totals: isRecord(holder)
        ? {
            covers: int(holder.policyCount, 'Holder.policyCount'),
            premiums: big(holder.totalPremiums, 'Holder.totalPremiums'),
            paid: big(holder.totalPaid, 'Holder.totalPaid'),
          }
        : null,
      policies: list(root.Policy, 'Policy').map((row, i) => policyOf(row, `Policy[${i}]`)),
    },
  }
}

export function holderCoverVariables(chainId: number, holder: Address) {
  return { chainId, holder: holder.toLowerCase(), limit: HOLDER_COVER_LIMIT }
}

// --- The pool screen ---------------------------------------------------------------------------------------------

/** Days of the daily series one query returns. Days without activity have no row. */
export const POOL_DAYS = 7
/** Latest purchases, settlements and weather readings, each. */
export const POOL_RECENT = 8

export const POOL_SCREEN = `query PoolScreen($chainId: Int!, $days: Int!, $recent: Int!) {
  ${META}
  PoolState_by_pk(chainId: $chainId, id: "pool") {
    policyCount totalPremiums totalFees totalPayouts totalDeposits lossRatio lockedExposure updatedAt
  }
  PoolDay(where: { chainId: { _eq: $chainId } }, order_by: { startsAt: desc }, limit: $days) {
    id startsAt premiums payouts deposits lossRatio
  }
  Cell(where: { chainId: { _eq: $chainId }, openPolicies: { _gt: 0 } }, order_by: { exposure: desc }, limit: 500) {
    id exposure openPolicies lastWetAt lastReadingAt
  }
  Policy(where: { chainId: { _eq: $chainId } }, order_by: [{ boughtAt: desc }, { start: desc }], limit: $recent) {
    id premium boughtAt boughtTxHash
  }
  Settlement(where: { chainId: { _eq: $chainId } }, order_by: { timestamp: desc }, limit: $recent) {
    amount timestamp txHash policy { id }
  }
  WeatherReading(where: { chainId: { _eq: $chainId } }, order_by: { to: desc }, limit: $recent) {
    key wetSeconds to timestamp txHash
  }
}`

export interface IndexedPoolTotals {
  covers: number
  /** Fee included. */
  premiums: bigint
  fees: bigint
  payouts: bigint
  deposits: bigint
  /** payouts / premiums; null before the first premium. */
  lossRatio: number | null
  lockedExposure: bigint
  updatedAt: number
}

export interface IndexedDay {
  /** The UTC date, YYYY-MM-DD. */
  date: string
  startsAt: number
  premiums: bigint
  payouts: bigint
  deposits: bigint
  lossRatio: number | null
}

export interface IndexedArea {
  key: bigint
  exposure: bigint
  openCover: bigint
  /** End of the latest reading that found rain. */
  lastWetAt: number | null
  /** End of the latest reading. */
  lastReadingAt: number | null
}

export interface PoolIndex {
  /** Null until the first event of the pool is indexed. */
  totals: IndexedPoolTotals | null
  /** Newest first; days without activity are missing. */
  days: IndexedDay[]
  /** Areas with open cover, most exposed first. */
  areas: IndexedArea[]
  /** Newest first. */
  activity: ActivityLine[]
}

export function parsePoolScreen(data: unknown, recent = POOL_RECENT): Indexed<PoolIndex> {
  const root = record(data, 'data')
  const state = root.PoolState_by_pk

  const totals: IndexedPoolTotals | null = isRecord(state)
    ? {
        covers: int(state.policyCount, 'PoolState.policyCount'),
        premiums: big(state.totalPremiums, 'PoolState.totalPremiums'),
        fees: big(state.totalFees, 'PoolState.totalFees'),
        payouts: big(state.totalPayouts, 'PoolState.totalPayouts'),
        deposits: big(state.totalDeposits, 'PoolState.totalDeposits'),
        lossRatio: floatOrNull(state.lossRatio, 'PoolState.lossRatio'),
        lockedExposure: big(state.lockedExposure, 'PoolState.lockedExposure'),
        updatedAt: int(state.updatedAt, 'PoolState.updatedAt'),
      }
    : null

  const days = list(root.PoolDay, 'PoolDay').map((value, i): IndexedDay => {
    const row = record(value, `PoolDay[${i}]`)
    return {
      date: text(row.id, `PoolDay[${i}].id`),
      startsAt: int(row.startsAt, `PoolDay[${i}].startsAt`),
      premiums: big(row.premiums, `PoolDay[${i}].premiums`),
      payouts: big(row.payouts, `PoolDay[${i}].payouts`),
      deposits: big(row.deposits, `PoolDay[${i}].deposits`),
      lossRatio: floatOrNull(row.lossRatio, `PoolDay[${i}].lossRatio`),
    }
  })

  const areas = list(root.Cell, 'Cell').map((value, i): IndexedArea => {
    const row = record(value, `Cell[${i}]`)
    return {
      key: big(row.id, `Cell[${i}].id`),
      exposure: big(row.exposure, `Cell[${i}].exposure`),
      openCover: BigInt(int(row.openPolicies, `Cell[${i}].openPolicies`)),
      lastWetAt: intOrNull(row.lastWetAt, `Cell[${i}].lastWetAt`),
      lastReadingAt: intOrNull(row.lastReadingAt, `Cell[${i}].lastReadingAt`),
    }
  })

  const bought = list(root.Policy, 'Policy').map((value, i): ActivityLine => {
    const row = record(value, `Policy[${i}]`)
    return {
      kind: 'bought',
      id: big(row.id, `Policy[${i}].id`),
      amount: big(row.premium, `Policy[${i}].premium`),
      at: int(row.boughtAt, `Policy[${i}].boughtAt`),
      transactionHash: hash(row.boughtTxHash, `Policy[${i}].boughtTxHash`),
    }
  })
  const settled = list(root.Settlement, 'Settlement').map((value, i): ActivityLine => {
    const row = record(value, `Settlement[${i}]`)
    return {
      kind: 'settled',
      id: big(record(row.policy, `Settlement[${i}].policy`).id, `Settlement[${i}].policy.id`),
      amount: big(row.amount, `Settlement[${i}].amount`),
      at: int(row.timestamp, `Settlement[${i}].timestamp`),
      transactionHash: hash(row.txHash, `Settlement[${i}].txHash`),
    }
  })
  const readings = list(root.WeatherReading, 'WeatherReading').map((value, i): ActivityLine => {
    const row = record(value, `WeatherReading[${i}]`)
    return {
      kind: 'weather',
      key: big(row.key, `WeatherReading[${i}].key`),
      wetSeconds: int(row.wetSeconds, `WeatherReading[${i}].wetSeconds`),
      to: int(row.to, `WeatherReading[${i}].to`),
      at: int(row.timestamp, `WeatherReading[${i}].timestamp`),
      transactionHash: hash(row.txHash, `WeatherReading[${i}].txHash`),
    }
  })

  // One list, newest first; a purchase and its weather reading in the same block keep the order they came in.
  const activity = [...bought, ...settled, ...readings]
    .map((line, order) => ({ line, order }))
    .sort((a, b) => (b.line.at ?? 0) - (a.line.at ?? 0) || a.order - b.order)
    .slice(0, recent)
    .map(({ line }) => line)

  return { progress: progressOf(root), value: { totals, days, areas, activity } }
}

export function poolScreenVariables(chainId: number) {
  return { chainId, days: POOL_DAYS, recent: POOL_RECENT }
}
