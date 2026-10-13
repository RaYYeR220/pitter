import { cellFromLatLon, keyFromLatLon } from '@cover/core/cells'
import { describe, expect, it } from 'vitest'
import { ScopeError } from '@/lib/account'
import type { AreaWeather, PolicyRow } from '@/lib/chain/reader'
import { computeAccrual, groupShifts, provisionalOf } from '@/lib/cover/accrual'
import { CITIES, LocationError, areaAt, areaFromKey, areaOf, cityArea, locate } from '@/lib/cover/area'
import {
  PolicyTable,
  RpcCoverHistorySource,
  coveredUntil,
  phaseOf,
  type CoverRecord,
  type CoverSnapshot,
} from '@/lib/cover/history'
import { QuoteMismatch, checkQuote, earliestStart, nextWindow, priceView } from '@/lib/cover/quote'
import { refusal, refusalFrom, type RefusalKind } from '@/lib/cover/refusals'
import { ServiceFailure } from '@/lib/service/errors'
import { COVER_BOOK, T0, fakeMarket } from './support/market'

describe('areas', () => {
  it('are the grid cell around a point, never the point itself', () => {
    const area = areaAt(52.231234, 21.006789, 'location', 'where you are')
    const cell = cellFromLatLon(52.231234, 21.006789)
    expect(area).toMatchObject({ key: keyFromLatLon(52.231234, 21.006789), lat: cell.lat, lon: cell.lon })
    expect(area.lat).not.toBe(52.231234)
    expect(areaFromKey(area.key, 'city', 'x')).toMatchObject({ lat: area.lat, lon: area.lon })
  })

  it('include the simulator area at 0, 0', () => {
    expect(areaAt(0, 0, 'simulator', 'simulator').key).toBe(18446751804650688016n)
  })

  it('offer a list of cities, each in its own area', () => {
    const keys = new Set(CITIES.map((city) => cityArea(city).key))
    expect(keys.size).toBe(CITIES.length)
    expect(cityArea(CITIES[0]!).label).toBe('central Warsaw')
  })

  it('come from the device position', async () => {
    const geolocation = {
      getCurrentPosition: (ok: PositionCallback) =>
        ok({ coords: { latitude: 50.06, longitude: 19.94, accuracy: 30 } } as GeolocationPosition),
    }
    const position = await locate(geolocation)
    expect(position).toEqual({ lat: 50.06, lon: 19.94, accuracy: 30 })
    expect(areaOf(position, 'where you are').key).toBe(keyFromLatLon(50.06, 19.94))
  })

  it('tell a refusal from a device that cannot say', async () => {
    const failing = (code: number) => ({
      getCurrentPosition: (_ok: PositionCallback, fail?: PositionErrorCallback | null) =>
        fail?.({ code, message: '', PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 }),
    })
    await expect(locate(failing(1))).rejects.toMatchObject({ reason: 'denied' })
    await expect(locate(failing(2))).rejects.toMatchObject({ reason: 'unavailable' })
    await expect(locate(failing(3))).rejects.toMatchObject({ reason: 'unavailable' })
    await expect(locate(undefined)).rejects.toBeInstanceOf(LocationError)
  })
})

describe('windows', () => {
  it('start on the first minute that leaves room for the purchase to land', () => {
    expect(earliestStart(T0, 0)).toBe(T0 + 60)
    expect(earliestStart(T0 + 39, 0)).toBe(T0 + 60)
    expect(earliestStart(T0 + 41, 0)).toBe(T0 + 120)
    expect(earliestStart(T0, 600)).toBe(T0 + 660)
  })

  it('follow the paid-up cover without overlap, or report the gap', () => {
    expect(nextWindow(T0, 0, 600, null)).toEqual({ start: T0 + 60, end: T0 + 660, gap: null })
    expect(nextWindow(T0 + 615, 0, 600, T0 + 660)).toEqual({ start: T0 + 660, end: T0 + 1260, gap: null })
    expect(nextWindow(T0 + 700, 0, 600, T0 + 660)).toEqual({
      start: T0 + 720,
      end: T0 + 1320,
      gap: { from: T0 + 660, to: T0 + 720 },
    })
  })
})

