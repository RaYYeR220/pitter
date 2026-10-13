import { coverPoolAbi } from '@cover/core/abi'
import { blobReadTypedData } from '@cover/service/blob-auth'
import { encodeAbiParameters, getAbiItem, type PublicClient } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { viemChainReader } from '@/lib/chain/reader'
import { ConfigProblem, configFromHealth, parseHealth, type HealthReport } from '@/lib/config'
import { CoverSelection } from '@/lib/cover/selection'
import { Feed } from '@/lib/feed'
import { createServiceClient } from '@/lib/service/client'
import { ServiceFailure, outcomeUnknown } from '@/lib/service/errors'
import { relayerBand } from '@/lib/server/health'
import { T0 } from './support/market'
import { manualClock } from './support/passkeys'
import { localService } from './support/service'

vi.mock('server-only', () => ({}))

const health: HealthReport = {
  time: T0,
  chainId: 10143,
  contracts: {
    token: '0xDe6fb6D4C560C5901f733D53e591F2A0D6EB1438',
    coverBook: '0x58d970780565E4C064369AD80eEC2D3581d6d75D',
    coverPool: '0xfA7e2510EAadB2BB6316Aac81D0D6Aa51a5f4C56',
    weatherIndex: '0x171CFCBAA60C9AfD267474773122293a67FbeD94',
  },
  relayer: { balance: 'ok' },
  weather: { heartbeat: T0 - 60, ageSeconds: 60, maxAgeSeconds: 1200, fresh: true },
  practice: { enabled: true, simulator: { key: '18446751804650688016', lat: 0.025, lon: 0.025 } },
  paidCover: { enabled: false },
}

describe('the deployment config', () => {
  it('reads a health report and keeps only what it understands', () => {
    const parsed = parseHealth(JSON.parse(JSON.stringify({ ...health, relayer: { balance: 'plenty', key: 'x' } })))
    expect(parsed).toEqual({ ...health, relayer: { balance: 'unknown' } })
    expect(() => parseHealth({ chainId: 10143 })).toThrow(ConfigProblem)
    expect(() => parseHealth({ ...health, contracts: { ...health.contracts, token: 'nope' } })).toThrow('token')
  })

  it('points the browser at the public node and the contracts the server uses', () => {
    const config = configFromHealth(health)
    expect(config).toMatchObject({
      chainId: 10143,
      rpcUrl: 'https://testnet-rpc.monad.xyz',
      contracts: health.contracts,
      practice: { simulator: { key: 18446751804650688016n, lat: 0.025, lon: 0.025 } },
      paidCover: false,
    })
    expect(configFromHealth(health, ' https://node.example/rpc ').rpcUrl).toBe('https://node.example/rpc')
  })

  it('shows no practice tools when the server is not in practice mode, and none on the live network', () => {
    expect(configFromHealth({ ...health, practice: { enabled: false, simulator: null } }).practice).toBeNull()
    expect(configFromHealth({ ...health, chainId: 143 }).practice).toBeNull()
    expect(() => configFromHealth({ ...health, chainId: 1 })).toThrow('not supported')
  })

  it('reports the relayer as running low before it runs out', () => {
    expect(relayerBand(10n, 1n)).toBe('ok')
    expect(relayerBand(2n, 1n)).toBe('low')
    expect(relayerBand(0n, 1n)).toBe('empty')
  })
})

