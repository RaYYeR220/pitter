import { describe, expect, it } from 'bun:test'
import {
  type HttpResult,
  type Reading,
  type SealedReport,
  type Verdict,
  hashReport,
  keyFromLatLon,
  reportAbiParameters,
  reportDomain,
} from '@cover/core'
import { type ReplayOptions, recordedAt, recordedCell, recordedCells, replay } from '@cover/core/testing'
import { decodeAbiParameters, recoverAddress } from 'viem'
import { generatePrivateKey, privateKeyToAddress } from 'viem/accounts'
import {
  type Effect,
  type Handlers,
  type OracleSettings,
  decodeVerdicts,
  encodeVerdicts,
  gasLimitFor,
  judgeResponses,
  runOracle,
  runOracleSync,
} from '../src/oracle'

const WEATHER_INDEX = '0x5FbDB2315678afecb367f032d93F642f64180aa3'
const TO = BigInt(recordedAt - (recordedAt % 60))

const settings: OracleSettings = {
  chainId: 10143,
  weatherIndex: WEATHER_INDEX,
  userAgent: 'cover-tests/1.0 (unit tests)',
  thresholdMmPerHour: 1,
  intervalSeconds: 300,
  maxHttpRequests: 15,
  heartbeatCell: { lat: 52.23, lon: 21.01 },
  gasLimitBase: 250_000n,
  gasLimitPerReading: 90_000n,
}

type World = {
  activeKeys: bigint[]
  lastTo?: Map<bigint, bigint>
  sources?: ReplayOptions
  rejectFrom?: number
}

function environment(world: World) {
  const reporterKey = generatePrivateKey()
  const calls = { http: [] as string[], lastTo: [] as bigint[][], secrets: 0, logs: [] as string[] }
  const delivered: { report: SealedReport; gasLimit: bigint }[] = []
  const handlers: Handlers<false> = {
    now: () => recordedAt,
    activeCells: () => world.activeKeys,
    observe: (effect) => {
      const results: HttpResult[] = effect.requests.map((request) => replay(request.url, { ...world.sources, calls: calls.http }))
      return judgeResponses(effect.cells, effect.requests, results, effect.now, effect.thresholdMmPerHour)
    },
    lastTo: (keys) => {
      calls.lastTo.push(keys)
      return keys.map((key) => world.lastTo?.get(key) ?? 0n)
    },
    reporterKey: () => {
      calls.secrets++
      return reporterKey
    },
    deliver: (report, gasLimit) => {
      delivered.push({ report, gasLimit })
      const rejected = world.rejectFrom !== undefined && delivered.length > world.rejectFrom
      return rejected ? { accepted: false, txHash: null, detail: 'rejected' } : { accepted: true, txHash: `0x${'ab'.repeat(32)}` }
    },
    log: (message) => calls.logs.push(message),
  }
  return { handlers, calls, delivered, reporter: privateKeyToAddress(reporterKey) }
}

const key = (name: string) => recordedCell(name).key

