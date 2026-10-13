import type { Address, Hex } from 'viem'
import { describe, expect, it, vi } from 'vitest'
import type { AreaWeather, PoolState, RecentActivity } from '@/lib/chain/reader'
import type { CoverHistorySource, CoverSnapshot } from '@/lib/cover/history'
import {
  IndexerCoverHistorySource,
  IndexerError,
  IndexerGate,
  createIndexerClient,
  indexLagSeconds,
  parseHolderCover,
  parsePoolScreen,
  poolIndexReader,
  recordsFromIndex,
  reuseFor,
  type Indexed,
  type IndexerClient,
  type PoolIndex,
} from '@/lib/indexer'
import { big, float, int } from '@/lib/indexer/parse'
import { dailySeries, loadActivity, loadPoolView, weatherOfArea } from '@/lib/pool'
import holderFixture from './fixtures/indexer-holder-cover.json'
import poolFixture from './fixtures/indexer-pool-screen.json'

/** Recorded from the hosted indexer: a holder on Monad mainnet with three settled covers, two of them paid. */
const HOLDER: Address = '0x9F6D2520E195F80B84C2bcdb383f8B1118017379'
const URL = 'https://indexer.example/v1/graphql'

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

function clientAnswering(body: unknown, status = 200) {
  const calls: Array<{ url: string; body: { query: string; variables: Record<string, unknown> } }> = []
  const fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) })
    return json(body, status)
  })
  return { client: createIndexerClient(URL, { fetch: fetch as typeof globalThis.fetch }), calls, fetch }
}

describe('the indexer client', () => {
  it('posts the query and its variables and hands the data to the parser', async () => {
    const { client, calls } = clientAnswering({ data: { answer: '42' } })
    const value = await client.query('query Q($n: Int!) { answer }', { n: 1 }, (data) =>
      big((data as { answer: unknown }).answer, 'answer'),
    )
    expect(value).toBe(42n)
    expect(calls).toEqual([{ url: URL, body: { query: 'query Q($n: Int!) { answer }', variables: { n: 1 } } }])
  })

  it('turns every way a read can fail into one error the app falls back on', async () => {
    const kind = async (client: IndexerClient, parse: (data: unknown) => unknown = (data) => data) =>
      client.query('{ x }', {}, parse).then(
        () => 'resolved',
        (error: unknown) => (error instanceof IndexerError ? error.kind : 'other'),
      )

    expect(await kind(clientAnswering({ errors: [{ message: 'field "x" not found' }] }).client)).toBe('graphql')
    expect(await kind(clientAnswering({ error: 'rate limited' }, 429).client)).toBe('http')
    expect(await kind(clientAnswering(['not', 'an', 'object']).client)).toBe('shape')
    expect(await kind(clientAnswering({ data: null }).client)).toBe('shape')
    expect(
      await kind(clientAnswering({ data: { amount: 1.5 } }).client, (data) =>
        big((data as { amount: unknown }).amount, 'amount'),
      ),
    ).toBe('shape')

    const offline = createIndexerClient(URL, {
      fetch: (async () => {
        throw new TypeError('Failed to fetch')
      }) as typeof fetch,
    })
    expect(await kind(offline)).toBe('network')

    const hanging = createIndexerClient(URL, {
      timeoutMs: 20,
      fetch: ((_url: RequestInfo | URL, init?: RequestInit) =>
        new Promise((_resolve, reject) =>
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))),
        )) as typeof fetch,
    })
    expect(await kind(hanging)).toBe('timeout')
  })

  it('reads BigInt columns from strings, Float columns from strings and Int columns from numbers', () => {
    expect(big('18446756288596545460', 'key')).toBe(18446756288596545460n)
    expect(big(7, 'n')).toBe(7n)
    expect(() => big('1e6', 'n')).toThrow(IndexerError)
    expect(() => big(1.5, 'n')).toThrow(IndexerError)
    expect(() => big(null, 'n')).toThrow(IndexerError)
    expect(float('0.730776', 'lossRatio')).toBe(0.730776)
    expect(() => float('', 'lossRatio')).toThrow(IndexerError)
    expect(int(1791890700, 'start')).toBe(1791890700)
    expect(int('60', 'wetSeconds')).toBe(60)
    expect(() => int(1.5, 'start')).toThrow(IndexerError)
  })
})

