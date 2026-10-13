import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { coverBookAbi, weatherIndexAbi } from '@cover/core'
import { type ReplayOptions, recordedAt, recordedCell, replayFetch } from '@cover/core/testing'
import { generatePrivateKey } from 'viem/accounts'
import { main } from '../scripts/run-local'
import { isLocalRpc } from '../src/local'
import { type LocalChain, localChainAvailable, startLocalChain } from './chain'

// The recorded weather snapshot is replayed as the sources; the chain clock is set around the time it was taken.
const TO = recordedAt - (recordedAt % 60)
const sumburgh = recordedCell('sumburgh').key
const warsaw = recordedCell('warsaw').key
const RATE = 1_000n

const available = await localChainAvailable()
if (!available) console.warn('skipping the local chain tests: they need anvil and the contracts built in contracts/out')

function runner(chain: () => LocalChain) {
  return async (args: string[], options: { now: number; reporterKey?: string; sources?: ReplayOptions }) => {
    const lines: string[] = []
    const { rpcUrl, contracts, reporterKey } = chain()
    const result = await main(['--rpc', rpcUrl, '--cover-book', contracts.coverBook, '--weather-index', contracts.weatherIndex, ...args], {
      env: { REPORTER_KEY: options.reporterKey ?? reporterKey },
      fetch: replayFetch(options.sources),
      print: (line) => lines.push(line),
      now: () => options.now,
    })
    return { result, output: lines.join('\n') }
  }
}

describe.skipIf(!available)('the oracle against a local chain', () => {
  let chain: LocalChain
  const run = runner(() => chain)

  beforeAll(async () => {
    chain = await startLocalChain(TO - 3600)
  }, 60_000)

  afterAll(async () => {
    await chain?.stop()
  })

  it('shows the heartbeat report without sending it by default', async () => {
    const { result, output } = await run([], { now: TO - 570 })
    expect(result.summary.outcome).toBe('heartbeat')
    expect(result.submitted).toBe(false)
    expect(output).toContain('open cells     0')
    expect(output).toContain('0 readings  not sent (dry run)')
    expect(await chain.heartbeat()).toBe(0n)
  })

  it('keeps the index heartbeat fresh while no policy is open', async () => {
    await chain.at(TO - 565)
    const { result, output } = await run(['--submit'], { now: TO - 570 })
    expect(result.summary.reports).toHaveLength(1)
    expect(result.summary.reports[0]?.accepted).toBe(true)
    expect(output).toContain('accepted in 0x')
    expect(await chain.heartbeat()).toBe(BigInt(TO - 570))
  })

  it('lets cover be sold once the heartbeat is fresh', async () => {
    await chain.at(TO - 560)
    expect(await chain.buy(sumburgh, TO - 540, TO + 1260, RATE, 100_000n)).toBe(1n)
    await chain.at(TO - 550)
    expect(await chain.buy(warsaw, TO - 540, TO + 1260, RATE, 100_000n)).toBe(2n)
    const active = await chain.client.readContract({ address: chain.contracts.coverBook, abi: coverBookAbi, functionName: 'activeCells' })
    expect([...active]).toEqual([sumburgh, warsaw])
  })

  it('reports the cells with open policies: rain at Sumburgh, none in Warsaw', async () => {
    await chain.at(recordedAt + 5)
    const { result, output } = await run(['--submit'], { now: recordedAt })

    expect(result.summary).toMatchObject({ outcome: 'reported', activeCells: 2, verdicts: ['wet', 'dry'] })
    expect(result.summary.reports).toEqual([
      { issuedAt: BigInt(recordedAt), readings: 2, wetReadings: 1, accepted: true, txHash: expect.stringMatching(/^0x[0-9a-f]{64}$/) },
    ])
    expect(output).toContain('WET     median 4.8 mm/h  (5 sources)')
    expect(output).toContain('DRY     median 0 mm/h  (5 sources)')

    expect(await chain.lastTo(sumburgh)).toBe(BigInt(TO))
    expect(await chain.lastTo(warsaw)).toBe(BigInt(TO))
    expect(await chain.wetSeconds(sumburgh, BigInt(TO - 300), BigInt(TO))).toBe(300n)
    expect(await chain.wetSeconds(warsaw, BigInt(TO - 300), BigInt(TO))).toBe(0n)
    expect(await chain.heartbeat()).toBe(BigInt(recordedAt))
  })

  it('pays the holder for the confirmed rain when the policy is settled', async () => {
    const before = await chain.balanceOf(chain.accounts.holder)
    for (const id of [1n, 2n]) {
      await chain.send(
        await chain.wallet.writeContract({ account: chain.accounts.stranger, address: chain.contracts.coverBook, abi: coverBookAbi, functionName: 'settle', args: [id] }),
      )
    }
    expect((await chain.balanceOf(chain.accounts.holder)) - before).toBe(300n * RATE)
  })

  it('continues every cell where its last reading ended', async () => {
    await chain.at(recordedAt + 305)
    const { result } = await run(['--submit'], { now: recordedAt + 300 })
    expect(result.reports[0]?.readings).toEqual([
      { key: sumburgh, from: BigInt(TO), to: BigInt(TO + 300), wetSeconds: 300 },
      { key: warsaw, from: BigInt(TO), to: BigInt(TO + 300), wetSeconds: 0 },
    ])
    expect(result.summary.reports[0]?.accepted).toBe(true)
    expect(await chain.lastTo(sumburgh)).toBe(BigInt(TO + 300))
    expect(await chain.wetSeconds(sumburgh, BigInt(TO - 300), BigInt(TO + 300))).toBe(600n)
    expect(await chain.wetSeconds(warsaw, BigInt(TO - 300), BigInt(TO + 300))).toBe(0n)
  })

  it('writes nothing when the sources are down, and the index keeps its state', async () => {
    await chain.at(recordedAt + 400)
    const { result, output } = await run(['--submit'], { now: recordedAt + 395, sources: { down: ['open-meteo', 'metar', 'met-norway'] } })
    expect(result.summary.outcome).toBe('no-quorum')
    expect(result.reports).toEqual([])
    expect(output).toContain('reports        none (no-quorum)')
    expect(await chain.lastTo(sumburgh)).toBe(BigInt(TO + 300))
    expect(await chain.heartbeat()).toBe(BigInt(recordedAt + 300))
  })

  it('is refused by the index when the report is signed by another key', async () => {
    await chain.at(recordedAt + 605)
    const { result, output } = await run(['--submit'], { now: recordedAt + 600, reporterKey: generatePrivateKey() })
    expect(result.summary.reports[0]?.accepted).toBe(false)
    expect(output).toContain('NOT accepted')
    expect(await chain.lastTo(sumburgh)).toBe(BigInt(TO + 300))
  })

  it('produces a payload a forwarder can deliver through onReport, once', async () => {
    const { result } = await run([], { now: recordedAt + 600 })
    const payload = result.reports[0]!.payload
    const onReport = { address: chain.contracts.weatherIndex, abi: weatherIndexAbi, functionName: 'onReport', args: ['0x', payload] } as const

    await expect(chain.client.simulateContract({ ...onReport, account: chain.accounts.stranger })).rejects.toThrow('NotForwarder')

    await chain.at(recordedAt + 615)
    await chain.send(await chain.wallet.writeContract({ ...onReport, account: chain.accounts.forwarder }))
    expect(await chain.lastTo(sumburgh)).toBe(BigInt(TO + 600))
    expect(await chain.wetSeconds(sumburgh, BigInt(TO - 300), BigInt(TO + 600))).toBe(900n)

    await expect(chain.client.simulateContract({ ...onReport, account: chain.accounts.forwarder })).rejects.toThrow('StaleReport')
  })
})

