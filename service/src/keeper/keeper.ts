import type { Hex } from 'viem'
import { eventsOf } from '../chain/events'
import type { Policy } from '../chain/reader'
import type { Context } from '../context'
import { settlementBatches } from '../relayer/gas'
import type { RelayCall, RelayResult } from '../relayer/relayer'
import { ServiceError, conflict } from '../http/errors'
import { relayFailure } from '../relay/reverts'
import { NothingToSettle, findSettleable } from '../relay/settleable'
import { readStorm } from '../sandbox/storm'
import type { Reading } from '../types'
import { advanceCursor, cursorToJson, parseCursor, planScan } from './scan'

const CURSOR_KEY = 'keeper:cursor'
const POLICY_PAGE = 50

/** An empty report only refreshes the heartbeat; one is not worth sending more often than this. */
const HEARTBEAT_MIN_INTERVAL_SECONDS = 120

/** How far ahead of the chain clock the weather index lets a report be dated. */
const MAX_CLOCK_SKEW_SECONDS = 60

export interface ReportedReading {
  key: string
  from: number
  to: number
  wetSeconds: number
  /** `simulator` marks a reading taken from the sandbox switch instead of the weather sources. */
  source: 'weather' | 'simulator'
}

export interface ReportOutcome {
  status: 'submitted' | 'skipped' | 'failed'
  /** Why nothing was submitted, or what went wrong. */
  reason?: string
  readings: ReportedReading[]
  transactions: Hex[]
}

export interface SettlementOutcome {
  /** Policies looked at in this run. */
  scanned: number
  /** The ids looked at, inclusive; null when every policy is known to be closed. */
  range: { from: string; to: string } | null
  settled: Array<{ id: string; paid: string; closed: boolean }>
  /** Policies closed by `expire` because the oracle never reported the end of their window. */
  expired: Array<{ id: string; paid: string }>
  /** Policies in the range that could be expired, including those left for a later tick. */
  expirable: number
  /** The book's oldest-open mark, when this run moved it forward with `syncOldestOpen`. */
  synced: { from: string; to: string } | null
  transactions: Hex[]
  failures: string[]
}

export interface TickOutcome {
  time: number
  report: ReportOutcome
  settlement: SettlementOutcome
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const result: T[][] = []
  for (let i = 0; i < items.length; i += size) result.push(items.slice(i, i + size))
  return result
}

/**
 * One keeper run: report the weather for every cell that has open cover, then push the payouts that became
 * due, close the policies whose window is fully reported, and expire those the oracle never finished.
 *
 * The keeper reports only what the weather sources agreed on. A cell without a verdict gets no reading, and
 * when no source answers at all nothing is submitted, so the heartbeat ages and the book stops selling.
 */
export class Keeper {
  private readonly context: Context
  private running = false

  constructor(context: Context) {
    this.context = context
  }

  async tick(): Promise<TickOutcome> {
    if (this.running) throw conflict('tick_in_progress', 'A keeper run is already in progress')
    this.running = true
    try {
      const report = await this.report()
      const settlement = await this.settle()
      return { time: this.context.now(), report, settlement }
    } finally {
      this.running = false
    }
  }