describe('an oracle run', () => {
  it('reports wet and dry cells with open policies', async () => {
    const env = environment({ activeKeys: [key('sumburgh'), key('warsaw'), key('manchester'), key('aberdeen')] })
    const summary = runOracleSync(settings, env.handlers)

    expect(summary.outcome).toBe('reported')
    expect(summary.verdicts).toEqual(['wet', 'dry', 'wet', 'dry'])
    expect(summary.reports).toEqual([
      { issuedAt: BigInt(recordedAt), readings: 4, wetReadings: 2, accepted: true, txHash: `0x${'ab'.repeat(32)}` },
    ])
    expect(env.delivered).toHaveLength(1)
    const { report, gasLimit } = env.delivered[0]!
    expect(report.readings).toEqual([
      { key: key('sumburgh'), from: TO - 300n, to: TO, wetSeconds: 300 },
      { key: key('warsaw'), from: TO - 300n, to: TO, wetSeconds: 0 },
      { key: key('manchester'), from: TO - 300n, to: TO, wetSeconds: 300 },
      { key: key('aberdeen'), from: TO - 300n, to: TO, wetSeconds: 0 },
    ])
    expect(gasLimit).toBe(250_000n + 4n * 90_000n)

    const [readings, issuedAt, signature] = decodeAbiParameters(reportAbiParameters, report.payload)
    expect(readings as readonly Reading[]).toEqual(report.readings)
    const digest = hashReport(readings as readonly Reading[], issuedAt, reportDomain(settings.chainId, WEATHER_INDEX))
    expect(await recoverAddress({ hash: digest, signature })).toBe(env.reporter)
  })

  it('continues each cell from its last reading', () => {
    const lastTo = new Map([
      [key('sumburgh'), TO - 240n],
      [key('warsaw'), TO - 7200n],
    ])
    const env = environment({ activeKeys: [key('sumburgh'), key('warsaw'), key('manchester')], lastTo })
    runOracleSync(settings, env.handlers)
    expect(env.calls.lastTo).toEqual([[key('sumburgh'), key('warsaw'), key('manchester')]])
    expect(env.delivered[0]?.report.readings).toEqual([
      { key: key('sumburgh'), from: TO - 240n, to: TO, wetSeconds: 240 },
      { key: key('warsaw'), from: TO - 300n, to: TO, wetSeconds: 0 },
      { key: key('manchester'), from: TO - 300n, to: TO, wetSeconds: 300 },
    ])
  })

  it('stays within fifteen HTTP requests for a city of cells and splits the readings into reports of twenty', () => {
    const cells = recordedCells.filter((cell) => cell.name.startsWith('warsaw') || cell.name === 'sumburgh')
    const env = environment({ activeKeys: cells.map((cell) => cell.key) })
    const summary = runOracleSync(settings, env.handlers)

    expect(cells).toHaveLength(26)
    expect(env.calls.http.length).toBeLessThanOrEqual(15)
    expect(summary.httpRequests).toBe(env.calls.http.length)
    expect(summary.outcome).toBe('reported')
    expect(env.delivered.map(({ report }) => report.readings.length)).toEqual([20, 6])
    expect(env.delivered.map(({ gasLimit }) => gasLimit)).toEqual([2_050_000n, 790_000n])
    expect(env.delivered[0]!.report.issuedAt).toBe(BigInt(recordedAt - 1))
    expect(env.delivered[1]!.report.issuedAt).toBe(BigInt(recordedAt))
    expect(env.calls.secrets).toBe(1)
    expect(summary.reports.map((report) => report.wetReadings)).toEqual([1, 0])
  })

  it('keeps delivering the remaining reports when the index rejects one', () => {
    const cells = recordedCells.filter((cell) => cell.name.startsWith('warsaw') || cell.name === 'sumburgh')
    const env = environment({ activeKeys: cells.map((cell) => cell.key), rejectFrom: 0 })
    const summary = runOracleSync(settings, env.handlers)
    expect(env.delivered).toHaveLength(2)
    expect(summary.reports.map((report) => report.accepted)).toEqual([false, false])
    expect(env.calls.logs.filter((line) => line.includes('not delivered: rejected'))).toHaveLength(2)
  })

  it('writes nothing for cells without a quorum but still reports the others', () => {
    // with the forecast models down, Bergen is left with the airport observation alone
    const env = environment({ activeKeys: [key('bergen'), key('sumburgh')], sources: { down: ['open-meteo'] } })
    const summary = runOracleSync(settings, env.handlers)
    expect(summary.verdicts).toEqual(['unknown', 'wet'])
    expect(summary.skipped).toEqual([{ key: key('bergen'), reason: 'no-verdict' }])
    expect(env.calls.lastTo).toEqual([[key('sumburgh')]])
    expect(env.delivered[0]?.report.readings.map((reading) => reading.key)).toEqual([key('sumburgh')])
  })

  it('writes nothing and asks for no key when every source is down', () => {
    const env = environment({
      activeKeys: [key('sumburgh'), key('warsaw')],
      sources: { down: ['open-meteo', 'metar', 'met-norway'] },
    })
    const summary = runOracleSync(settings, env.handlers)
    expect(summary.outcome).toBe('no-quorum')
    expect(summary.verdicts).toEqual(['unknown', 'unknown'])
    expect(summary.skipped).toHaveLength(2)
    expect(env.delivered).toEqual([])
    expect(env.calls.secrets).toBe(0)
    expect(env.calls.lastTo).toEqual([])
    expect(env.calls.logs.join('\n')).toContain('nothing written')
  })

  it('sends an empty report as a heartbeat when no policy is open and the sources answer', () => {
    const env = environment({ activeKeys: [] })
    const summary = runOracleSync(settings, env.handlers)
    expect(summary.outcome).toBe('heartbeat')
    expect(summary.activeCells).toBe(0)
    expect(summary.observedKeys).toEqual([keyFromLatLon(52.23, 21.01)])
    expect(env.calls.http).toHaveLength(3)
    expect(env.delivered).toHaveLength(1)
    expect(env.delivered[0]?.report.readings).toEqual([])
    expect(env.delivered[0]?.gasLimit).toBe(250_000n)
  })

  it('sends no heartbeat when the sources are down', () => {
    const env = environment({ activeKeys: [], sources: { unreachable: ['open-meteo', 'metar', 'met-norway'] } })
    expect(runOracleSync(settings, env.handlers).outcome).toBe('no-quorum')
    expect(env.delivered).toEqual([])
  })

  it('does nothing without open policies when the heartbeat is switched off', () => {
    const env = environment({ activeKeys: [] })
    const summary = runOracleSync({ ...settings, heartbeatCell: null }, env.handlers)
    expect(summary.outcome).toBe('idle')
    expect(env.calls.http).toEqual([])
    expect(env.delivered).toEqual([])
  })

  it('sends only a heartbeat when every cell is already reported up to this minute', () => {
    const env = environment({ activeKeys: [key('warsaw')], lastTo: new Map([[key('warsaw'), TO]]) })
    const summary = runOracleSync(settings, env.handlers)
    expect(summary.outcome).toBe('heartbeat')
    expect(summary.skipped).toEqual([{ key: key('warsaw'), reason: 'already-reported' }])
    expect(env.delivered[0]?.report.readings).toEqual([])
  })

  it('ignores keys of other triggers', () => {
    const otherTrigger = (2n << 64n) | (key('sumburgh') & ((1n << 64n) - 1n))
    const env = environment({ activeKeys: [otherTrigger, key('sumburgh')] })
    const summary = runOracleSync(settings, env.handlers)
    expect(summary.activeCells).toBe(2)
    expect(summary.observedKeys).toEqual([key('sumburgh')])
    expect(env.delivered[0]?.report.readings).toHaveLength(1)
  })

  it('runs the same way when the environment is asynchronous', async () => {
    const world: World = { activeKeys: [key('sumburgh'), key('warsaw'), key('aberdeen')] }
    const sync = environment(world)
    const expected = runOracleSync(settings, sync.handlers)

    const later = environment(world)
    const handlers: Handlers<true> = {
      now: async () => later.handlers.now(),
      activeCells: async () => later.handlers.activeCells(),
      observe: async (effect) => later.handlers.observe(effect),
      lastTo: async (keys) => later.handlers.lastTo(keys),
      reporterKey: async () => later.handlers.reporterKey(),
      deliver: async (report, gasLimit) => later.handlers.deliver(report, gasLimit),
      log: later.handlers.log,
    }
    const summary = await runOracle(settings, handlers)
    expect(summary).toEqual(expected)
    expect(later.delivered.map(({ report }) => report.readings)).toEqual(sync.delivered.map(({ report }) => report.readings))
  })
})

