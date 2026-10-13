import { coverBookAbi, weatherIndexAbi } from '@cover/core/abi'
import {
  decodeAbiParameters,
  decodeFunctionData,
  encodeAbiParameters,
  encodeErrorResult,
  encodeEventTopics,
  recoverAddress,
  parseTransaction,
  type Hex,
  type TransactionSerializedEIP1559,
} from 'viem'
import { beforeEach, describe, expect, it } from 'vitest'
import { coreCells } from '../../src/adapters/core'
import { CRON_SECRET_HEADER, cronTickHandler } from '../../src/keeper/handler'
import { EXPIRE_GAS, submitGas } from '../../src/relayer/gas'
import { selectorOf } from '../../src/relayer/allowlist'
import type { RelayLog } from '../../src/relayer/rpc'
import { writeStorm } from '../../src/sandbox/storm'
import { T0, fakePolicy } from '../helpers/fakes'
import { body, get, harness, post, type Harness } from '../helpers/harness'

const WARSAW = coreCells.keyAt(52.2297, 21.0122)
const CELL_A = (1n << 64n) | (100n << 32n) | 1n
const CELL_B = (1n << 64n) | (100n << 32n) | 2n
const SIMULATOR = (1n << 64n) | (1800n << 32n) | 3600n

const reportParameters = [
  {
    type: 'tuple[]',
    components: [
      { name: 'key', type: 'uint256' },
      { name: 'from', type: 'uint64' },
      { name: 'to', type: 'uint64' },
      { name: 'wetSeconds', type: 'uint32' },
    ],
  },
  { type: 'uint64' },
  { type: 'bytes' },
] as const

function decodeSubmit(data: Hex) {
  const { functionName, args } = decodeFunctionData({ abi: weatherIndexAbi, data })
  expect(functionName).toBe('submit')
  const [readings, issuedAt, signature] = decodeAbiParameters(reportParameters, args![0] as Hex)
  return { readings, issuedAt, signature }
}

function settledLog(h: Harness, id: bigint, paid: bigint, closed: boolean): RelayLog {
  return {
    address: h.settings.contracts.coverBook,
    topics: encodeEventTopics({
      abi: coverBookAbi,
      eventName: 'PolicySettled',
      args: { id, holder: '0x1111111111111111111111111111111111111111' },
    }) as Hex[],
    data: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint64' }, { type: 'bool' }], [paid, BigInt(T0), closed]),
  }
}