describe('checking a quote', () => {
  const request = (holder: `0x${string}`) => ({
    lat: 52.2297,
    lon: 21.0122,
    start: T0 + 60,
    end: T0 + 660,
    rate: 2000n,
    holder,
    key: keyFromLatLon(52.2297, 21.0122),
  })
  const holder = '0x1111111111111111111111111111111111111111'
  const deployment = { chainId: 10143, coverBook: COVER_BOOK }

  it('returns the digest it computed itself', async () => {
    const market = fakeMarket()
    const signed = await market.ports.quote(request(holder))
    expect(checkQuote(signed, request(holder), deployment, T0)).toBe(signed.digest)
  })

  it('refuses a quote for another book or another chain', async () => {
    const market = fakeMarket()
    const signed = await market.ports.quote(request(holder))
    expect(() => checkQuote(signed, request(holder), { ...deployment, chainId: 143 }, T0)).toThrow(QuoteMismatch)
    expect(() =>
      checkQuote(
        signed,
        request(holder),
        { ...deployment, coverBook: '0x0000000000000000000000000000000000000001' },
        T0,
      ),
    ).toThrow('digest')
  })

  it('refuses a quote that has already expired', async () => {
    const market = fakeMarket()
    const signed = await market.ports.quote(request(holder))
    expect(() => checkQuote(signed, request(holder), deployment, Number(signed.quote.expiry))).toThrow('expiry')
  })

  it('lays the price out for showing', async () => {
    const market = fakeMarket()
    const view = priceView(await market.ports.quote(request(holder)))
    expect(view).toMatchObject({
      start: T0 + 60,
      end: T0 + 660,
      seconds: 600,
      premium: 12_000n,
      costPerMinute: 1_200n,
      maxPayout: 1_200_000n,
      expiresAt: T0 + 60,
    })
    expect(view.why).toMatchObject({ loadBps: 2500, floorBps: 100 })
  })
})