  private async report(): Promise<ReportOutcome> {
    const { settings, reader, core, reporter, relayer, calls, stores, logger } = this.context
    const outcome: ReportOutcome = { status: 'skipped', readings: [], transactions: [] }
    if (!reporter) return { ...outcome, reason: 'no_reporter_key' }

    const [head, oracle, activeKeys] = await Promise.all([reader.head(), reader.oracle(), reader.activeCells()])
    const time = Math.min(this.context.now(), head.timestamp)
    const lastTo = await reader.lastTo(activeKeys)

    const simulatorKey = settings.sandbox.enabled ? settings.sandbox.simulatorKey : null
    const referenceKey = core.cells.keyAt(settings.keeper.heartbeatCell.lat, settings.keeper.heartbeatCell.lon)
    const realKeys = activeKeys.filter((key) => key !== simulatorKey)

    let observed = new Map<bigint, boolean>()
    try {
      observed = await core.weather.observe([...new Set([...realKeys, referenceKey])], time)
    } catch (error) {
      logger.warn('the weather sources could not be read', { error })
    }

    const verdicts = new Map<bigint, boolean>()
    const simulated = new Set<bigint>()
    for (const key of activeKeys) {
      if (key === simulatorKey) {
        verdicts.set(key, (await readStorm(stores.state)).wet)
        simulated.add(key)
      } else if (observed.has(key)) {
        verdicts.set(key, observed.get(key)!)
      }
    }

    if (observed.size === 0 && simulatorKey === null) return { ...outcome, reason: 'no_quorum' }

    const readings = core.weather
      .buildReadings({ verdicts, lastTo, now: time, firstReadingSeconds: settings.keeper.firstReadingSeconds })
      .filter((reading) => verdicts.has(reading.key) && reading.to <= BigInt(time) && reading.from < reading.to)

    if (readings.length === 0 && head.timestamp - oracle.heartbeat < HEARTBEAT_MIN_INTERVAL_SECONDS) {
      return { ...outcome, reason: 'up_to_date' }
    }

    const parts: Reading[][] = chunks(readings, settings.keeper.maxReadingsPerReport)
    if (parts.length === 0) parts.push([])

    let issuedAt = BigInt(Math.max(time, Number(oracle.lastIssuedAt) + 1))
    for (const part of parts) {
      if (issuedAt > BigInt(head.timestamp + MAX_CLOCK_SKEW_SECONDS)) {
        return { ...outcome, status: 'failed', reason: 'issued_at_ahead_of_chain' }
      }
      const digest = core.signing.reportDigest(part, issuedAt, settings.chainId, settings.contracts.weatherIndex)
      const report = core.signing.encodeReport(part, issuedAt, await reporter.sign({ hash: digest }))
      const fresh = part.filter((reading) => (lastTo.get(reading.key) ?? 0n) === 0n).length

      try {
        const receipt = await relayer.execute(calls.submit(report, { known: part.length - fresh, fresh }))
        if (receipt.status !== 'success') return { ...outcome, status: 'failed', reason: 'reverted' }
        outcome.transactions.push(receipt.transactionHash)
      } catch (error) {
        return { ...outcome, status: 'failed', reason: this.describe(error) }
      }

      outcome.status = 'submitted'
      for (const reading of part) {
        outcome.readings.push({
          key: reading.key.toString(),
          from: Number(reading.from),
          to: Number(reading.to),
          wetSeconds: reading.wetSeconds,
          source: simulated.has(reading.key) ? 'simulator' : 'weather',
        })
      }
      issuedAt += 1n
    }
    return outcome
  }