describe('the service client', () => {
  it('turns a refusal into a failure with the service’s code, status and details', async () => {
    const local = await localService(() => T0)
    const error = await local.client
      .quote({ lat: 0, lon: 0, start: T0 + 61, end: T0 + 600, rate: 2000n, holder: '0x000000000000000000000000000000000000dEaD' })
      .catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(ServiceFailure)
    expect(error).toMatchObject({ status: 422, code: 'window_invalid' })
  })

  it('says when no answer came back, and that the outcome is then unknown', async () => {
    const offline = createServiceClient({
      baseUrl: 'http://cover.test/api',
      fetch: async () => {
        throw new TypeError('fetch failed')
      },
    })
    const error = (await offline.relaySettle([1n]).catch((caught: unknown) => caught)) as ServiceFailure
    expect(error).toMatchObject({ status: 0, code: 'network' })
    expect(outcomeUnknown(error)).toBe(true)
    expect(outcomeUnknown(new ServiceFailure(503, 'oracle_stale', 'x'))).toBe(false)
    expect(outcomeUnknown(new ServiceFailure(409, 'in_progress', 'x'))).toBe(true)
  })

  it('gives up on an answer that takes too long', async () => {
    const slow = createServiceClient({
      baseUrl: 'http://cover.test/api',
      timeoutMs: 20,
      fetch: (_input, init) =>
        new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))),
    })
    await expect(slow.health()).rejects.toMatchObject({ code: 'timeout' })
  })

  it('refuses an answer it cannot read rather than guessing', async () => {
    const odd = createServiceClient({
      baseUrl: 'http://cover.test/api',
      fetch: async () => new Response(JSON.stringify({ quote: { holder: 'x' } }), { status: 200 }),
    })
    await expect(
      odd.quote({ lat: 0, lon: 0, start: T0, end: T0 + 60, rate: 1n, holder: '0x000000000000000000000000000000000000dEaD' }),
    ).rejects.toMatchObject({ code: 'bad_response' })
  })

  it('keeps the wait the service asks for', async () => {
    const busy = createServiceClient({
      baseUrl: 'http://cover.test/api',
      fetch: async () =>
        new Response(JSON.stringify({ error: { code: 'rate_limited', message: 'x' } }), {
          status: 429,
          headers: { 'retry-after': '9' },
        }),
    })
    await expect(busy.practiceRain()).rejects.toMatchObject({ code: 'rate_limited', details: { retryAfterSeconds: 9 } })
  })

  it('treats a missing blob as nothing stored', async () => {
    const clock = manualClock()
    const local = await localService(clock.seconds)
    const owner = privateKeyToAccount(generatePrivateKey())
    const issuedAt = clock.seconds()
    const signature = await owner.signTypedData(
      blobReadTypedData(10143, { owner: owner.address, name: 'shiftlog', issuedAt: BigInt(issuedAt) }),
    )
    expect(await local.client.getBlob(owner.address, 'shiftlog', { signature, issuedAt })).toBeNull()
    await expect(
      local.client.getBlob(owner.address, 'shiftlog', { signature: `0x${'11'.repeat(65)}`, issuedAt }),
    ).rejects.toMatchObject({ status: 401 })
  })
})

describe('feeds', () => {
  afterEach(() => vi.useRealTimers())

  it('read while watched, stop when nobody watches, and keep the last good value on failure', async () => {
    vi.useFakeTimers()
    let calls = 0
    let fail = false
    const feed = new Feed(
      async () => {
        calls++
        if (fail) throw new Error('down')
        return calls
      },
      { intervalMs: 1000, now: () => 5 },
    )
    const unsubscribe = feed.subscribe(() => undefined)
    await vi.advanceTimersByTimeAsync(0)
    expect(feed.getState()).toMatchObject({ data: 1, error: null, updatedAt: 5 })

    fail = true
    await vi.advanceTimersByTimeAsync(1000)
    expect(feed.getState()).toMatchObject({ data: 1, loading: false })
    expect(feed.getState().error).toBeInstanceOf(Error)

    unsubscribe()
    await vi.advanceTimersByTimeAsync(5000)
    expect(calls).toBe(2)
  })

  it('fold overlapping reads into one and drop an answer for a forgotten account', async () => {
    let resolve: (value: number) => void = () => undefined
    let calls = 0
    const feed = new Feed(
      () => {
        calls++
        return new Promise<number>((done) => (resolve = done))
      },
      { intervalMs: 60_000 },
    )
    const first = feed.refresh()
    const second = feed.refresh()
    expect(calls).toBe(1)
    feed.clear()
    resolve(42)
    await Promise.all([first, second])
    expect(feed.getState().data).toBeNull()
  })
})