describe('the local runner', () => {
  const sources = { env: {}, fetch: replayFetch(), now: () => recordedAt }

  it('observes chosen cells without a chain and shows what it would write', async () => {
    const lines: string[] = []
    const result = await main(['--cells', '59.88,-1.296;52.23,21.01;60.39,5.32'], { ...sources, print: (line) => lines.push(line) })
    const output = lines.join('\n')

    expect(result.summary.verdicts).toEqual(['wet', 'dry', 'dry'])
    expect(result.reports).toHaveLength(1)
    expect(result.reports[0]?.readings.map((reading) => reading.wetSeconds)).toEqual([300, 0, 0])
    expect(output).toContain('59.875, -1.275  WET     median 4.8 mm/h  (5 sources)')
    expect(output).toContain('open-meteo:gfs_seamless            5.2 mm/h at 2026-10-13T06:45:00Z')
    expect(output).toContain('metar                              10 mm/h at 2026-10-13T06:50:00Z')
    expect(output).toContain('3 readings  not sent (dry run)')
    expect(output).toContain('(throwaway key: set REPORTER_KEY)')
    expect(output).toMatch(/payload {4}0x[0-9a-f]+/)
  })

  it('prints machine-readable output on request', async () => {
    const lines: string[] = []
    await main(['--cells', '52.23,21.01', '--json'], { ...sources, print: (line) => lines.push(line) })
    const parsed = JSON.parse(lines.join('\n'))
    expect(parsed.summary.outcome).toBe('reported')
    expect(parsed.observations[0].verdict).toBe('dry')
    expect(parsed.reports[0].readings[0].wetSeconds).toBe(0)
  })

  it('reports which sources failed', async () => {
    const lines: string[] = []
    const result = await main(['--cells', '59.88,-1.296'], {
      ...sources,
      fetch: replayFetch({ down: ['metar'], status: 500 }),
      print: (line) => lines.push(line),
    })
    expect(result.failures).toHaveLength(1)
    expect(lines.join('\n')).toContain('source failed  metar: status 500')
    expect(result.summary.verdicts).toEqual(['wet'])
  })

  it('only ever submits to a local chain', async () => {
    expect(isLocalRpc('http://127.0.0.1:8545')).toBe(true)
    expect(isLocalRpc('http://localhost:8545/')).toBe(true)
    expect(isLocalRpc('https://testnet-rpc.monad.xyz')).toBe(false)
    expect(isLocalRpc('https://rpc.monad.xyz')).toBe(false)
    expect(isLocalRpc('http://127.0.0.1.example.com')).toBe(false)

    const remote = ['--rpc', 'https://testnet-rpc.monad.xyz', '--cover-book', `0x${'11'.repeat(20)}`, '--weather-index', `0x${'22'.repeat(20)}`, '--submit']
    const environment = { ...sources, env: { REPORTER_KEY: generatePrivateKey() }, print: () => {} }
    await expect(main(remote, environment)).rejects.toThrow('only submits to a local chain')
  })

  it('needs the reporter key to submit and something to observe', async () => {
    const local = ['--rpc', 'http://127.0.0.1:1', '--cover-book', `0x${'11'.repeat(20)}`, '--weather-index', `0x${'22'.repeat(20)}`, '--submit']
    await expect(main(local, { ...sources, print: () => {} })).rejects.toThrow('needs the reporter key')
    await expect(main([], { ...sources, print: () => {} })).rejects.toThrow()
    await expect(main(['--cells', 'north,south'], { ...sources, print: () => {} })).rejects.toThrow('not a "lat,lon" pair')
    await expect(main(['--nope'], { ...sources, print: () => {} })).rejects.toThrow('unknown option --nope')
  })
})