describe('keeper tick', () => {
  let h: Harness
  let tick: (headers?: Record<string, string>) => Promise<Response>
  let secret: Record<string, string>

  function start(env: Record<string, string | undefined> = {}) {
    h = harness(env)
    const handler = h.guarded(cronTickHandler(h.context))
    secret = { [CRON_SECRET_HEADER]: h.secrets.cronSecret! }
    tick = (headers = secret) => handler(post('/cron/tick', {}, headers))
    h.reader.oracleState = { heartbeat: T0 - 300, lastIssuedAt: BigInt(T0 - 300) }
  }

  const submits = () => h.rpc.simulated.filter((call) => call.data.startsWith(selectorOf('submit')))
  const settles = () => h.rpc.simulated.filter((call) => call.data.startsWith(selectorOf('settleMany')))

  beforeEach(() => start())

  describe('access', () => {
    it('requires the cron secret', async () => {
      expect((await tick({})).status).toBe(401)
      expect((await tick({ [CRON_SECRET_HEADER]: 'wrong-secret-wrong-secret-wrong' })).status).toBe(401)
      expect((await tick({ authorization: 'Bearer nope' })).status).toBe(401)
      expect(h.rpc.simulated).toHaveLength(0)
      expect(h.weather.observed).toHaveLength(0)
    })

    it('accepts the secret as a header or a bearer token', async () => {
      expect((await tick()).status).toBe(200)
      expect((await tick({ authorization: `Bearer ${h.secrets.cronSecret}` })).status).toBe(200)
    })

    it('accepts the GET a hosted scheduler sends', async () => {
      const handler = h.guarded(cronTickHandler(h.context))

      expect((await handler(get('/cron/tick', secret))).status).toBe(200)
    })

    it('stays closed when no secret is configured', async () => {
      start({ CRON_SECRET: undefined })

      const response = await tick({ [CRON_SECRET_HEADER]: '' })

      expect(response.status).toBe(503)
      expect((await body(response)).error.code).toBe('not_configured')
    })

    it('does not run two ticks at once', async () => {
      h.weather.verdicts.set(WARSAW, false)
      h.rpc.delayMs = 10

      const responses = await Promise.all([tick(), tick()])

      expect(responses.map((response) => response.status).sort()).toEqual([200, 409])
    })
  })

  describe('report', () => {
    it('reports every active cell the sources agreed on, signed by the reporter', async () => {
      h.reader.cells = [CELL_A, CELL_B]
      h.reader.lastToValues.set(CELL_A, BigInt(T0 - 300))
      h.weather.verdicts.set(CELL_A, true).set(CELL_B, false)

      const result = await body(await tick())

      expect(result.report.status).toBe('submitted')
      expect(result.report.readings).toEqual([
        { key: CELL_A.toString(), from: T0 - 300, to: T0, wetSeconds: 300, source: 'weather' },
        { key: CELL_B.toString(), from: T0 - 300, to: T0, wetSeconds: 0, source: 'weather' },
      ])

      const [call] = submits()
      expect(call!.to).toBe(h.settings.contracts.weatherIndex)
      expect(call!.gas).toBe(submitGas({ known: 1, fresh: 1 }))
      const { readings, issuedAt, signature } = decodeSubmit(call!.data)
      expect(readings).toHaveLength(2)
      expect(issuedAt).toBe(BigInt(T0))
      const digest = h.context.core.signing.reportDigest(
        readings.map((reading) => ({ ...reading })),
        issuedAt,
        h.settings.chainId,
        h.settings.contracts.weatherIndex,
      )
      expect(await recoverAddress({ hash: digest, signature })).toBe(h.reporter!.address)
    })

    it('asks the sources about the active cells and the reference cell only', async () => {
      h.reader.cells = [CELL_A]
      h.weather.verdicts.set(CELL_A, true)

      await tick()

      expect(h.weather.observed).toEqual([[CELL_A, WARSAW]])
    })

    it('gives no reading to a cell the sources did not agree on', async () => {
      h.reader.cells = [CELL_A, CELL_B]
      h.weather.verdicts.set(CELL_A, true)

      const result = await body(await tick())

      expect(result.report.readings.map((reading: { key: string }) => reading.key)).toEqual([CELL_A.toString()])
    })

    it('submits nothing when no source answers', async () => {
      h.reader.cells = [CELL_A]

      const result = await body(await tick())

      expect(result.report).toMatchObject({ status: 'skipped', reason: 'no_quorum', transactions: [] })
      expect(submits()).toHaveLength(0)
    })

    it('submits nothing when the sources fail, and keeps the reason to itself', async () => {
      h.reader.cells = [CELL_A]
      h.weather.failure = new Error('GET https://weather.internal.example?key=SECRET timed out')

      const response = await tick()
      const text = await response.text()

      expect(JSON.parse(text).report.reason).toBe('no_quorum')
      expect(text).not.toContain('SECRET')
      expect(submits()).toHaveLength(0)
    })

    it('keeps the heartbeat alive with an empty report while no cell is active', async () => {
      h.weather.verdicts.set(WARSAW, false)

      const result = await body(await tick())

      expect(result.report).toMatchObject({ status: 'submitted', readings: [] })
      const { readings } = decodeSubmit(submits()[0]!.data)
      expect(readings).toHaveLength(0)
      expect(submits()[0]!.gas).toBe(submitGas({ known: 0, fresh: 0 }))
    })

    it('does not repeat an empty report while the heartbeat is fresh', async () => {
      h.weather.verdicts.set(WARSAW, false)
      h.reader.oracleState = { heartbeat: T0 - 30, lastIssuedAt: BigInt(T0 - 30) }

      const result = await body(await tick())

      expect(result.report).toMatchObject({ status: 'skipped', reason: 'up_to_date' })
      expect(submits()).toHaveLength(0)
    })

    it('dates a report after the last accepted one', async () => {
      h.weather.verdicts.set(WARSAW, false)
      h.reader.oracleState = { heartbeat: T0 - 300, lastIssuedAt: BigInt(T0 + 5) }

      await tick()

      expect(decodeSubmit(submits()[0]!.data).issuedAt).toBe(BigInt(T0 + 6))
    })

    it('never dates a reading after the chain clock', async () => {
      h.reader.cells = [CELL_A]
      h.weather.verdicts.set(CELL_A, true)
      h.clock.time = T0 + 500
      h.reader.marketState.head = { number: 1n, timestamp: T0 + 130 }

      await tick()

      const { readings, issuedAt } = decodeSubmit(submits()[0]!.data)
      expect(readings[0]!.to).toBe(BigInt(T0 + 120))
      expect(issuedAt).toBe(BigInt(T0 + 130))
    })

    it('splits a long report and dates the parts in order', async () => {
      start({ KEEPER_MAX_READINGS_PER_REPORT: '2' })
      h.reader.cells = [CELL_A, CELL_B, CELL_B + 1n, CELL_B + 2n, CELL_B + 3n]
      for (const key of h.reader.cells) h.weather.verdicts.set(key, true)

      const result = await body(await tick())

      const reports = submits().map((call) => decodeSubmit(call.data))
      expect(reports.map((report) => report.readings.length)).toEqual([2, 2, 1])
      expect(reports.map((report) => report.issuedAt)).toEqual([BigInt(T0), BigInt(T0 + 1), BigInt(T0 + 2)])
      expect(result.report.transactions).toHaveLength(3)
      expect(result.report.readings).toHaveLength(5)
    })

    it('stops at a report the index would reject and says which rule', async () => {
      h.reader.cells = [CELL_A]
      h.weather.verdicts.set(CELL_A, true)
      h.rpc.revertWith = encodeErrorResult({ abi: weatherIndexAbi, errorName: 'StaleReport' })

      const result = await body(await tick())

      expect(result.report).toMatchObject({ status: 'failed', reason: 'would_revert:StaleReport', readings: [] })
      expect(h.rpc.sent).toHaveLength(0)
    })

    it('only settles when it has no reporter key', async () => {
      start({ REPORTER_PRIVATE_KEY: undefined })
      h.reader.cells = [CELL_A]
      h.weather.verdicts.set(CELL_A, true)

      const result = await body(await tick())

      expect(result.report).toMatchObject({ status: 'skipped', reason: 'no_reporter_key' })
      expect(h.weather.observed).toHaveLength(0)
    })
  })

  describe('simulator cell', () => {
    const sandbox = {
      SANDBOX_ENABLED: 'true',
      SANDBOX_SECRET: 'sandbox-secret-for-tests-01234567',
      SANDBOX_SIMULATOR_KEY: SIMULATOR.toString(),
    }

    it('is reported from the switch and labelled as simulated', async () => {
      start(sandbox)
      h.reader.cells = [CELL_A, SIMULATOR]
      h.weather.verdicts.set(CELL_A, false)
      await writeStorm(h.stores.state, true, T0 - 10)

      const result = await body(await tick())

      expect(result.report.readings).toEqual([
        { key: CELL_A.toString(), from: T0 - 300, to: T0, wetSeconds: 0, source: 'weather' },
        { key: SIMULATOR.toString(), from: T0 - 300, to: T0, wetSeconds: 300, source: 'simulator' },
      ])
      expect(h.weather.observed[0]).not.toContain(SIMULATOR)
    })

    it('is dry until the switch is turned on', async () => {
      start(sandbox)
      h.reader.cells = [SIMULATOR]

      const result = await body(await tick())

      expect(result.report.readings).toEqual([
        { key: SIMULATOR.toString(), from: T0 - 300, to: T0, wetSeconds: 0, source: 'simulator' },
      ])
    })

    it('is an ordinary cell when the sandbox is off', async () => {
      h.reader.cells = [SIMULATOR]
      await writeStorm(h.stores.state, true, T0 - 10)

      const result = await body(await tick())

      expect(h.weather.observed[0]).toContain(SIMULATOR)
      expect(result.report).toMatchObject({ status: 'skipped', reason: 'no_quorum' })
    })
  })

  describe('settlement', () => {
    beforeEach(() => {
      h.weather.verdicts.set(WARSAW, false)
      h.reader.oracleState = { heartbeat: T0 - 30, lastIssuedAt: BigInt(T0 - 30) }
      h.reader.marketState.head = { number: 9n, timestamp: T0 + 900 }
      h.clock.time = T0 + 900
      h.reader.lastToValues.set(CELL_A, BigInt(T0 + 900))
    })

    it('pushes payouts and closes fully reported policies', async () => {
      h.reader.policyRows.set(1n, fakePolicy(1n, { key: CELL_A }))
      h.reader.policyRows.set(2n, fakePolicy(2n, { key: CELL_A, end: T0 + 1_800 }))
      h.reader.policyRows.set(3n, fakePolicy(3n, { key: CELL_B, end: T0 + 1_800 }))
      h.reader.claimableAmounts.set(1n, 600_000n).set(2n, 900_000n)
      h.rpc.logs = [settledLog(h, 1n, 600_000n, true), settledLog(h, 2n, 900_000n, false)]

      const result = await body(await tick())

      expect(settles()).toHaveLength(1)
      expect(decodeFunctionData({ abi: coverBookAbi, data: settles()[0]!.data }).args?.[0]).toEqual([1n, 2n])
      expect(result.settlement).toMatchObject({
        scanned: 3,
        settled: [
          { id: '1', paid: '600000', closed: true },
          { id: '2', paid: '900000', closed: false },
        ],
        failures: [],
      })
    })

    it('sends nothing when nothing is due', async () => {
      h.reader.policyRows.set(1n, fakePolicy(1n, { key: CELL_B, end: T0 + 1_800 }))

      const result = await body(await tick())

      expect(settles()).toHaveLength(0)
      expect(result.settlement).toMatchObject({ scanned: 1, settled: [], transactions: [] })
    })

    it('settles in batches of the configured size', async () => {
      start({ KEEPER_SETTLE_BATCH: '2' })
      h.weather.verdicts.set(WARSAW, false)
      h.reader.oracleState = { heartbeat: T0 - 30, lastIssuedAt: BigInt(T0 - 30) }
      h.reader.marketState.head = { number: 9n, timestamp: T0 + 900 }
      h.clock.time = T0 + 900
      h.reader.lastToValues.set(CELL_A, BigInt(T0 + 900))
      for (let id = 1n; id <= 5n; id++) h.reader.policyRows.set(id, fakePolicy(id, { key: CELL_A }))

      await tick()

      const batches = settles().map((call) => decodeFunctionData({ abi: coverBookAbi, data: call.data }).args?.[0])
      expect(batches).toEqual([[1n, 2n], [3n, 4n], [5n]])
    })

    it('does not look again at the closed policies it has passed', async () => {
      h.reader.policyRows.set(1n, fakePolicy(1n, { key: CELL_A, closed: true }))
      h.reader.policyRows.set(2n, fakePolicy(2n, { key: CELL_A, closed: true }))
      h.reader.policyRows.set(3n, fakePolicy(3n, { key: CELL_B, end: T0 + 1_800 }))
      h.reader.policyRows.set(4n, fakePolicy(4n, { key: CELL_A, closed: true }))

      const first = await body(await tick())
      const second = await body(await tick())

      expect(first.settlement.scanned).toBe(4)
      expect(second.settlement.scanned).toBe(2)
    })

    it('looks at no more policies than the scan limit in one run', async () => {
      start({ KEEPER_SCAN_LIMIT: '3' })
      h.weather.verdicts.set(WARSAW, false)
      h.reader.oracleState = { heartbeat: T0 - 30, lastIssuedAt: BigInt(T0 - 30) }
      for (let id = 1n; id <= 7n; id++) h.reader.policyRows.set(id, fakePolicy(id, { key: CELL_A, closed: true }))

      expect((await body(await tick())).settlement.scanned).toBe(3)
      expect((await body(await tick())).settlement.scanned).toBe(3)
      expect((await body(await tick())).settlement.scanned).toBe(1)
      expect((await body(await tick())).settlement.scanned).toBe(0)
    })

    it('carries on with the next batch when one fails', async () => {
      start({ KEEPER_SETTLE_BATCH: '1' })
      h.weather.verdicts.set(WARSAW, false)
      h.reader.oracleState = { heartbeat: T0 + 880, lastIssuedAt: BigInt(T0 + 880) }
      h.reader.marketState.head = { number: 9n, timestamp: T0 + 900 }
      h.clock.time = T0 + 900
      h.reader.lastToValues.set(CELL_A, BigInt(T0 + 900))
      h.reader.policyRows.set(1n, fakePolicy(1n, { key: CELL_A }))
      h.reader.policyRows.set(2n, fakePolicy(2n, { key: CELL_A }))
      let calls = 0
      const simulate = h.rpc.simulate
      h.rpc.simulate = async (call) => {
        h.rpc.revertWith = ++calls === 1 ? encodeErrorResult({ abi: coverBookAbi, errorName: 'PolicyUnknown' }) : null
        return simulate(call)
      }

      const result = await body(await tick())

      expect(result.settlement.failures).toEqual(['would_revert:PolicyUnknown'])
      expect(result.settlement.transactions).toHaveLength(1)
    })
  })

  describe('expiry', () => {
    const GRACE = 86_400
    const expires = () => h.rpc.simulated.filter((call) => call.data.startsWith(selectorOf('expire')))
    const expiredIds = () =>
      expires().map((call) => decodeFunctionData({ abi: coverBookAbi, data: call.data }).args?.[0] as bigint)

    function at(time: number) {
      h.clock.time = time
      h.reader.marketState.head = { number: 50n, timestamp: time }
      h.reader.oracleState = { heartbeat: time - 30, lastIssuedAt: BigInt(time - 30) }
    }

    /** Closes a policy in the fake book whenever an `expire` for it is sent. */
    function closeOnExpire() {
      h.rpc.onSend = (serialized) => {
        const { data } = parseTransaction(serialized as TransactionSerializedEIP1559)
        if (data?.startsWith(selectorOf('expire'))) {
          const id = decodeFunctionData({ abi: coverBookAbi, data }).args?.[0] as bigint
          h.reader.policyRows.set(id, { ...h.reader.policyRows.get(id)!, closed: true })
        }
        h.rpc.chainNonce++
        return h.rpc.receipt()
      }
    }

    function begin(env: Record<string, string | undefined> = {}) {
      start(env)
      h.weather.verdicts.set(WARSAW, false)
      at(T0 + 600 + GRACE)
    }

    beforeEach(() => begin())

    it('expires a policy the oracle never finished once the grace period is over', async () => {
      h.reader.policyRows.set(1n, fakePolicy(1n, { key: CELL_B }))
      h.rpc.logs = [settledLog(h, 1n, 0n, true)]

      const result = await body(await tick())

      expect(expiredIds()).toEqual([1n])
      expect(expires()[0]).toMatchObject({ to: h.settings.contracts.coverBook, gas: EXPIRE_GAS })
      expect(settles()).toHaveLength(0)
      expect(result.settlement).toMatchObject({ expired: [{ id: '1', paid: '0' }], expirable: 1, failures: [] })
    })

    it('waits for the grace period to pass', async () => {
      at(T0 + 600 + GRACE - 1)
      h.reader.policyRows.set(1n, fakePolicy(1n, { key: CELL_B }))

      const result = await body(await tick())

      expect(expires()).toHaveLength(0)
      expect(result.settlement).toMatchObject({ expired: [], expirable: 0 })
    })

    it('pays what was reported in the same transaction, not in a separate settlement', async () => {
      h.reader.lastToValues.set(CELL_B, BigInt(T0 + 300))
      h.reader.policyRows.set(1n, fakePolicy(1n, { key: CELL_B }))
      h.reader.claimableAmounts.set(1n, 300_000n)
      h.rpc.logs = [settledLog(h, 1n, 300_000n, true)]

      const result = await body(await tick())

      expect(expiredIds()).toEqual([1n])
      expect(settles()).toHaveLength(0)
      expect(result.settlement.expired).toEqual([{ id: '1', paid: '300000' }])
    })

    it('closes a fully reported policy with a settlement, not an expiry', async () => {
      h.reader.lastToValues.set(CELL_A, BigInt(T0 + 600 + GRACE))
      h.reader.policyRows.set(1n, fakePolicy(1n, { key: CELL_A }))

      await tick()

      expect(settles()).toHaveLength(1)
      expect(expires()).toHaveLength(0)
    })

    it('leaves alone a policy whose window is still open', async () => {
      h.reader.policyRows.set(1n, fakePolicy(1n, { key: CELL_B, end: T0 + 1_200 + GRACE }))

      await tick()

      expect(expires()).toHaveLength(0)
    })

    it('expires at most the configured number per tick and catches up on the next', async () => {
      begin({ KEEPER_EXPIRE_PER_TICK: '2' })
      closeOnExpire()
      for (let id = 1n; id <= 5n; id++) h.reader.policyRows.set(id, fakePolicy(id, { key: CELL_B }))

      const first = await body(await tick())
      const afterFirst = expiredIds()
      await tick()
      await tick()

      expect(afterFirst).toEqual([1n, 2n])
      expect(first.settlement.expirable).toBe(5)
      expect(expiredIds()).toEqual([1n, 2n, 3n, 4n, 5n])
    })

    it('can be turned off', async () => {
      begin({ KEEPER_EXPIRE_PER_TICK: '0' })
      h.reader.policyRows.set(1n, fakePolicy(1n, { key: CELL_B }))

      const result = await body(await tick())

      expect(expires()).toHaveLength(0)
      expect(result.settlement.expirable).toBe(1)
    })

    it('sends nothing for a policy someone else closed in the meantime', async () => {
      h.reader.policyRows.set(1n, fakePolicy(1n, { key: CELL_B }))
      const policies = h.reader.policies.bind(h.reader)
      let reads = 0
      h.reader.policies = async (ids) => {
        if (++reads === 2) h.reader.policyRows.set(1n, fakePolicy(1n, { key: CELL_B, closed: true }))
        return policies(ids)
      }

      const result = await body(await tick())

      expect(h.rpc.sent.filter((tx) => tx.includes(selectorOf('expire').slice(2)))).toHaveLength(0)
      expect(result.settlement).toMatchObject({ expired: [], failures: [] })
    })

    it('records a failed expiry and carries on with the next', async () => {
      h.reader.policyRows.set(1n, fakePolicy(1n, { key: CELL_B }))
      h.reader.policyRows.set(2n, fakePolicy(2n, { key: CELL_B }))
      let calls = 0
      const simulate = h.rpc.simulate
      h.rpc.simulate = async (call) => {
        const first = call.data.startsWith(selectorOf('expire')) && ++calls === 1
        h.rpc.revertWith = first ? encodeErrorResult({ abi: coverBookAbi, errorName: 'ExpiryNotReached' }) : null
        return simulate(call)
      }

      const result = await body(await tick())

      expect(result.settlement.failures).toEqual(['would_revert:ExpiryNotReached'])
      expect(result.settlement.transactions).toHaveLength(1)
    })
  })

  describe('scan cursor', () => {
    beforeEach(() => {
      start({ KEEPER_SCAN_LIMIT: '3' })
      h.weather.verdicts.set(WARSAW, false)
      h.reader.oracleState = { heartbeat: T0 + 870, lastIssuedAt: BigInt(T0 + 870) }
      h.reader.marketState.head = { number: 9n, timestamp: T0 + 900 }
      h.clock.time = T0 + 900
      h.reader.lastToValues.set(CELL_A, BigInt(T0 + 900))
    })

    it('does not stall behind a policy that stays open', async () => {
      h.reader.policyRows.set(1n, fakePolicy(1n, { key: CELL_B, end: T0 + 1_800 }))
      for (const id of [2n, 3n, 4n, 5n, 7n]) h.reader.policyRows.set(id, fakePolicy(id, { key: CELL_A, closed: true }))
      h.reader.policyRows.set(6n, fakePolicy(6n, { key: CELL_A }))
      h.reader.claimableAmounts.set(6n, 600_000n)
      h.rpc.logs = [settledLog(h, 6n, 600_000n, true)]

      const ranges = []
      for (let i = 0; i < 4; i++) ranges.push((await body(await tick())).settlement.range)

      expect(ranges).toEqual([
        { from: '1', to: '3' },
        { from: '4', to: '6' },
        { from: '7', to: '7' },
        { from: '1', to: '3' },
      ])
      expect(settles().map((call) => decodeFunctionData({ abi: coverBookAbi, data: call.data }).args?.[0])).toEqual([
        [6n],
      ])
    })

    it('keeps its place in the state store', async () => {
      h.reader.policyRows.set(1n, fakePolicy(1n, { key: CELL_B, end: T0 + 1_800 }))
      for (let id = 2n; id <= 5n; id++) h.reader.policyRows.set(id, fakePolicy(id, { key: CELL_A, closed: true }))

      await tick()

      expect(await h.stores.state.get('keeper:cursor')).toEqual({ low: '1', next: '4' })
    })

    it('moves its low mark past policies that are closed', async () => {
      for (let id = 1n; id <= 4n; id++) h.reader.policyRows.set(id, fakePolicy(id, { key: CELL_A, closed: true }))
      h.reader.policyRows.set(5n, fakePolicy(5n, { key: CELL_B, end: T0 + 1_800 }))

      await tick()
      await tick()

      expect(await h.stores.state.get('keeper:cursor')).toEqual({ low: '5', next: '5' })
    })

    it('continues from a cursor stored by an earlier version', async () => {
      for (let id = 1n; id <= 5n; id++) h.reader.policyRows.set(id, fakePolicy(id, { key: CELL_B, end: T0 + 1_800 }))
      await h.stores.state.set('keeper:cursor', '3')

      const result = await body(await tick())

      expect(result.settlement.range).toEqual({ from: '3', to: '5' })
    })
  })
})
