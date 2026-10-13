import { isAddressEqual, type Address, type Hex } from 'viem'
import type { AreaWeather, ChainReader, PolicyRow } from '../chain/reader'
import type { DataOrigin } from '../indexer/gate'

/** One piece of cover a holder bought, with what it has paid so far. */
export interface CoverRecord {
  id: bigint
  key: bigint
  start: number
  end: number
  ratePerSecond: bigint
  premium: bigint
  maxPayout: bigint
  /** Already sent to the holder. */
  paid: bigint
  /** Confirmed by the weather record and not yet sent. */
  confirmed: bigint
  /** How far the cover has been paid out up to, unix seconds. */
  settledUntil: number
  closed: boolean
  /** Hash of the purchase, when the source knows it. */
  purchase: Hex | null
  /** Hash of the latest settlement that paid the holder, when the source knows it. */
  lastPayout?: Hex | null
}

export type CoverPhase = 'upcoming' | 'active' | 'ended' | 'closed'

export function phaseOf(record: Pick<CoverRecord, 'start' | 'end' | 'closed'>, now: number): CoverPhase {
  if (record.closed) return 'closed'
  if (now < record.start) return 'upcoming'
  return now < record.end ? 'active' : 'ended'
}

export interface CoverSnapshot {
  /** Chain time the snapshot was taken at, unix seconds. */
  at: number
  /** Newest first. */
  records: CoverRecord[]
  /** The last weather check of every area the holder has open cover in. */
  weather: ReadonlyMap<bigint, AreaWeather>
  /** Where the records were read from. Absent means the chain, with no indexer configured. */
  origin?: DataOrigin
  /**
   * What the holder has paid and been paid over all of their cover, when the source keeps a running total and
   * may list only the newest records. Absent means `records` is complete and can be summed.
   */
  totals?: { cost: bigint; paid: bigint }
}

/**
 * Where a holder's cover and payouts come from. The app reads through this interface only, so the direct
 * chain reads below can be replaced by an indexer without touching anything above.
 */
export interface CoverHistorySource {
  snapshot(holder: Address): Promise<CoverSnapshot>
  /** Tells the source the hash of a purchase it could not otherwise know. */
  remember?(id: bigint, purchase: Hex): void
}

const PAGE = 100

/**
 * The cover book, mirrored in memory. The book has no index by holder, so the table is read front to back:
 * every row once, and from then on only the rows still open and the ones added since.
 */
export class PolicyTable {
  private readonly reader: Pick<ChainReader, 'policyCount' | 'policies'>
  private readonly rows = new Map<bigint, PolicyRow>()
  private scanned = 0n
  private refreshing: Promise<PolicyRow[]> | null = null

  constructor(reader: Pick<ChainReader, 'policyCount' | 'policies'>) {
    this.reader = reader
  }

  /** Brings the table up to date and returns every row, oldest first. */
  refresh(): Promise<PolicyRow[]> {
    this.refreshing ??= this.load().finally(() => {
      this.refreshing = null
    })
    return this.refreshing
  }

  private async load(): Promise<PolicyRow[]> {
    const count = await this.reader.policyCount()
    const ids: bigint[] = []
    for (const row of this.rows.values()) if (!row.closed) ids.push(row.id)
    for (let id = this.scanned + 1n; id <= count; id++) ids.push(id)

    for (let i = 0; i < ids.length; i += PAGE) {
      for (const row of await this.reader.policies(ids.slice(i, i + PAGE))) this.rows.set(row.id, row)
    }
    if (count > this.scanned) this.scanned = count
    return [...this.rows.values()].sort((a, b) => (a.id < b.id ? -1 : 1))
  }
}

/** `CoverHistorySource` read straight from the contracts in batched calls. */
export class RpcCoverHistorySource implements CoverHistorySource {
  private readonly reader: Pick<ChainReader, 'claimable' | 'weather' | 'balances'>
  private readonly table: PolicyTable
  private readonly purchases = new Map<bigint, Hex>()

  constructor(reader: Pick<ChainReader, 'claimable' | 'weather' | 'balances'>, table: PolicyTable) {
    this.reader = reader
    this.table = table
  }

  remember(id: bigint, purchase: Hex): void {
    this.purchases.set(id, purchase)
  }

  async snapshot(holder: Address): Promise<CoverSnapshot> {
    const mine = (await this.table.refresh()).filter((row) => isAddressEqual(row.holder, holder))
    const records = mine.map(
      (row): CoverRecord => ({
        id: row.id,
        key: row.key,
        start: row.start,
        end: row.end,
        ratePerSecond: row.ratePerSecond,
        premium: row.premium,
        maxPayout: row.maxPayout,
        paid: row.paid,
        confirmed: 0n,
        settledUntil: row.settledUntil,
        closed: row.closed,
        purchase: this.purchases.get(row.id) ?? null,
      }),
    )
    return withLiveReads(this.reader, holder, records)
  }
}

/**
 * Completes a holder's records with what only the chain knows at this moment: the payouts of open cover the
 * weather record has confirmed, the last weather check of their areas, and the chain's clock. Newest first.
 */
export async function withLiveReads(
  reader: Pick<ChainReader, 'claimable' | 'weather' | 'balances'>,
  holder: Address,
  records: readonly CoverRecord[],
): Promise<CoverSnapshot> {
  const open = records.filter((record) => !record.closed)
  const keys = [...new Set(open.map((record) => record.key))]

  const [claimable, weather, { time }] = await Promise.all([
    reader.claimable(open.map((record) => record.id)),
    reader.weather(keys),
    reader.balances(holder),
  ])
  const confirmed = new Map(open.map((record, i) => [record.id, claimable[i] ?? 0n]))

  const completed = records
    .map((record) => ({ ...record, confirmed: confirmed.get(record.id) ?? 0n }))
    .sort((a, b) => (a.start === b.start ? (a.id > b.id ? -1 : 1) : b.start - a.start))

  return { at: time, records: completed, weather }
}

/** The latest end of the holder's cover in one area that has not ended yet; null when there is none. */
export function coveredUntil(snapshot: CoverSnapshot, key: bigint, now: number): number | null {
  let latest: number | null = null
  for (const record of snapshot.records) {
    if (record.key !== key || record.closed || record.end <= now) continue
    if (latest === null || record.end > latest) latest = record.end
  }
  return latest
}