describe('verdict transport', () => {
  it('round-trips verdicts through one character each', () => {
    const verdicts: Verdict[] = ['wet', 'dry', 'unknown', 'dry', 'wet']
    expect(encodeVerdicts(verdicts)).toBe('wdudw')
    expect(decodeVerdicts('wdudw', 5)).toEqual(verdicts)
    expect(decodeVerdicts('', 0)).toEqual([])
  })

  it('rejects a value that does not match the cells it was asked about', () => {
    expect(() => decodeVerdicts('wd', 3)).toThrow('expected 3 verdicts, got 2')
    expect(() => decodeVerdicts('wx', 2)).toThrow('not a verdict code')
  })
})

describe('gas limit', () => {
  it('grows with the number of readings', () => {
    expect(gasLimitFor(settings, 0)).toBe(250_000n)
    expect(gasLimitFor(settings, 1)).toBe(340_000n)
    expect(gasLimitFor(settings, 20)).toBe(2_050_000n)
  })
})

describe('effects', () => {
  it('asks for the reporter key only after there is something to sign', () => {
    const order: Effect['type'][] = []
    const env = environment({ activeKeys: [key('sumburgh')] })
    const traced = new Proxy(env.handlers, {
      get: (target, property: keyof Handlers<false>) => {
        const handler = target[property] as (...args: unknown[]) => unknown
        return (...args: unknown[]) => {
          if (property !== 'log') order.push(property as Effect['type'])
          return handler(...args)
        }
      },
    })
    runOracleSync(settings, traced)
    expect(order).toEqual(['now', 'activeCells', 'observe', 'lastTo', 'reporterKey', 'deliver'])
  })
})