describe('the cover selection', () => {
  it('covers the area around the device, a chosen city or the simulator', async () => {
    const selection = new CoverSelection({
      simulatorKey: 18446751804650688016n,
      geolocation: () => ({
        getCurrentPosition: (ok: PositionCallback) =>
          ok({ coords: { latitude: 52.23, longitude: 21.01, accuracy: 20 } } as GeolocationPosition),
      }),
    })
    const exact = await selection.useLocation()
    expect(exact).toEqual({ lat: 52.23, lon: 21.01, accuracy: 20 })
    expect(selection.getState().area).toMatchObject({ source: 'location', label: 'where you are' })
    expect(selection.getState().area?.lat).not.toBe(52.23)

    selection.chooseCity('Kraków')
    expect(selection.getState().area).toMatchObject({ source: 'city', label: 'central Kraków' })
    selection.chooseCity('Atlantis')
    expect(selection.getState().area?.label).toBe('central Kraków')

    selection.useSimulator()
    expect(selection.getState().area).toMatchObject({ source: 'simulator', key: 18446751804650688016n })
  })

  it('says why the device position cannot be used, and offers no simulator outside practice mode', async () => {
    const selection = new CoverSelection({
      simulatorKey: null,
      geolocation: () => ({
        getCurrentPosition: (_ok: PositionCallback, fail?: PositionErrorCallback | null) =>
          fail?.({ code: 1, message: '', PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 }),
      }),
    })
    expect(await selection.useLocation()).toBeNull()
    expect(selection.getState()).toMatchObject({ problem: 'denied', locating: false, area: null })
    selection.useSimulator()
    expect(selection.getState().area).toBeNull()
    expect(selection.simulatorAvailable).toBe(false)
  })

  it('offers only the payouts on the menu', () => {
    const selection = new CoverSelection({ simulatorKey: null })
    selection.setRate(5000n)
    selection.setRate(123n)
    expect(selection.getState().ratePerSecond).toBe(5000n)
  })
})

describe('the chain reader', () => {
  const config = { chainId: 10143, contracts: health.contracts, multicall3: '0xcA11bde05977b3631167028862bE2a173976CA11' as const }

  function fakeClient(answer: (call: { functionName: string; args?: readonly unknown[] }) => unknown) {
    const calls: Array<{ functionName: string; args?: readonly unknown[] }> = []
    const client = {
      multicall: async ({ contracts }: { contracts: Array<{ functionName: string; args?: readonly unknown[] }> }) =>
        contracts.map((call) => {
          calls.push(call)
          return answer(call)
        }),
    } as unknown as PublicClient
    return { client, calls }
  }

  it('reads a leave request by field name', async () => {
    const outputs = getAbiItem({ abi: coverPoolAbi, name: 'redeemRequests' }).outputs
    const values: Record<string, bigint> = { shares: 7n, assetsAtRequest: 9n, claimableAt: BigInt(T0 + 100) }
    const { client } = fakeClient(({ functionName }) => {
      if (functionName === 'redeemRequests') return outputs.map((output) => values[output.name] ?? 0n)
      if (functionName === 'getCurrentBlockTimestamp') return BigInt(T0)
      return 11n
    })
    const position = await viemChainReader(client, config).position('0x000000000000000000000000000000000000dEaD')
    expect(position.request).toEqual({ shares: 7n, assetsAtRequest: 9n, claimableAt: T0 + 100 })
    expect(encodeAbiParameters(outputs, outputs.map((output) => values[output.name] ?? 0n) as never)).toMatch(/^0x/)
  })

  it('tells areas never checked from dry and wet ones, in two batched requests', async () => {
    const { client, calls } = fakeClient(({ functionName, args }) => {
      if (functionName === 'lastTo') return args?.[0] === 1n ? 0n : BigInt(T0)
      if (functionName === 'wetSeconds') return args?.[0] === 2n ? 60n : 0n
      return 0n
    })
    const weather = await viemChainReader(client, config).weather([1n, 2n, 3n])
    expect([...weather]).toEqual([
      [1n, { lastCheckedAt: null, raining: false }],
      [2n, { lastCheckedAt: T0, raining: true }],
      [3n, { lastCheckedAt: T0, raining: false }],
    ])
    expect(calls.filter((call) => call.functionName === 'wetSeconds').map((call) => call.args)).toEqual([
      [2n, BigInt(T0 - 60), BigInt(T0)],
      [3n, BigInt(T0 - 60), BigInt(T0)],
    ])
  })

  it('searches recent activity in ranges the public node accepts', async () => {
    const ranges: Array<[bigint, bigint]> = []
    const client = {
      getBlockNumber: async () => 1_000n,
      getLogs: async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
        ranges.push([fromBlock, toBlock])
        return []
      },
    } as unknown as PublicClient
    const activity = await viemChainReader(client, config).recentActivity({ chunks: 3, chunkBlocks: 500 })
    expect(ranges).toEqual([
      [901n, 1_000n],
      [801n, 900n],
      [701n, 800n],
    ])
    expect(activity).toMatchObject({ fromBlock: 701n, toBlock: 1_000n, events: [] })
  })
})