describe('refusals', () => {
  const cases: Array<[ServiceFailure, RefusalKind, 'now' | 'later' | 'never']> = [
    [new ServiceFailure(409, 'capacity_exhausted', 'x', { scope: 'cell' }), 'area_full', 'never'],
    [new ServiceFailure(409, 'capacity_exhausted', 'x', { scope: 'pool' }), 'pool_full', 'never'],
    [new ServiceFailure(409, 'would_revert', 'x', { reason: 'CellCapExceeded' }), 'area_full', 'never'],
    [new ServiceFailure(409, 'would_revert', 'x', { reason: 'GlobalCapExceeded' }), 'pool_full', 'never'],
    [new ServiceFailure(409, 'too_many_cells', 'x'), 'no_more_areas', 'never'],
    [new ServiceFailure(503, 'oracle_stale', 'x'), 'weather_silent', 'never'],
    [new ServiceFailure(409, 'would_revert', 'x', { reason: 'OracleStale' }), 'weather_silent', 'never'],
    [new ServiceFailure(409, 'quote_expired', 'x'), 'quote_expired', 'now'],
    [new ServiceFailure(409, 'would_revert', 'x', { reason: 'QuoteExpired' }), 'quote_expired', 'now'],
    [new ServiceFailure(400, 'authorization_expired', 'x'), 'quote_expired', 'now'],
    [new ServiceFailure(409, 'would_revert', 'x', { reason: 'PremiumTooSmall' }), 'too_small', 'never'],
    [new ServiceFailure(422, 'window_invalid', 'x'), 'too_small', 'never'],
    [new ServiceFailure(422, 'window_too_far', 'x'), 'too_far', 'never'],
    [new ServiceFailure(409, 'would_revert', 'x', { reason: 'WindowTooFar' }), 'too_far', 'never'],
    [new ServiceFailure(422, 'window_too_soon', 'x'), 'too_soon', 'now'],
    [new ServiceFailure(422, 'window_too_long', 'x'), 'too_long', 'never'],
    [new ServiceFailure(422, 'policy_too_large', 'x'), 'too_large', 'never'],
    [new ServiceFailure(422, 'rate_too_high', 'x'), 'rate_too_high', 'never'],
    [
      new ServiceFailure(409, 'would_revert', 'x', { reason: 'ERC20InsufficientBalance' }),
      'insufficient_balance',
      'never',
    ],
    [new ServiceFailure(409, 'would_revert', 'x', { reason: 'QuoteUsed' }), 'already_bought', 'never'],
    [new ServiceFailure(503, 'pricing_unavailable', 'x'), 'price_unavailable', 'later'],
    [new ServiceFailure(429, 'rate_limited', 'x'), 'busy', 'later'],
    [new ServiceFailure(503, 'relayer_unfunded', 'x'), 'service_unavailable', 'later'],
    [new ServiceFailure(502, 'rpc_unavailable', 'x'), 'service_unavailable', 'later'],
    [new ServiceFailure(504, 'relay_pending', 'x'), 'pending', 'later'],
    [new ServiceFailure(0, 'network', 'x'), 'network', 'later'],
    [new ServiceFailure(0, 'timeout', 'x'), 'network', 'later'],
    [new ServiceFailure(409, 'reverted', 'x'), 'failed', 'never'],
    [new ServiceFailure(400, 'invalid_request', 'x'), 'invalid', 'never'],
    [new ServiceFailure(409, 'would_revert', 'x', { reason: 'SomethingNew' }), 'failed', 'never'],
    [new ServiceFailure(418, 'teapot', 'x'), 'invalid', 'never'],
    [new ServiceFailure(500, 'internal', 'x'), 'unknown', 'never'],
  ]

  for (const [failure, kind, retry] of cases) {
    it(`${failure.code}${failure.details.reason ? `/${String(failure.details.reason)}` : ''} means ${kind}`, () => {
      const refused = refusalFrom(failure)
      expect(refused).toMatchObject({ kind, retry })
      expect(refused.message.length).toBeGreaterThan(10)
    })
  }

  it('say which ones may have sent a transaction', () => {
    expect(refusalFrom(new ServiceFailure(504, 'relay_pending', 'x')).outcomeUnknown).toBe(true)
    expect(refusalFrom(new ServiceFailure(0, 'network', 'x')).outcomeUnknown).toBe(true)
    expect(refusalFrom(new ServiceFailure(502, 'broadcast_failed', 'x')).outcomeUnknown).toBe(true)
    expect(refusalFrom(new ServiceFailure(503, 'oracle_stale', 'x')).outcomeUnknown).toBe(false)
    expect(
      refusalFrom(new ServiceFailure(409, 'would_revert', 'x', { reason: 'CellCapExceeded' })).outcomeUnknown,
    ).toBe(false)
  })

  it('carry what the service said about waiting, room left and the transaction', () => {
    const capacity = Object.fromEntries(
      [
        'assets',
        'lockedExposure',
        'cellExposure',
        'globalLimit',
        'cellLimit',
        'globalRemaining',
        'cellRemaining',
        'maxPolicyPayout',
        'available',
      ].map((name, i) => [name, String(i)]),
    )
    const hash = `0x${'ab'.repeat(32)}`
    const refused = refusalFrom(
      new ServiceFailure(409, 'capacity_exhausted', 'x', {
        scope: 'cell',
        capacity,
        retryAfterSeconds: 7,
        transactionHash: hash,
      }),
    )
    expect(refused).toMatchObject({ retryAfterSeconds: 7, transactionHash: hash })
    expect(refused.capacity?.available).toBe(8n)
  })

  it('never show the service’s own words, and survive anything thrown', () => {
    const refused = refusalFrom(
      new ServiceFailure(409, 'capacity_exhausted', 'The pool cannot back more cover in this cell'),
    )
    expect(refused.message).not.toMatch(/cell|pool cannot/i)
    expect(refusalFrom(new Error('boom'))).toMatchObject({ kind: 'unknown' })
    expect(refusalFrom(undefined)).toMatchObject({ kind: 'unknown' })
    expect(refusalFrom(new ScopeError({ allowed: false, reason: 'spend_limit' }))).toMatchObject({ kind: 'invalid' })
  })

  it('use none of the words the product never says', () => {
    const banned = /\b(blockchain|wallet|token|usdc|crypto|oracle|gas|policy|claim|cell|transaction|testnet|faucet)\b/i
    const kinds: RefusalKind[] = [
      'area_full',
      'pool_full',
      'no_more_areas',
      'weather_silent',
      'quote_expired',
      'too_small',
      'too_far',
      'too_soon',
      'too_long',
      'too_large',
      'rate_too_high',
      'insufficient_balance',
      'already_bought',
      'price_unavailable',
      'busy',
      'service_unavailable',
      'network',
      'pending',
      'failed',
      'invalid',
      'unknown',
    ]
    for (const kind of kinds) expect(refusal(kind).message, kind).not.toMatch(banned)
  })
})