  /**
   * Reads one stretch of the book (see `ScanCursor`), catches the book's oldest-open mark up with what the
   * keeper knows to be closed, settles what is due there and expires what the oracle never finished. Per tick:
   * at most `KEEPER_SCAN_LIMIT` policies read, one `syncOldestOpen` of at most `KEEPER_SYNC_STEPS`, one
   * `settleMany` per `KEEPER_SETTLE_BATCH` of them (fewer when their closes would not fit one transaction's
   * gas), and at most `KEEPER_EXPIRE_PER_TICK` `expire` transactions.
   */
  private async settle(): Promise<SettlementOutcome> {
    const { settings, reader, calls, stores } = this.context
    const outcome: SettlementOutcome = {
      scanned: 0,
      range: null,
      settled: [],
      expired: [],
      expirable: 0,
      synced: null,
      transactions: [],
      failures: [],
    }

    const count = await reader.policyCount()
    const cursor = parseCursor(await stores.state.get(CURSOR_KEY))
    const scan = planScan(cursor, count, settings.keeper.scanLimit)
    if (!scan) {
      await this.syncOldestOpen(outcome, cursor.low)
      return outcome
    }

    const ids: bigint[] = []
    for (let id = scan.from; id <= scan.to; id++) ids.push(id)
    const policies: Policy[] = []
    for (const page of chunks(ids, POLICY_PAGE)) policies.push(...(await reader.policies(page)))
    outcome.scanned = policies.length
    outcome.range = { from: scan.from.toString(), to: scan.to.toString() }

    const firstOpen = policies.find((policy) => !policy.closed)?.id ?? null
    const next = advanceCursor(cursor, scan, firstOpen, count)
    if (next.low !== cursor.low || next.next !== cursor.next) await stores.state.set(CURSOR_KEY, cursorToJson(next))
    await this.syncOldestOpen(outcome, next.low)

    const [head, grace, settleable] = await Promise.all([
      reader.head(),
      reader.expiryGrace(),
      findSettleable(reader, policies),
    ])
    // A policy the oracle reported to its end is closed by `settleMany`. One whose window ended more than the
    // grace period ago and still is not fully reported is closed by `expire`, which also pays what was reported.
    const closing = new Set(settleable.filter((entry) => entry.closes).map((entry) => entry.policy.id))
    const expirable = policies.filter(
      (policy) => !policy.closed && !closing.has(policy.id) && head.timestamp >= policy.end + grace,
    )
    const expiring = expirable.slice(0, settings.keeper.expirePerTick)
    const expiringIds = new Set(expiring.map((policy) => policy.id))
    outcome.expirable = expirable.length

    const due = settleable.filter((entry) => !expiringIds.has(entry.policy.id))
    for (const batch of settlementBatches(due, (entry) => entry.mayClose, settings.keeper.settleBatch)) {
      const ids = batch.map((entry) => entry.policy.id)
      const closing = batch.filter((entry) => entry.mayClose).length
      const sent = await this.send(outcome, calls.settleMany(ids, closing), async () => {
        const still = await findSettleable(reader, await reader.policies(ids))
        if (still.length === 0) throw new NothingToSettle()
      })
      for (const event of this.settledEvents(sent)) {
        outcome.settled.push({ id: String(event.id), paid: String(event.paid), closed: Boolean(event.closed) })
      }
    }

    for (const policy of expiring) {
      const sent = await this.send(outcome, calls.expire(policy.id), async () => {
        const [current] = await reader.policies([policy.id])
        if (!current || current.closed) throw new NothingToSettle()
      })
      for (const event of this.settledEvents(sent)) {
        outcome.expired.push({ id: String(event.id), paid: String(event.paid) })
      }
    }
    return outcome
  }

  /**
   * Walks the book's `oldestOpenId` up to `low`, the oldest policy the keeper does not know to be closed, when
   * closes out of order have left it behind: each close carries the mark over at most 32 closed policies, and
   * a provider's exit waits until the mark passes the cover sold before the request.
   */
  private async syncOldestOpen(outcome: SettlementOutcome, low: bigint): Promise<void> {
    const { settings, reader, calls } = this.context
    if (settings.keeper.syncSteps < 1) return
    const mark = await reader.oldestOpenId()
    if (mark === null || mark >= low) return

    const lag = low - mark
    const steps = lag < BigInt(settings.keeper.syncSteps) ? Number(lag) : settings.keeper.syncSteps
    const sent = await this.send(outcome, calls.syncOldestOpen(steps), async () => {
      const current = await reader.oldestOpenId()
      if (current === null || current >= low) throw new NothingToSettle()
    })
    if (sent) outcome.synced = { from: mark.toString(), to: String((await reader.oldestOpenId()) ?? mark) }
  }

  /** The `PolicySettled` events of a settlement that was sent. */
  private settledEvents(receipt: RelayResult | null): Array<Record<string, unknown>> {
    if (!receipt) return []
    const { settings, core } = this.context
    return eventsOf(core.abis.coverBook, settings.contracts.coverBook, receipt.logs, 'PolicySettled')
  }

  /** Relays one keeper transaction; null when it was not sent, failed or turned out to be pointless. */
  private async send(
    outcome: SettlementOutcome,
    call: RelayCall,
    before: () => Promise<void>,
  ): Promise<RelayResult | null> {
    const { relayer } = this.context
    try {
      const receipt = await relayer.execute(call, { before })
      if (receipt.status !== 'success') {
        outcome.failures.push('reverted')
        return null
      }
      outcome.transactions.push(receipt.transactionHash)
      return receipt
    } catch (error) {
      if (!(error instanceof NothingToSettle)) outcome.failures.push(this.describe(error))
      return null
    }
  }

  private describe(error: unknown): string {
    const failure = relayFailure(error, this.context.core.abis)
    if (failure instanceof ServiceError) {
      const reason = failure.details?.reason
      return typeof reason === 'string' ? `${failure.code}:${reason}` : failure.code
    }
    this.context.logger.error('keeper step failed', { error })
    return 'internal'
  }
}
