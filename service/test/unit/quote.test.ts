import { hashTypedData, recoverAddress, type Hex } from 'viem'
import { generatePrivateKey, privateKeyToAddress } from 'viem/accounts'
import { beforeEach, describe, expect, it } from 'vitest'
import { capacityOf } from '../../src/quote/engine'
import { quoteHandler } from '../../src/quote/handler'
import { quoteSchema } from '../../src/validation'
import { T0, fakeMarket } from '../helpers/fakes'
import { body, get, harness, type Harness } from '../helpers/harness'

const holder = privateKeyToAddress(generatePrivateKey())
const START = T0 + 120
const END = START + 600

function url(overrides: Record<string, string | number | undefined> = {}): string {
  const params: Record<string, string | number | undefined> = {
    lat: '52.2297',
    lon: '21.0122',
    start: START,
    end: END,
    rate: 1000,
    holder,
    ...overrides,
  }
  const query = Object.entries(params)
    .filter(([, value]) => value !== undefined)
    .map(([name, value]) => `${name}=${encodeURIComponent(String(value))}`)
    .join('&')
  return `/quote?${query}`
}

describe('GET /quote', () => {
  let h: Harness
  let quote: (path?: string, headers?: Record<string, string>) => Promise<Response>

  beforeEach(() => {
    h = harness()
    const handler = h.guarded(quoteHandler(h.context))
    quote = (path = url(), headers = {}) => handler(get(path, headers))
  })

  it('returns a quote signed by the underwriter for the requested terms', async () => {
    const response = await quote()
    const result = await body(response)

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    const parsed = quoteSchema.parse(result.quote)
    expect(parsed.holder).toBe(holder)
    expect(parsed.key).toBe(h.context.core.cells.keyAt(52.2297, 21.0122))
    expect(parsed.start).toBe(BigInt(START))
    expect(parsed.end).toBe(BigInt(END))
    expect(parsed.ratePerSecond).toBe(1000n)
    expect(parsed.premium).toBe(50_000n)
    expect(result.maxPayout).toBe('600000')
    expect(result.inputs.slots).toHaveLength(1)

    const digest = hashTypedData({
      domain: {
        name: 'Cover',
        version: '1',
        chainId: h.settings.chainId,
        verifyingContract: h.settings.contracts.coverBook,
      },
      types: {
        Quote: [
          { name: 'holder', type: 'address' },
          { name: 'key', type: 'uint256' },
          { name: 'start', type: 'uint64' },
          { name: 'end', type: 'uint64' },
          { name: 'ratePerSecond', type: 'uint128' },
          { name: 'premium', type: 'uint128' },
          { name: 'expiry', type: 'uint64' },
          { name: 'salt', type: 'bytes32' },
        ],
      },
      primaryType: 'Quote',
      message: parsed,
    })
    expect(result.digest).toBe(digest)
    expect(await recoverAddress({ hash: digest, signature: result.quoteSig as Hex })).toBe(h.underwriter.address)
  })

  it('reports the capacity behind the decision', async () => {
    h.reader.marketState = fakeMarket({ lockedExposure: 100_000_000n, cellExposure: 40_000_000n })

    const { capacity } = await body(await quote())

    expect(capacity).toEqual({
      assets: '1000000000',
      lockedExposure: '100000000',
      cellExposure: '40000000',
      globalLimit: '800000000',
      cellLimit: '250000000',
      globalRemaining: '700000000',
      cellRemaining: '210000000',
      maxPolicyPayout: '500000000',
      available: '210000000',
    })
  })

  it('passes on what pricing warns about, and nothing when it warns of nothing', async () => {
    const plain = await body(await quote())
    h.pricing.warnings = ['observations_unavailable']
    const warned = await body(await quote())

    expect(plain.warnings).toEqual([])
    expect(warned.warnings).toEqual(['observations_unavailable'])
  })

  it('gives every quote its own salt', async () => {
    const first = await body(await quote())
    const second = await body(await quote())

    expect(first.quote.salt).not.toBe(second.quote.salt)
    expect(first.digest).not.toBe(second.digest)
  })

  it('expires the quote after the configured lifetime', async () => {
    const { quote: signed } = await body(await quote(url({ start: T0 + 600, end: T0 + 1200 })))

    expect(Number(signed.expiry)).toBe(T0 + h.settings.quote.ttlSeconds)
  })

  it('expires the quote no later than the last moment it can still be bought', async () => {
    h.reader.marketState = fakeMarket({ minLead: 60 })

    const { quote: signed } = await body(await quote(url({ start: T0 + 120, end: T0 + 720 })))

    expect(Number(signed.expiry)).toBe(T0 + 60)
  })

  it('expires the quote before the oracle heartbeat goes stale', async () => {
    h.reader.marketState = fakeMarket({ heartbeat: T0 - 1_150, maxOracleAge: 1_200 })

    const { quote: signed } = await body(await quote(url({ start: T0 + 600, end: T0 + 1200 })))

    expect(Number(signed.expiry)).toBe(T0 + 50)
  })

  describe('refuses to sign', () => {
    async function refusal(path: string) {
      const response = await quote(path)
      const { error } = await body(response)
      return { status: response.status, code: error.code as string, details: error.details }
    }

    it('a window in the past', async () => {
      const result = await refusal(url({ start: T0 - 600, end: T0 }))

      expect(result).toMatchObject({ status: 422, code: 'window_too_soon' })
      expect(result.details.earliestStart).toBe(T0 + 60)
      expect(h.pricing.requests).toHaveLength(0)
    })

    it('a window that has already started', async () => {
      expect(await refusal(url({ start: T0 - 60, end: T0 + 540 }))).toMatchObject({ code: 'window_too_soon' })
    })

    it('a window that starts inside the lead time', async () => {
      h.reader.marketState = fakeMarket({ minLead: 600 })

      const result = await refusal(url({ start: T0 + 540, end: T0 + 1140 }))

      expect(result).toMatchObject({ status: 422, code: 'window_too_soon' })
      expect(result.details.earliestStart).toBe(T0 + 660)
    })

    it('a window judged against a stale local clock when the chain is ahead', async () => {
      h.reader.marketState = fakeMarket({ head: { number: 1n, timestamp: T0 + 3_600 }, heartbeat: T0 + 3_500 })

      expect(await refusal(url())).toMatchObject({ code: 'window_too_soon' })
    })

    it('a window that is not aligned to the minute', async () => {
      expect(await refusal(url({ start: START + 1 }))).toMatchObject({ status: 422, code: 'window_invalid' })
      expect(await refusal(url({ end: END + 30 }))).toMatchObject({ status: 422, code: 'window_invalid' })
    })

    it('a window that ends before it starts', async () => {
      expect(await refusal(url({ start: END, end: START }))).toMatchObject({ code: 'window_invalid' })
      expect(await refusal(url({ start: START, end: START }))).toMatchObject({ code: 'window_invalid' })
    })

    it('a window beyond the configured maximum duration', async () => {
      const result = await refusal(url({ end: START + 43_200 + 60 }))

      expect(result).toMatchObject({ status: 422, code: 'window_too_long' })
      expect(h.reader.marketCalls).toBe(0)
    })

    it('a window beyond what the book accepts', async () => {
      h.reader.marketState = fakeMarket({ maxDuration: 3_600 })

      expect(await refusal(url({ end: START + 7_200 }))).toMatchObject({ status: 422, code: 'window_invalid' })
    })

    it('a rate above the configured maximum', async () => {
      const result = await refusal(url({ rate: 10_001 }))

      expect(result).toMatchObject({ status: 422, code: 'rate_too_high' })
      expect(result.details.maxRatePerSecond).toBe('10000')
      expect(h.reader.marketCalls).toBe(0)
    })

    it('cover larger than one policy may be', async () => {
      h.reader.marketState = fakeMarket({ maxPolicyPayout: 500_000n })

      expect(await refusal(url())).toMatchObject({ status: 422, code: 'policy_too_large' })
    })

    it('when the pool is at its utilisation cap', async () => {
      h.reader.marketState = fakeMarket({ lockedExposure: 799_500_000n })

      const result = await refusal(url())

      expect(result).toMatchObject({ status: 409, code: 'capacity_exhausted' })
      expect(result.details.scope).toBe('pool')
      expect(result.details.capacity.globalRemaining).toBe('500000')
      expect(h.pricing.requests).toHaveLength(0)
    })

    it('when the cell is at its cap', async () => {
      h.reader.marketState = fakeMarket({ lockedExposure: 249_500_000n, cellExposure: 249_500_000n })

      const result = await refusal(url())

      expect(result).toMatchObject({ status: 409, code: 'capacity_exhausted' })
      expect(result.details.scope).toBe('cell')
    })

    it('when the pool is empty', async () => {
      h.reader.marketState = fakeMarket({ assets: 0n })

      expect(await refusal(url())).toMatchObject({ status: 409, code: 'capacity_exhausted' })
    })

    it('one unit over the remaining capacity, and signs exactly at it', async () => {
      h.reader.marketState = fakeMarket({ cellExposure: 249_400_001n, lockedExposure: 249_400_001n })
      expect(await refusal(url())).toMatchObject({ code: 'capacity_exhausted' })

      h.reader.marketState = fakeMarket({ cellExposure: 249_400_000n, lockedExposure: 249_400_000n })
      expect((await quote()).status).toBe(200)
    })

    it('a new cell when no further cells may open', async () => {
      h.reader.marketState = fakeMarket({ activeCells: 64, maxActiveCells: 64, cellOpenPolicies: 0n })
      expect(await refusal(url())).toMatchObject({ status: 409, code: 'too_many_cells' })

      h.reader.marketState = fakeMarket({ activeCells: 64, maxActiveCells: 64, cellOpenPolicies: 2n })
      expect((await quote()).status).toBe(200)
    })

    it('when the oracle heartbeat is stale', async () => {
      h.reader.marketState = fakeMarket({ heartbeat: T0 - 1_201, maxOracleAge: 1_200 })

      const result = await refusal(url())

      expect(result).toMatchObject({ status: 503, code: 'oracle_stale' })
      expect(result.details).toEqual({ heartbeat: T0 - 1_201, maxOracleAgeSeconds: 1_200 })
      expect(h.pricing.requests).toHaveLength(0)
    })

    it('when the oracle has never reported', async () => {
      h.reader.marketState = fakeMarket({ heartbeat: 0 })

      expect(await refusal(url())).toMatchObject({ status: 503, code: 'oracle_stale' })
    })

    it('when no forecast is available, without saying why', async () => {
      h.pricing.failure = new Error('GET https://forecast.internal.example/v1?apikey=topsecret failed')

      const response = await quote()
      const text = await response.text()

      expect(response.status).toBe(503)
      expect(JSON.parse(text).error.code).toBe('pricing_unavailable')
      expect(text).not.toContain('topsecret')
      expect(text).not.toContain('internal.example')
    })
  })

  describe('premium', () => {
    it('is never below the floor share of the maximum payout', async () => {
      h.pricing.premium = 1n

      const { quote: signed } = await body(await quote())

      expect(signed.premium).toBe('6000')
    })

    it('is never below the minimum the book accepts', async () => {
      h.pricing.premium = 1n
      h.reader.marketState = fakeMarket({ minPremium: 25_000n })

      const { quote: signed } = await body(await quote())

      expect(signed.premium).toBe('25000')
    })

    it('rounds the floor up', async () => {
      h.pricing.premium = 0n

      const { quote: signed } = await body(await quote(url({ rate: 1, end: START + 60 })))

      expect(signed.premium).toBe('1')
    })
  })

  describe('validation', () => {
    it.each([
      ['lat', undefined],
      ['lon', '181'],
      ['holder', '0x1234'],
      ['holder', '0x0000000000000000000000000000000000000000'],
      ['rate', '0'],
      ['rate', '1.5'],
      ['start', '-60'],
      ['end', '99999999999999999999999999'],
    ])('rejects %s = %j', async (name, value) => {
      const response = await quote(url({ [name]: value }))

      expect(response.status).toBe(400)
      expect((await body(response)).error.code).toBe('invalid_request')
      expect(h.reader.marketCalls).toBe(0)
    })

    it('rejects unknown and repeated parameters', async () => {
      expect((await quote(`${url()}&premium=1`)).status).toBe(400)
      expect((await quote(`${url()}&rate=5`)).status).toBe(400)
    })

    it('rejects other methods', async () => {
      const handler = h.guarded(quoteHandler(h.context))

      const response = await handler(new Request(`https://cover.test${url()}`, { method: 'POST' }))

      expect(response.status).toBe(405)
      expect(response.headers.get('allow')).toBe('GET')
    })
  })

  describe('rate limits', () => {
    it('limits quotes per IP', async () => {
      h = harness({ RATE_QUOTE_PER_IP: '3', RATE_QUOTE_PER_ADDRESS: '100' })
      const handler = h.guarded(quoteHandler(h.context))
      const from = (ip: string) => handler(get(url(), { 'x-forwarded-for': ip }))

      for (let i = 0; i < 3; i++) expect((await from('203.0.113.7')).status).toBe(200)
      const limited = await from('203.0.113.7')

      expect(limited.status).toBe(429)
      expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0)
      expect((await from('203.0.113.8')).status).toBe(200)
    })

    it('limits quotes per holder across IPs', async () => {
      h = harness({ RATE_QUOTE_PER_IP: '100', RATE_QUOTE_PER_ADDRESS: '2' })
      const handler = h.guarded(quoteHandler(h.context))
      const from = (ip: string, who = holder) => handler(get(url({ holder: who }), { 'x-forwarded-for': ip }))

      expect((await from('203.0.113.1')).status).toBe(200)
      expect((await from('203.0.113.2')).status).toBe(200)
      expect((await from('203.0.113.3')).status).toBe(429)
      expect((await from('203.0.113.3', privateKeyToAddress(generatePrivateKey()))).status).toBe(200)
    })

    it('opens a new window after the old one', async () => {
      h = harness({ RATE_QUOTE_PER_IP: '1' })
      const handler = h.guarded(quoteHandler(h.context))

      expect((await handler(get(url()))).status).toBe(200)
      expect((await handler(get(url()))).status).toBe(429)
      h.clock.time += 60
      h.reader.marketState = fakeMarket({ head: { number: 2n, timestamp: T0 + 60 }, heartbeat: T0 })
      expect((await handler(get(url({ start: START + 60, end: END + 60 })))).status).toBe(200)
    })

    it('counts requests without a client address together', async () => {
      h = harness({ RATE_QUOTE_PER_IP: '1' })
      const handler = h.guarded(quoteHandler(h.context))

      expect((await handler(get(url()))).status).toBe(200)
      expect((await handler(get(url(), { 'x-forwarded-for': 'not an ip' }))).status).toBe(429)
    })
  })
})