const HOLDER = '0x1111111111111111111111111111111111111111' as const
const OTHER = '0x2222222222222222222222222222222222222222' as const
const KEY = keyFromLatLon(52.2297, 21.0122)

function row(id: bigint, overrides: Partial<PolicyRow> = {}): PolicyRow {
  return {
    id,
    holder: HOLDER,
    key: KEY,
    start: T0,
    end: T0 + 600,
    ratePerSecond: 2000n,
    premium: 12_000n,
    maxPayout: 1_200_000n,
    paid: 0n,
    settledUntil: T0,
    closed: false,
    ...overrides,
  }
}

function fakeBook(rows: PolicyRow[]) {
  const asked: bigint[][] = []
  return {
    rows,
    asked,
    policyCount: async () => BigInt(rows.length),
    policies: async (ids: readonly bigint[]) => {
      asked.push([...ids])
      return ids.map((id) => rows[Number(id) - 1]!)
    },
    claimable: async (ids: readonly bigint[]) => ids.map((id) => (id === 2n ? 60_000n : 0n)),
    weather: async (keys: readonly bigint[]) =>
      new Map<bigint, AreaWeather>(keys.map((key) => [key, { lastCheckedAt: T0 + 900, raining: true }])),
    balances: async () => ({ time: T0 + 960, dollars: 0n, native: 0n }),
  }
}

describe('the cover history read from the chain', () => {
  it('lists the holder’s cover, newest first, with what is confirmed and not yet sent', async () => {
    const book = fakeBook([
      row(1n, { closed: true, paid: 120_000n }),
      row(2n, { start: T0 + 600, end: T0 + 1200 }),
      row(3n, { holder: OTHER }),
    ])
    const source = new RpcCoverHistorySource(book, new PolicyTable(book))
    source.remember(2n, `0x${'cd'.repeat(32)}`)
    const snapshot = await source.snapshot(HOLDER)

    expect(snapshot.at).toBe(T0 + 960)
    expect(snapshot.records.map((record) => [record.id, record.paid, record.confirmed, record.closed])).toEqual([
      [2n, 0n, 60_000n, false],
      [1n, 120_000n, 0n, true],
    ])
    expect(snapshot.records[0]!.purchase).toBe(`0x${'cd'.repeat(32)}`)
    expect(snapshot.weather.get(KEY)).toEqual({ lastCheckedAt: T0 + 900, raining: true })
  })

  it('reads every row once, then only the open ones and the new ones', async () => {
    const book = fakeBook([row(1n, { closed: true }), row(2n), row(3n, { holder: OTHER, closed: true })])
    const table = new PolicyTable(book)
    await table.refresh()
    expect(book.asked).toEqual([[1n, 2n, 3n]])

    book.rows.push(row(4n))
    await table.refresh()
    expect(book.asked[1]).toEqual([2n, 4n])
  })

  it('says until when an area is paid up', () => {
    const records = [
      { id: 1n, key: KEY, start: T0, end: T0 + 600, closed: false },
      { id: 2n, key: KEY, start: T0 + 600, end: T0 + 1200, closed: false },
      { id: 3n, key: 7n, start: T0, end: T0 + 9000, closed: false },
    ] as CoverRecord[]
    const snapshot: CoverSnapshot = { at: T0, records, weather: new Map() }
    expect(coveredUntil(snapshot, KEY, T0 + 100)).toBe(T0 + 1200)
    expect(coveredUntil(snapshot, KEY, T0 + 1200)).toBeNull()
  })

  it('names the phase of each piece of cover', () => {
    const record = { start: T0, end: T0 + 600, closed: false }
    expect(phaseOf(record, T0 - 1)).toBe('upcoming')
    expect(phaseOf(record, T0)).toBe('active')
    expect(phaseOf(record, T0 + 600)).toBe('ended')
    expect(phaseOf({ ...record, closed: true }, T0)).toBe('closed')
  })
})

