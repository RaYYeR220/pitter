import { decodeAbiParameters, recoverAddress } from 'viem'
import { generatePrivateKey, privateKeyToAddress } from 'viem/accounts'
import { describe, expect, it } from 'vitest'
import { keyFromLatLon } from '../src/cells'
import { hashReport, reportDomain } from '../src/eip712'
import { aggregateAll, type Verdict } from '../src/weather/aggregate'
import { fetchObservations } from '../src/weather/plan'
import {
  MAX_READINGS_PER_REPORT,
  REPORT_INTERVAL_SECONDS,
  buildReport,
  encodeReport,
  reportAbiParameters,
  sealReports,
  signReport,
} from '../src/weather/report'
import { recordedAt, recordedCell, recordedCells, replayFetch } from './replay'

const NOW = 1791874657 // 06:57:37 UTC
const TO = 1791874620n // 06:57:00 UTC
const warsaw = keyFromLatLon(52.23, 21.01)
const sumburgh = keyFromLatLon(59.88, -1.296)
const bergen = keyFromLatLon(60.39, 5.32)

const verdicts = (entries: [bigint, Verdict][]) => new Map(entries)
const none = new Map<bigint, bigint>()

describe('buildReport', () => {
  it('reports up to the last full minute', () => {
    const { reports } = buildReport([warsaw], none, NOW, { observations: verdicts([[warsaw, 'dry']]) })
    expect(reports).toHaveLength(1)
    expect(reports[0]?.readings[0]?.to).toBe(TO)
    expect(TO % 60n).toBe(0n)
  })

  it('starts a new key one interval back', () => {
    const { reports, skipped } = buildReport([warsaw, sumburgh], none, NOW, {
      observations: verdicts([
        [warsaw, 'dry'],
        [sumburgh, 'wet'],
      ]),
    })
    expect(REPORT_INTERVAL_SECONDS).toBe(300)
    expect(skipped).toEqual([])
    expect(reports).toEqual([
      {
        issuedAt: BigInt(NOW),
        readings: [
          { key: warsaw, from: TO - 300n, to: TO, wetSeconds: 0 },
          { key: sumburgh, from: TO - 300n, to: TO, wetSeconds: 300 },
        ],
      },
    ])
  })

  it('treats a recorded last time of zero as a new key', () => {
    const { reports } = buildReport([warsaw], new Map([[warsaw, 0n]]), NOW, { observations: verdicts([[warsaw, 'wet']]) })
    expect(reports[0]?.readings).toEqual([{ key: warsaw, from: TO - 300n, to: TO, wetSeconds: 300 }])
  })

  it('chains a known key from where its last reading ended', () => {
    const lastTo = new Map([
      [warsaw, TO - 240n],
      [sumburgh, TO - 420n],
    ])
    const { reports } = buildReport([warsaw, sumburgh], lastTo, NOW, {
      observations: verdicts([
        [warsaw, 'wet'],
        [sumburgh, 'dry'],
      ]),
    })
    expect(reports[0]?.readings).toEqual([
      { key: warsaw, from: TO - 240n, to: TO, wetSeconds: 240 },
      { key: sumburgh, from: TO - 420n, to: TO, wetSeconds: 0 },
    ])
  })

  it('never overlaps the previous reading across consecutive runs', () => {
    const observations = verdicts([[warsaw, 'wet']])
    const first = buildReport([warsaw], none, NOW, { observations }).reports[0]!.readings[0]!
    const second = buildReport([warsaw], new Map([[warsaw, first.to]]), NOW + 300, { observations }).reports[0]!.readings[0]!
    const third = buildReport([warsaw], new Map([[warsaw, second.to]]), NOW + 520, { observations }).reports[0]!.readings[0]!
    expect(second.from).toBe(first.to)
    expect(third.from).toBe(second.to)
    expect(second.wetSeconds).toBe(300)
    expect(third.wetSeconds).toBe(Number(third.to - third.from))
    expect(third.to - third.from).toBe(240n)
  })

  it('does not claim rain for an outage it never observed', () => {
    const observations = verdicts([[warsaw, 'wet']])
    const withinLimit = buildReport([warsaw], new Map([[warsaw, TO - 900n]]), NOW, { observations })
    expect(withinLimit.reports[0]?.readings).toEqual([{ key: warsaw, from: TO - 900n, to: TO, wetSeconds: 900 }])

    const afterOutage = buildReport([warsaw], new Map([[warsaw, TO - 7200n]]), NOW, { observations })
    expect(afterOutage.reports[0]?.readings).toEqual([{ key: warsaw, from: TO - 300n, to: TO, wetSeconds: 300 }])

    const custom = buildReport([warsaw], new Map([[warsaw, TO - 1200n]]), NOW, { observations, maxSpanSeconds: 1800 })
    expect(custom.reports[0]?.readings[0]?.wetSeconds).toBe(1200)
  })

  it('writes nothing for a cell without a verdict', () => {
    const { reports, skipped } = buildReport([warsaw, sumburgh, bergen], none, NOW, {
      observations: verdicts([
        [warsaw, 'unknown'],
        [sumburgh, 'wet'],
      ]),
    })
    expect(reports).toHaveLength(1)
    expect(reports[0]?.readings.map((reading) => reading.key)).toEqual([sumburgh])
    expect(skipped).toEqual([
      { key: warsaw, reason: 'no-verdict' },
      { key: bergen, reason: 'no-verdict' },
    ])
  })

  it('writes no report at all when no cell has a verdict', () => {
    const { reports, skipped } = buildReport([warsaw, sumburgh], none, NOW, {
      observations: verdicts([
        [warsaw, 'unknown'],
        [sumburgh, 'unknown'],
      ]),
      heartbeat: true,
    })
    expect(reports).toEqual([])
    expect(skipped).toHaveLength(2)
  })

  it('skips a key that is already reported up to this minute', () => {
    const lastTo = new Map([
      [warsaw, TO],
      [sumburgh, TO + 60n],
      [bergen, TO - 60n],
    ])
    const { reports, skipped } = buildReport([warsaw, sumburgh, bergen], lastTo, NOW, {
      observations: verdicts([
        [warsaw, 'wet'],
        [sumburgh, 'wet'],
        [bergen, 'wet'],
      ]),
    })
    expect(reports[0]?.readings).toEqual([{ key: bergen, from: TO - 60n, to: TO, wetSeconds: 60 }])
    expect(skipped).toEqual([
      { key: warsaw, reason: 'already-reported' },
      { key: sumburgh, reason: 'already-reported' },
    ])
  })

  it('keeps the order of the keys and reports a repeated key once', () => {
    const { reports } = buildReport([sumburgh, warsaw, sumburgh], none, NOW, {
      observations: verdicts([
        [warsaw, 'dry'],
        [sumburgh, 'dry'],
      ]),
    })
    expect(reports[0]?.readings.map((reading) => reading.key)).toEqual([sumburgh, warsaw])
  })

  it('splits more than 20 readings into several reports with increasing issue times', () => {
    expect(MAX_READINGS_PER_REPORT).toBe(20)
    const keys = Array.from({ length: 45 }, (_, i) => keyFromLatLon(50.025 + 0.05 * i, 19.025))
    const observations = verdicts(keys.map((key, i) => [key, i % 2 === 0 ? 'wet' : 'dry']))
    const { reports } = buildReport(keys, none, NOW, { observations })

    expect(reports.map((report) => report.readings.length)).toEqual([20, 20, 5])
    expect(reports.map((report) => report.issuedAt)).toEqual([BigInt(NOW - 2), BigInt(NOW - 1), BigInt(NOW)])
    expect(reports.flatMap((report) => report.readings.map((reading) => reading.key))).toEqual(keys)

    expect(buildReport(keys.slice(0, 20), none, NOW, { observations }).reports).toHaveLength(1)
    expect(buildReport(keys.slice(0, 21), none, NOW, { observations }).reports.map((report) => report.readings.length)).toEqual([20, 1])
    expect(buildReport(keys, none, NOW, { observations, maxReadings: 10 }).reports).toHaveLength(5)
  })

  it('sends an empty report as a heartbeat when asked and there is nothing else to write', () => {
    const observations = verdicts([[warsaw, 'dry']])
    expect(buildReport([], none, NOW, { observations, heartbeat: true }).reports).toEqual([{ issuedAt: BigInt(NOW), readings: [] }])
    expect(buildReport([], none, NOW, { observations }).reports).toEqual([])
    const upToDate = buildReport([warsaw], new Map([[warsaw, TO]]), NOW, { observations, heartbeat: true })
    expect(upToDate.reports).toEqual([{ issuedAt: BigInt(NOW), readings: [] }])
    const withReadings = buildReport([warsaw], none, NOW, { observations, heartbeat: true })
    expect(withReadings.reports).toHaveLength(1)
    expect(withReadings.reports[0]?.readings).toHaveLength(1)
  })

  it('accepts the cell observations of the aggregator directly', async () => {
    const cells = ['sumburgh', 'warsaw', 'manchester', 'aberdeen'].map(recordedCell)
    const { observations } = await fetchObservations(cells, { fetch: replayFetch(), now: recordedAt, userAgent: 'cover-tests/1.0' })
    const { reports } = buildReport(
      cells.map((cell) => cell.key),
      none,
      recordedAt,
      { observations: aggregateAll(cells, observations) },
    )
    expect(reports[0]?.readings.map((reading) => reading.wetSeconds)).toEqual([300, 0, 300, 0])
  })

  it('reports a whole city from the recorded snapshot in chunks, leaving out cells without a quorum', async () => {
    const cells = recordedCells.filter((cell) => cell.name.startsWith('warsaw') || cell.name === 'sumburgh')
    expect(cells.length).toBe(26)
    const run = async (down: ('open-meteo' | 'metar' | 'met-norway')[]) => {
      const { observations } = await fetchObservations(cells, {
        fetch: replayFetch({ down }),
        now: recordedAt,
        userAgent: 'cover-tests/1.0',
        maxRequests: 3,
      })
      return buildReport(
        cells.map((cell) => cell.key),
        none,
        recordedAt,
        { observations: aggregateAll(cells, observations) },
      )
    }

    const healthy = await run([])
    expect(healthy.reports.map((report) => report.readings.length)).toEqual([20, 6])
    expect(healthy.skipped).toEqual([])
    const wet = healthy.reports.flatMap((report) => report.readings).filter((reading) => reading.wetSeconds > 0)
    expect(wet.map((reading) => reading.key)).toEqual([recordedCell('sumburgh').key])

    const modelsDown = await run(['open-meteo'])
    expect(modelsDown.reports).toEqual([])
    expect(modelsDown.skipped).toHaveLength(26)
  })
})