describe('capacityOf', () => {
  it('rounds the caps down like the pool does', () => {
    const capacity = capacityOf(fakeMarket({ assets: 999n, maxUtilizationBps: 8000, maxCellBps: 2500 }))

    expect(capacity.globalLimit).toBe(799n)
    expect(capacity.cellLimit).toBe(249n)
  })

  it('never reports negative room', () => {
    const capacity = capacityOf(fakeMarket({ assets: 100n, lockedExposure: 500n, cellExposure: 500n }))

    expect(capacity.globalRemaining).toBe(0n)
    expect(capacity.cellRemaining).toBe(0n)
    expect(capacity.available).toBe(0n)
  })
})

describe('cover horizon', () => {
  it('refuses a window that ends beyond what the book sells, and signs one that ends on it', async () => {
    const h = harness()
    h.reader.marketState = fakeMarket({ maxHorizon: 3_600 })
    const handler = h.guarded(quoteHandler(h.context))

    const beyond = await handler(get(url({ start: T0 + 3_000, end: T0 + 3_660 })))
    const within = await handler(get(url({ start: T0 + 3_000, end: T0 + 3_600 })))

    expect(beyond.status).toBe(422)
    expect((await body(beyond)).error).toMatchObject({ code: 'window_too_far', details: { latestEnd: T0 + 3_600 } })
    expect(within.status).toBe(200)
  })

  it('falls back to a week when the book sets no horizon', async () => {
    const h = harness()
    h.reader.marketState = fakeMarket({ maxHorizon: null })
    const handler = h.guarded(quoteHandler(h.context))
    const week = 7 * 86_400

    const within = await handler(get(url({ start: T0 + 39_600, end: T0 + 82_800 })))
    const beyond = await handler(get(url({ start: T0 + week, end: T0 + week + 600 })))

    expect(within.status).toBe(200)
    expect((await body(beyond)).error.code).toBe('window_too_far')
  })
})