function record(id: bigint, overrides: Partial<CoverRecord> = {}): CoverRecord {
  return { ...row(id), confirmed: 0n, purchase: null, ...overrides }
}

describe('accrual', () => {
  it('groups cover bought back to back into one shift', () => {
    const shifts = groupShifts([
      record(1n),
      record(2n, { start: T0 + 600, end: T0 + 1200, paid: 30_000n }),
      record(3n, { start: T0 + 20_000, end: T0 + 20_600 }),
    ])
    expect(
      shifts.map((shift) => [shift.start - T0, shift.end - T0, shift.records.length, shift.cost, shift.paid]),
    ).toEqual([
      [20_000, 20_600, 1, 12_000n, 0n],
      [0, 1200, 2, 24_000n, 30_000n],
    ])
  })

  it('counts rain since the last check as provisional, at the cover’s rate', () => {
    const weather = { lastCheckedAt: T0 + 300, raining: true }
    expect(provisionalOf(record(1n), weather, T0 + 360)).toBe(120_000n)
    expect(provisionalOf(record(1n), { ...weather, raining: false }, T0 + 360)).toBe(0n)
    expect(provisionalOf(record(1n), weather, T0 + 9_999)).toBe(600_000n)
    expect(provisionalOf(record(1n, { closed: true }), weather, T0 + 360)).toBe(0n)
    expect(provisionalOf(record(1n, { paid: 1_100_000n, confirmed: 50_000n }), weather, T0 + 600)).toBe(50_000n)
    expect(provisionalOf(record(1n), { lastCheckedAt: null, raining: true }, T0 + 360)).toBe(0n)
  })

  it('shows paid, confirmed and provisional apart', () => {
    const snapshot: CoverSnapshot = {
      at: T0 + 700,
      records: [record(2n, { start: T0 + 600, end: T0 + 1200, confirmed: 20_000n }), record(1n, { paid: 600_000n })],
      weather: new Map([[KEY, { lastCheckedAt: T0 + 610, raining: true }]]),
    }
    const accrual = computeAccrual(snapshot, T0 + 700)
    expect(accrual).toMatchObject({
      running: true,
      coveredUntil: T0 + 1200,
      paid: 600_000n,
      confirmed: 20_000n,
      provisional: 180_000n,
      cost: 24_000n,
      ratePerSecond: 2000n,
      weather: { lastCheckedAt: T0 + 610, raining: true },
    })
  })

  it('keeps showing a finished shift for a while, then nothing', () => {
    const snapshot: CoverSnapshot = {
      at: T0,
      records: [record(1n, { closed: true, paid: 5n })],
      weather: new Map(),
    }
    expect(computeAccrual(snapshot, T0 + 700)).toMatchObject({ running: false, paid: 5n, coveredUntil: null })
    expect(computeAccrual(snapshot, T0 + 600 + 1801).shift).toBeNull()
  })
})