describe('signReport and encodeReport', () => {
  const domain = reportDomain(31337, '0x5FbDB2315678afecb367f032d93F642f64180aa3')
  const readings = [{ key: warsaw, from: 1791873300n, to: 1791873600n, wetSeconds: 300 }]

  it('encodes a report the way the contract decodes it', () => {
    // cast abi-encode "f((uint256,uint64,uint64,uint32)[],uint64,bytes)" "[(18446756288596545460,1791873300,1791873600,300)]" 1791873605 0x1234
    expect(encodeReport(readings, 1791873605n, '0x1234')).toBe(
      '0x0000000000000000000000000000000000000000000000000000000000000060000000000000000000000000000000000000000000000000000000006acdd2450000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000100000b1c00000fb4000000000000000000000000000000000000000000000000000000006acdd114000000000000000000000000000000000000000000000000000000006acdd240000000000000000000000000000000000000000000000000000000000000012c00000000000000000000000000000000000000000000000000000000000000021234000000000000000000000000000000000000000000000000000000000000',
    )
  })

  it('signs the digest the contract computes', async () => {
    const privateKey = generatePrivateKey()
    const signature = signReport(readings, 1791873605n, privateKey, domain)
    const digest = hashReport(readings, 1791873605n, domain)
    expect(digest).toBe('0xa0ce463a81107a512a46ebe24c04fb697749c89ef9e0cd5126b2334546229cf1')
    expect(await recoverAddress({ hash: digest, signature })).toBe(privateKeyToAddress(privateKey))
  })

  it('seals drafts into payloads that carry readings, issue time and signature', async () => {
    const privateKey = generatePrivateKey()
    const keys = Array.from({ length: 23 }, (_, i) => keyFromLatLon(50.025 + 0.05 * i, 19.025))
    const { reports } = buildReport(keys, none, NOW, { observations: verdicts(keys.map((key) => [key, 'wet'])) })
    const sealed = sealReports(reports, privateKey, domain)

    expect(sealed).toHaveLength(2)
    for (const [index, report] of sealed.entries()) {
      const [decodedReadings, issuedAt, signature] = decodeAbiParameters(reportAbiParameters, report.payload)
      expect(decodedReadings).toEqual(reports[index]?.readings)
      expect(issuedAt).toBe(reports[index]?.issuedAt)
      expect(signature).toBe(report.signature)
      expect(report.digest).toBe(hashReport(report.readings, report.issuedAt, domain))
      expect(await recoverAddress({ hash: report.digest, signature })).toBe(privateKeyToAddress(privateKey))
    }
    expect(sealed[0]!.issuedAt).toBeLessThan(sealed[1]!.issuedAt)
  })
})
