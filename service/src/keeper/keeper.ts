import type { Hex } from 'viem'
import { eventsOf } from '../chain/events'
import type { Policy } from '../chain/reader'
import type { Context } from '../context'
import { ServiceError, conflict } from '../http/errors'
import { relayFailure } from '../relay/reverts'
import { NothingToSettle, findSettleable } from '../relay/settleable'
import { readStorm } from '../sandbox/storm'
import type { Reading } from '../types'

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
  settled: Array<{ id: string; paid: string; closed: boolean }>
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
 * due and close the policies whose window is fully reported.
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

  private async settle(): Promise<SettlementOutcome> {
    const { settings, reader, relayer, calls, core, stores } = this.context
    const outcome: SettlementOutcome = { scanned: 0, settled: [], transactions: [], failures: [] }

    const count = await reader.policyCount()
    const cursor = await this.cursor()
    if (cursor > count) return outcome

    const last =
      cursor + BigInt(settings.keeper.scanLimit) - 1n < count ? cursor + BigInt(settings.keeper.scanLimit) - 1n : count
    const ids: bigint[] = []
    for (let id = cursor; id <= last; id++) ids.push(id)

    const policies: Policy[] = []
    for (const page of chunks(ids, POLICY_PAGE)) policies.push(...(await reader.policies(page)))
    outcome.scanned = policies.length

    const firstOpen = policies.find((policy) => !policy.closed)
    const next = firstOpen ? firstOpen.id : last + 1n
    if (next !== cursor) await stores.state.set(CURSOR_KEY, next.toString())

    const due = (await findSettleable(reader, policies)).map((entry) => entry.policy.id)
    for (const batch of chunks(due, settings.keeper.settleBatch)) {
      try {
        const receipt = await relayer.execute(calls.settleMany(batch), {
          before: async () => {
            const still = await findSettleable(reader, await reader.policies(batch))
            if (still.length === 0) throw new NothingToSettle()
          },
        })
        if (receipt.status !== 'success') {
          outcome.failures.push('reverted')
          continue
        }
        outcome.transactions.push(receipt.transactionHash)
        for (const event of eventsOf(
          core.abis.coverBook,
          settings.contracts.coverBook,
          receipt.logs,
          'PolicySettled',
        )) {
          outcome.settled.push({ id: String(event.id), paid: String(event.paid), closed: Boolean(event.closed) })
        }
      } catch (error) {
        if (error instanceof NothingToSettle) continue
        outcome.failures.push(this.describe(error))
      }
    }
    return outcome
  }

  /** First policy id that may still be open. Everything below it is known to be closed. */
  private async cursor(): Promise<bigint> {
    const stored = await this.context.stores.state.get(CURSOR_KEY)
    return typeof stored === 'string' && /^[1-9]\d{0,30}$/.test(stored) ? BigInt(stored) : 1n
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
