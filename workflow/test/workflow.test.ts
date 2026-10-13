import { describe, expect } from 'bun:test'
import {
  EvmMock,
  HttpActionsMock,
  REPORT_METADATA_HEADER_LENGTH,
  type WriteReportMockInput,
  addContractMock,
  newTestRuntime,
  test,
} from '@chainlink/cre-sdk/test'
import {
  type Reading,
  chains,
  coverBookAbi,
  hashReport,
  keyFromLatLon,
  multicall3Abi,
  reportAbiParameters,
  reportDomain,
  weatherIndexAbi,
} from '@cover/core'
import { type ReplayOptions, recordedAt, recordedCell, recordedCells, replay } from '@cover/core/testing'
import { type Hex, bytesToHex, decodeAbiParameters, decodeFunctionData, encodeFunctionResult, recoverAddress } from 'viem'
import { generatePrivateKey, privateKeyToAddress } from 'viem/accounts'
import mainnetConfig from '../config.mainnet.json'
import testnetConfig from '../config.testnet.json'
import { type Config, LAST_TO_BATCH, REPORTER_KEY_SECRET, configSchema, initWorkflow, onCronTrigger, settingsFromConfig } from '../workflow'

const COVER_BOOK = '0x00000000000000000000000000000000000000b0'
const WEATHER_INDEX = '0x00000000000000000000000000000000000000a0'
const TX_HASH = `0x${'cd'.repeat(32)}` as const
const TO = BigInt(recordedAt - (recordedAt % 60))

const config: Config = { ...configSchema.parse(testnetConfig), coverBook: COVER_BOOK, weatherIndex: WEATHER_INDEX }

type World = {
  activeKeys: bigint[]
  lastTo?: Map<bigint, bigint>
  sources?: ReplayOptions
  receiverReverts?: boolean
  withoutSecret?: boolean
}

function arrange(world: World) {
  const reporterKey = generatePrivateKey()
  const seen = {
    http: [] as { url: string; userAgent: string | undefined; timeout: bigint | undefined; cached: boolean | undefined }[],
    lastToBatches: [] as number[],
    writes: [] as WriteReportMockInput[],
  }

  const http = HttpActionsMock.testInstance()
  http.sendRequest = (request) => {
    seen.http.push({
      url: request.url,
      userAgent: request.multiHeaders['User-Agent']?.values[0],
      timeout: request.timeout?.seconds,
      cached: request.cacheSettings?.store,
    })
    const answer = replay(request.url, world.sources)
    if (answer === null) throw new Error('connection refused')
    return { statusCode: answer.status, body: Buffer.from(answer.body).toString('base64') }
  }

  const evm = EvmMock.testInstance(chains[10143].cre.chainSelector)
  const book = addContractMock(evm, { address: COVER_BOOK, abi: coverBookAbi })
  book.activeCells = () => world.activeKeys

  const multicall = addContractMock(evm, { address: config.multicall3 as Hex, abi: multicall3Abi })
  multicall.aggregate3 = (calls) => {
    const batch = calls as { target: Hex; callData: Hex }[]
    seen.lastToBatches.push(batch.length)
    return batch.map((call) => {
      expect(call.target.toLowerCase()).toBe(WEATHER_INDEX)
      const { functionName, args } = decodeFunctionData({ abi: weatherIndexAbi, data: call.callData })
      expect(functionName).toBe('lastTo')
      const key = (args as readonly [bigint])[0]
      return {
        success: true,
        returnData: encodeFunctionResult({ abi: weatherIndexAbi, functionName: 'lastTo', result: world.lastTo?.get(key) ?? 0n }),
      }
    })
  }

  const index = addContractMock(evm, { address: WEATHER_INDEX, abi: weatherIndexAbi })
  index.writeReport = (input) => {
    seen.writes.push(input)
    return {
      txStatus: 'TX_STATUS_SUCCESS',
      txHash: Buffer.from(TX_HASH.slice(2), 'hex').toString('base64'),
      receiverContractExecutionStatus: world.receiverReverts
        ? 'RECEIVER_CONTRACT_EXECUTION_STATUS_REVERTED'
        : 'RECEIVER_CONTRACT_EXECUTION_STATUS_SUCCESS',
    }
  }

  const secrets = new Map([['main', new Map(world.withoutSecret ? [] : [[REPORTER_KEY_SECRET, reporterKey]])]])
  const runtime = newTestRuntime<Config>(secrets, { timeProvider: () => recordedAt * 1000 + 250 }, config)
  return { runtime, seen, reporter: privateKeyToAddress(reporterKey) }
}