/** A chain that knows nothing open: the recorded covers are all closed. */
function liveReader(time = 1_791_900_000) {
  const claimable = vi.fn(async (ids: readonly bigint[]) => ids.map(() => 0n))
  return {
    claimable,
    weather: vi.fn(
      async (keys: readonly bigint[]) =>
        new Map<bigint, AreaWeather>(keys.map((key) => [key, { lastCheckedAt: null, raining: false }])),
    ),
    balances: vi.fn(async () => ({ time, dollars: 0n, native: 0n })),
  }
}

const fresh = () => new IndexerGate({ head: async () => 113_048_953n })

describe('a holder’s cover from the indexer', () => {
  it('maps the recorded response to cover records, newest first, with the purchase and the payout on record', () => {
    const { value, progress } = parseHolderCover(holderFixture.data)
    expect(progress).toEqual({ progressBlock: 113_048_953n, isReady: true })
    expect(value.totals).toEqual({ covers: 3, premiums: 73_894n, paid: 54_000n })

    const records = recordsFromIndex(value)
    expect(records.map((record) => [record.id, record.start, record.paid, record.closed])).toEqual([
      [3n, 1_791_890_700, 0n, true],
      [2n, 1_791_889_860, 27_000n, true],
      [1n, 1_791_889_860, 27_000n, true],
    ])
    expect(records[0]).toMatchObject({
      key: 18446756288596545460n,
      ratePerSecond: 55n,
      premium: 6_394n,
      maxPayout: 198_000n,
      settledUntil: 1_791_894_300,
      purchase: '0xca707a0afd31fa8584f110c61ae63498564d29be385c305344c1a004f0709cf2',
      // Its one settlement found the window dry and paid nothing.
      lastPayout: null,
    })
    expect(records[1]!.lastPayout).toBe('0xfe2ef821a04a6fa2ecd0b1f6f5b10700a3708be3912b202dc2b3aaa0fec18f1d')
  })

  it('asks for the holder in lowercase on the configured chain and completes open cover from the chain', async () => {
    const { client, calls } = clientAnswering(holderFixture)
    const reader = liveReader()
    const fallback: CoverHistorySource = { snapshot: vi.fn() }
    const source = new IndexerCoverHistorySource({ client, chainId: 143, gate: fresh(), reader, fallback })

    const snapshot = await source.snapshot(HOLDER)
    expect(calls[0]!.body.variables).toEqual({ chainId: 143, holder: HOLDER.toLowerCase(), limit: 200 })
    expect(snapshot.origin).toBe('indexer')
    expect(snapshot.at).toBe(1_791_900_000)
    expect(snapshot.totals).toEqual({ cost: 73_894n, paid: 54_000n })
    expect(snapshot.records.map((record) => record.id)).toEqual([3n, 2n, 1n])
    expect(reader.claimable).toHaveBeenCalledWith([])
    expect(fallback.snapshot).not.toHaveBeenCalled()
  })
})

describe('the pool from the indexer', () => {
  it('maps the recorded response: totals, the areas with cover and the latest activity, newest first', () => {
    const { value, progress } = parsePoolScreen(poolFixture.data)
    expect(progress).toEqual({ progressBlock: 70_689_818n, isReady: true })
    expect(value.totals).toMatchObject({
      covers: 11,
      premiums: 4_923_000n,
      fees: 246_150n,
      payouts: 3_000_000n,
      deposits: 500_000_000n,
      lossRatio: 0.609384,
    })
    expect(value.areas).toEqual([
      {
        key: 18446751804650688016n,
        exposure: 1_920_000n,
        openCover: 2n,
        lastWetAt: 1_791_896_640,
        lastReadingAt: 1_791_896_700,
      },
    ])
    // The last reading of that area was dry; the one before it was wet.
    expect(weatherOfArea(value.areas[0]!)).toEqual({ lastCheckedAt: 1_791_896_700, raining: false })
    expect(weatherOfArea({ lastWetAt: 1_791_896_700, lastReadingAt: 1_791_896_700 }).raining).toBe(true)
    expect(weatherOfArea({ lastWetAt: null, lastReadingAt: null })).toEqual({ lastCheckedAt: null, raining: false })

    expect(
      value.activity.map((line) =>
        line.kind === 'weather' ? `weather ${line.wetSeconds}` : `${line.kind} ${line.id}`,
      ),
    ).toEqual([
      'weather 0',
      'settled 9',
      'settled 11',
      'settled 10',
      'weather 120',
      'bought 11',
      'weather 0',
      'settled 8',
    ])
    expect(value.activity.map((line) => line.at)).toEqual(
      [...value.activity.map((line) => line.at)].sort((a, b) => b! - a!),
    )
  })

  it('fills the days without activity, newest first', () => {
    const { value } = parsePoolScreen(poolFixture.data)
    const days = dailySeries(value.days, 1_791_896_708, 7)
    expect(days.map((day) => day.date)).toEqual([
      '2026-10-13',
      '2026-10-12',
      '2026-10-11',
      '2026-10-10',
      '2026-10-09',
      '2026-10-08',
      '2026-10-07',
    ])
    expect(days[0]).toEqual({
      date: '2026-10-13',
      startsAt: 1_791_849_600,
      premiums: 4_923_000n,
      payouts: 3_000_000n,
      deposits: 500_000_000n,
      lossRatio: 0.609384,
    })
    expect(days[1]).toMatchObject({ premiums: 0n, payouts: 0n, deposits: 0n, lossRatio: null })
  })
})