/** The report bytes the index would receive: what follows the forwarder metadata. */
function decodeWrite(write: WriteReportMockInput) {
  const payload = bytesToHex(write.report.rawReport.slice(REPORT_METADATA_HEADER_LENGTH))
  const [readings, issuedAt, signature] = decodeAbiParameters(reportAbiParameters, payload)
  return { readings: readings as readonly Reading[], issuedAt, signature }
}

const key = (name: string) => recordedCell(name).key

describe('weather oracle workflow', () => {
  test('writes signed readings for the cells with open policies', async () => {
    const { runtime, seen, reporter } = arrange({
      activeKeys: [key('sumburgh'), key('warsaw'), key('manchester'), key('aberdeen')],
      lastTo: new Map([[key('warsaw'), TO - 240n]]),
    })

    const result = JSON.parse(onCronTrigger(runtime))

    expect(result).toEqual({
      outcome: 'reported',
      now: recordedAt,
      activeCells: 4,
      observed: 4,
      wet: 2,
      dry: 2,
      unknown: 0,
      httpRequests: seen.http.length,
      reports: [{ issuedAt: String(recordedAt), readings: 4, wetReadings: 2, accepted: true, txHash: TX_HASH }],
    })
    expect(seen.writes).toHaveLength(1)
    const write = seen.writes[0]!
    expect(bytesToHex(write.receiver)).toBe(WEATHER_INDEX)
    expect(write.gasConfig.gasLimit).toBe(250_000n + 4n * 90_000n)

    const { readings, issuedAt, signature } = decodeWrite(write)
    expect(readings).toEqual([
      { key: key('sumburgh'), from: TO - 300n, to: TO, wetSeconds: 300 },
      { key: key('warsaw'), from: TO - 240n, to: TO, wetSeconds: 0 },
      { key: key('manchester'), from: TO - 300n, to: TO, wetSeconds: 300 },
      { key: key('aberdeen'), from: TO - 300n, to: TO, wetSeconds: 0 },
    ])
    expect(issuedAt).toBe(BigInt(recordedAt))
    const digest = hashReport(readings, issuedAt, reportDomain(10143, WEATHER_INDEX))
    expect(await recoverAddress({ hash: digest, signature })).toBe(reporter)
    expect(runtime.getLogs().some((line) => line.startsWith('oracle run: {"outcome":"reported"'))).toBe(true)
  })

  test('identifies itself to the sources, caches their answers and stays within the HTTP limit', () => {
    const cells = recordedCells.filter((cell) => cell.name.startsWith('warsaw') || cell.name === 'sumburgh')
    const { runtime, seen } = arrange({ activeKeys: cells.map((cell) => cell.key) })
    onCronTrigger(runtime)

    expect(seen.http.length).toBe(15)
    expect(seen.http.filter((request) => request.url.includes('api.open-meteo.com'))).toHaveLength(1)
    expect(seen.http.filter((request) => request.url.includes('aviationweather.gov'))).toHaveLength(2)
    for (const request of seen.http) {
      expect(request.timeout).toBe(8n)
      expect(request.cached).toBe(true)
      if (!request.url.includes('api.open-meteo.com')) expect(request.userAgent).toBe(config.userAgent)
    }
  })

  test('reads the last reported times in batches and splits a city into reports of twenty readings', () => {
    const cells = recordedCells.filter((cell) => cell.name.startsWith('warsaw') || cell.name === 'sumburgh')
    const { runtime, seen } = arrange({ activeKeys: cells.map((cell) => cell.key) })
    const result = JSON.parse(onCronTrigger(runtime))

    expect(LAST_TO_BATCH).toBe(20)
    expect(seen.lastToBatches).toEqual([20, 6])
    expect(seen.writes.map((write) => decodeWrite(write).readings.length)).toEqual([20, 6])
    expect(seen.writes.map((write) => write.gasConfig.gasLimit)).toEqual([2_050_000n, 790_000n])
    expect(seen.writes.map((write) => decodeWrite(write).issuedAt)).toEqual([BigInt(recordedAt - 1), BigInt(recordedAt)])
    expect(result.reports.map((report: { wetReadings: number }) => report.wetReadings)).toEqual([1, 0])
  })

  test('writes nothing when no cell has two sources that answer', () => {
    const { runtime, seen } = arrange({
      activeKeys: [key('sumburgh'), key('warsaw')],
      sources: { down: ['open-meteo', 'metar', 'met-norway'], status: 502 },
    })
    const result = JSON.parse(onCronTrigger(runtime))
    expect(result).toMatchObject({ outcome: 'no-quorum', unknown: 2, reports: [] })
    expect(seen.writes).toEqual([])
    expect(seen.lastToBatches).toEqual([])
  })

  test('treats a source it cannot reach as a source without an answer', () => {
    const { runtime, seen } = arrange({ activeKeys: [key('sumburgh'), key('bergen')], sources: { unreachable: ['open-meteo'] } })
    const result = JSON.parse(onCronTrigger(runtime))
    expect(result).toMatchObject({ outcome: 'reported', wet: 1, unknown: 1 })
    expect(decodeWrite(seen.writes[0]!).readings.map((reading) => reading.key)).toEqual([key('sumburgh')])
  })

  test('sends an empty heartbeat report while no policy is open', () => {
    const { runtime, seen } = arrange({ activeKeys: [] })
    const result = JSON.parse(onCronTrigger(runtime))
    expect(result).toMatchObject({ outcome: 'heartbeat', activeCells: 0, observed: 1, dry: 1 })
    expect(seen.http).toHaveLength(3)
    expect(seen.writes).toHaveLength(1)
    expect(decodeWrite(seen.writes[0]!).readings).toEqual([])
    expect(seen.writes[0]!.gasConfig.gasLimit).toBe(250_000n)
    expect(seen.lastToBatches).toEqual([])
  })

  test('reports a delivery the index rejected as not accepted', () => {
    const { runtime } = arrange({ activeKeys: [key('sumburgh')], receiverReverts: true })
    const result = JSON.parse(onCronTrigger(runtime))
    expect(result.reports).toEqual([{ issuedAt: String(recordedAt), readings: 1, wetReadings: 1, accepted: false, txHash: TX_HASH }])
    expect(runtime.getLogs().join('\n')).toContain('not delivered: the index rejected the report')
  })

  test('fails loudly when the reporter key is missing', () => {
    const { runtime, seen } = arrange({ activeKeys: [key('sumburgh')], withoutSecret: true })
    expect(() => onCronTrigger(runtime)).toThrow()
    expect(seen.writes).toEqual([])
  })
})

describe('workflow configuration', () => {
  test('registers one cron trigger on the configured schedule', () => {
    const handlers = initWorkflow(config)
    expect(handlers).toHaveLength(1)
    expect(handlers[0]?.fn).toBe(onCronTrigger)
    expect(JSON.stringify(handlers[0]?.trigger)).toContain(config.schedule)
  })

  test('ships valid configs for both targets', () => {
    const testnet = configSchema.parse(testnetConfig)
    const mainnet = configSchema.parse(mainnetConfig)
    expect(testnet).toMatchObject({ chainSelectorName: chains[10143].cre.chainName, chainId: 10143, isTestnet: true })
    expect(mainnet).toMatchObject({ chainSelectorName: chains[143].cre.chainName, chainId: 143, isTestnet: false })
    for (const shipped of [testnet, mainnet]) {
      expect(shipped.multicall3).toBe(chains[10143].multicall3)
      expect(shipped.maxHttpRequests).toBeLessThanOrEqual(15)
      expect(shipped.schedule.split(' ')).toHaveLength(6)
      expect(shipped.heartbeatCell).not.toBeNull()
    }
  })

  test('takes the contract addresses from the config', () => {
    expect(settingsFromConfig(config)).toMatchObject({
      chainId: 10143,
      weatherIndex: WEATHER_INDEX,
      gasLimitBase: 250_000n,
      gasLimitPerReading: 90_000n,
    })
  })

  test('refuses to run for a chain without recorded or configured addresses', () => {
    const unknownChain = { ...config, chainId: 1, coverBook: '', weatherIndex: '' }
    expect(() => settingsFromConfig(unknownChain)).toThrow('no contract addresses for chain 1')
  })

  test('rejects a config with a malformed address or too many HTTP requests', () => {
    expect(() => configSchema.parse({ ...config, coverBook: '0x1234' })).toThrow()
    expect(() => configSchema.parse({ ...config, maxHttpRequests: 16 })).toThrow()
    expect(() => configSchema.parse({ ...config, userAgent: '' })).toThrow()
  })

  test('observes the heartbeat cell of the shipped config', () => {
    const { runtime, seen } = arrange({ activeKeys: [] })
    onCronTrigger(runtime)
    const heartbeat = recordedCell('warsaw')
    expect(keyFromLatLon(config.heartbeatCell!.lat, config.heartbeatCell!.lon)).toBe(heartbeat.key)
    expect(seen.http[0]?.url).toContain(`latitude=${heartbeat.lat.toFixed(3)}`)
  })
})