const indexed = <T>(value: T, progressBlock = 1_000n, isReady = true): Indexed<T> => ({
  value,
  progress: { progressBlock, isReady },
})

describe('when the indexer is used and when the chain', () => {
  it('measures the lag in blocks of 0.4 seconds against the chain head', () => {
    expect(indexLagSeconds({ progressBlock: 1_000n, isReady: true }, 1_300n)).toBe(120)
    expect(indexLagSeconds({ progressBlock: 1_002n, isReady: true }, 1_000n)).toBe(0)
    expect(indexLagSeconds({ progressBlock: 1_000n, isReady: true }, null)).toBeNull()
  })

  it('uses an index up to two minutes behind and turns down one further behind', async () => {
    const gate = (head: bigint) => new IndexerGate({ head: async () => head })
    expect(await gate(1_300n).read(async () => indexed('index', 1_000n))).toBe('index')
    const behind = gate(1_301n)
    expect(await behind.read(async () => indexed('index', 1_000n))).toBeNull()
    expect(behind.last).toEqual({ verdict: 'behind', lagSeconds: 120.4 })
  })

  it('turns down an index still catching up, or one that does not index this chain', async () => {
    const gate = new IndexerGate({ head: async () => 1_000n })
    expect(await gate.read(async () => indexed('index', 1_000n, false))).toBeNull()
    expect(gate.last?.verdict).toBe('behind')
    const other = new IndexerGate({ head: async () => 1_000n })
    expect(await other.read(async () => ({ value: 'index', progress: null }))).toBeNull()
    expect(other.last?.verdict).toBe('not_indexed')
  })

  it('takes the index at its word when the node cannot say where the head is', async () => {
    const gate = new IndexerGate({
      head: async () => {
        throw new Error('node down')
      },
    })
    expect(await gate.read(async () => indexed('index'))).toBe('index')
  })

  it('leaves a failing indexer alone for a minute, then tries it again', async () => {
    let now = 0
    const gate = new IndexerGate({ head: async () => 1_000n, now: () => now })
    const failing = vi.fn(async (): Promise<Indexed<string>> => {
      throw new IndexerError('http', 'the indexer answered 503')
    })
    expect(await gate.read(failing)).toBeNull()
    expect(gate.last?.verdict).toBe('failed')

    now = 59_999
    const working = vi.fn(async () => indexed('index'))
    expect(await gate.read(working)).toBeNull()
    expect(working).not.toHaveBeenCalled()
    expect(gate.last?.verdict).toBe('cooling_down')

    now = 60_000
    expect(await gate.read(working)).toBe('index')
    expect(working).toHaveBeenCalledOnce()
  })

  it('reads the holder’s cover from the chain when the indexer is turned down, and says so', async () => {
    const { client } = clientAnswering({ errors: [{ message: 'boom' }] })
    const chain: CoverSnapshot = { at: 1, records: [], weather: new Map() }
    const fallback: CoverHistorySource = { snapshot: vi.fn(async () => chain) }
    const source = new IndexerCoverHistorySource({
      client,
      chainId: 143,
      gate: fresh(),
      reader: liveReader(),
      fallback,
    })
    expect(await source.snapshot(HOLDER)).toEqual({ ...chain, origin: 'fallback' })
  })

  it('reads the chain while a purchase made here is not in the index yet', async () => {
    let now = 0
    const { client } = clientAnswering(holderFixture)
    const chain: CoverSnapshot = { at: 1, records: [], weather: new Map() }
    const fallback = { snapshot: vi.fn(async () => chain), remember: vi.fn() }
    const source = new IndexerCoverHistorySource({
      client,
      chainId: 143,
      gate: fresh(),
      reader: liveReader(),
      fallback,
      now: () => now,
    })
    const purchase: Hex = `0x${'ab'.repeat(32)}`

    source.remember(4n, purchase)
    expect(fallback.remember).toHaveBeenCalledWith(4n, purchase)
    expect((await source.snapshot(HOLDER)).origin).toBe('fallback')
    now = 121_000
    expect((await source.snapshot(HOLDER)).origin).toBe('indexer')

    source.remember(3n, purchase)
    expect((await source.snapshot(HOLDER)).origin).toBe('indexer')
  })

  it('reads the pool from the chain alone without an indexer, and from both with one', async () => {
    const chainState = {
      time: 1_791_896_708,
      feeBps: 500,
      areas: [{ key: 1n, exposure: 5n, openCover: 1n }],
    } as PoolState
    const reader = {
      pool: vi.fn(async ({ areas = true }: { areas?: boolean } = {}) => ({
        ...chainState,
        areas: areas ? chainState.areas : [],
      })),
    }
    const policies = { refresh: vi.fn(async () => []) }

    const alone = await loadPoolView({ reader, policies, index: null })
    expect(alone).toMatchObject({ origin: 'chain', days: null, areaWeather: null, state: { areas: chainState.areas } })

    const down = await loadPoolView({ reader, policies, index: async () => null })
    expect(down.origin).toBe('fallback')
    expect(policies.refresh).toHaveBeenCalledTimes(2)

    const { value } = parsePoolScreen(poolFixture.data)
    const both = await loadPoolView({ reader, policies, index: async () => value })
    expect(reader.pool).toHaveBeenLastCalledWith({ areas: false })
    expect(policies.refresh).toHaveBeenCalledTimes(2)
    expect(both.origin).toBe('indexer')
    expect(both.state.areas).toEqual([{ key: 18446751804650688016n, exposure: 1_920_000n, openCover: 2n }])
    expect(both.totals).toEqual({
      covers: 11,
      premiums: 4_923_000n,
      fees: 246_150n,
      payouts: 3_000_000n,
      net: 4_923_000n - 246_150n - 3_000_000n,
    })
    expect(both.days).toHaveLength(7)
    expect(both.areaWeather?.get(18446751804650688016n)).toEqual({ lastCheckedAt: 1_791_896_700, raining: false })
  })

  it('reads the latest activity from the whole index, or from the latest blocks when the indexer is down', async () => {
    const hash: Hex = `0x${'cd'.repeat(32)}`
    const recent: RecentActivity = {
      fromBlock: 1_000n,
      toBlock: 1_499n,
      events: [{ kind: 'bought', id: 7n, holder: HOLDER, amount: 12_000n, blockNumber: 1_200n, transactionHash: hash }],
    }
    const chain = vi.fn(async () => recent)
    const { value } = parsePoolScreen(poolFixture.data)

    expect(await loadActivity({ chain, index: async () => value })).toEqual({
      blocks: null,
      lines: value.activity,
      origin: 'indexer',
    })
    expect(chain).not.toHaveBeenCalled()
    expect(await loadActivity({ chain, index: async () => null })).toEqual({
      blocks: 500,
      lines: [{ kind: 'bought', id: 7n, amount: 12_000n, at: null, transactionHash: hash }],
      origin: 'fallback',
    })
    expect((await loadActivity({ chain, index: null })).origin).toBe('chain')
  })

  it('shares one pool query between the feeds that refresh together', async () => {
    let now = 0
    const { client, fetch } = clientAnswering(poolFixture)
    const read = poolIndexReader(client, 10143, new IndexerGate({ head: async () => 70_689_818n }), {
      now: () => now,
    })
    const [a, b] = await Promise.all([read(), read()])
    expect(a).toBe(b)
    expect((a as PoolIndex).totals?.covers).toBe(11)
    now = 9_999
    await read()
    expect(fetch).toHaveBeenCalledOnce()
    now = 10_000
    await read()
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('does not keep a failed read for the next caller', async () => {
    let calls = 0
    const load = reuseFor(10_000, async () => {
      calls++
      if (calls === 1) throw new Error('first fails')
      return 'second'
    })
    await expect(load()).rejects.toThrow('first fails')
    expect(await load()).toBe('second')
  })
})
