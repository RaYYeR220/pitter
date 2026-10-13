import { parseAbi, type Abi } from 'viem'
import { privateKeyToAddress } from 'viem/accounts'
import { describe, expect, it, vi } from 'vitest'
import { coreAbis, coreWeather, corePricing } from '../../src/adapters/core'
import { ConfigError } from '../../src/config'
import { consoleLogger, createServiceFromEnv } from '../../src/env'
import { createService } from '../../src/service'
import { validEnv } from '../helpers/env'
import { T0 } from '../helpers/fakes'
import { body, get, harness, post } from '../helpers/harness'

const sandboxEnv = {
  SANDBOX_ENABLED: 'true',
  SANDBOX_SECRET: 'sandbox-secret-for-tests-01234567',
  SANDBOX_SIMULATOR_KEY: '18446744073709551616',
}

describe('createService', () => {
  it('routes each path to its handler', async () => {
    const service = createService(harness().deps)

    const statuses = {
      quote: (await service.fetch(get('/quote'))).status,
      buy: (await service.fetch(post('/relay/buy', {}))).status,
      deposit: (await service.fetch(post('/relay/deposit', {}))).status,
      transfer: (await service.fetch(post('/relay/transfer', {}))).status,
      settle: (await service.fetch(post('/relay/settle', {}))).status,
      tick: (await service.fetch(post('/cron/tick', {}))).status,
      cover: (await service.fetch(post('/v1/cover', {}))).status,
      blob: (await service.fetch(get('/blobs/0x1234/log'))).status,
      drip: (await service.fetch(post('/sandbox/drip', {}))).status,
      storm: (await service.fetch(post('/sandbox/storm', {}))).status,
    }

    expect(statuses).toEqual({
      quote: 400,
      buy: 400,
      deposit: 400,
      transfer: 400,
      settle: 400,
      tick: 401,
      cover: 503,
      blob: 400,
      drip: 403,
      storm: 403,
    })
  })

  it('answers 404 as JSON for anything else', async () => {
    const service = createService(harness().deps)

    for (const path of ['/', '/quotes', '/relay', '/relay/buy/extra', '/admin', '/.env', '/blobs']) {
      const response = await service.fetch(get(path))
      expect(response.status, path).toBe(404)
      expect((await body(response)).error.code).toBe('not_found')
    }
  })

  it('answers 405 with the allowed methods', async () => {
    const service = createService(harness().deps)

    const response = await service.fetch(get('/relay/buy'))

    expect(response.status).toBe(405)
    expect(response.headers.get('allow')).toBe('POST')
  })

  it('tolerates a trailing slash', async () => {
    const service = createService(harness().deps)

    expect((await service.fetch(get('/quote/'))).status).toBe(400)
  })

  it('serves only below its base path', async () => {
    const service = createService(harness({ BASE_PATH: '/api' }).deps)

    expect((await service.fetch(get('/api/quote'))).status).toBe(400)
    expect((await service.fetch(get('/quote'))).status).toBe(404)
    expect((await service.fetch(get('/apiquote'))).status).toBe(404)
  })

  it('lists its routes and the relayer address', () => {
    const h = harness()
    const service = createService(h.deps)

    expect(service.relayerAddress).toBe(h.relayerAccount.address)
    expect(service.routes.map((route) => `${route.methods.join('|')} ${route.path}`)).toEqual([
      'GET /quote',
      'POST /relay/buy',
      'POST /relay/deposit',
      'POST /relay/transfer',
      'POST /relay/settle',
      'POST|GET /cron/tick',
      'POST /v1/cover',
      'GET|PUT /blobs',
      'POST /sandbox/drip',
      'POST|GET /sandbox/storm',
    ])
  })

  it('refuses to start when a contract interface has moved on without the relayer', () => {
    const h = harness()
    const drifted = {
      ...coreAbis,
      coverPool: parseAbi(['function depositWithAuthorization(uint256 assets, address receiver)']) as Abi,
    }

    expect(() => createService({ ...h.deps, core: { ...h.deps.core, abis: drifted } })).toThrow(
      /coverPool ABI has no depositWithAuthorization/,
    )
  })

  it('never puts a secret in a response, whatever is thrown at it', async () => {
    const h = harness({ ...sandboxEnv, X402_ENABLED: 'true' })
    const service = createService(h.deps)
    h.rpc.simulate = async () => {
      throw new Error(`simulate failed at ${h.secrets.rpcUrl} with ${h.secrets.relayerKey}`)
    }
    h.pricing.failure = new Error(`forecast failed with ${h.secrets.underwriterKey}`)
    h.weather.failure = new Error(`sources failed with ${h.secrets.reporterKey}`)
    const holder = privateKeyToAddress(h.secrets.underwriterKey)
    const requests = [
      get(`/quote?lat=52.2&lon=21&start=${T0 + 120}&end=${T0 + 720}&rate=1000&holder=${holder}`),
      get('/quote?lat=x'),
      post('/relay/buy', '{'),
      post('/relay/settle', { ids: [1] }),
      post('/cron/tick', {}, { 'x-cron-secret': h.secrets.cronSecret! }),
      post('/cron/tick', {}, { 'x-cron-secret': 'guess' }),
      post('/sandbox/drip', { address: holder }, { 'x-sandbox-secret': h.secrets.sandboxSecret! }),
      post('/v1/cover', { lat: 52.2, lon: 21, start: T0 + 120, end: T0 + 720, rate: '1000', holder }),
      get(`/blobs/${holder}/log`),
      get('/nowhere'),
    ]
    const secrets = [
      h.secrets.underwriterKey,
      h.secrets.relayerKey,
      h.secrets.reporterKey!,
      h.secrets.cronSecret!,
      h.secrets.sandboxSecret!,
      h.secrets.rpcUrl,
      'secret-api-key',
    ]

    for (const request of requests) {
      const response = await service.fetch(request)
      const text = `${await response.text()} ${JSON.stringify([...response.headers])}`
      for (const secret of secrets) {
        expect(text).not.toContain(secret)
        expect(text).not.toContain(secret.replace(/^0x/, ''))
      }
      expect(text).not.toMatch(/\bat .+\.ts:\d+/)
    }
  })
})

describe('createServiceFromEnv', () => {
  it('builds the service from environment variables alone', async () => {
    const env = validEnv()

    const service = await createServiceFromEnv(env, { logger: { info() {}, warn() {}, error() {} } })

    expect(service.relayerAddress).toBe(privateKeyToAddress(env.RELAYER_PRIVATE_KEY as `0x${string}`))
    expect((await service.fetch(get('/nowhere'))).status).toBe(404)
  })

  it('rejects an incomplete environment', async () => {
    await expect(createServiceFromEnv({})).rejects.toThrow(ConfigError)
  })

  it('reaches the node only through the fetch it is given', async () => {
    const calls: string[] = []
    const fetchFn = (async (input: string | URL | Request) => {
      calls.push(String(input instanceof Request ? input.url : input))
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'down' } }), {
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof fetch
    const env = validEnv()
    const service = await createServiceFromEnv(env, { fetch: fetchFn, logger: { info() {}, warn() {}, error() {} } })

    const response = await service.fetch(
      get(`/quote?lat=52.2&lon=21&start=${T0 + 120}&end=${T0 + 720}&rate=1000&holder=${service.relayerAddress}`),
    )

    expect(response.status).toBe(502)
    expect((await body(response)).error.code).toBe('rpc_unavailable')
    expect(calls.length).toBeGreaterThan(0)
    expect(calls.every((url) => url === env.RPC_URL)).toBe(true)
  })
})

describe('consoleLogger', () => {
  it('masks the node URL and reduces errors to name and message', () => {
    const lines: string[] = []
    const spy = vi.spyOn(console, 'error').mockImplementation((line: string) => void lines.push(line))
    const logger = consoleLogger({ rpcUrl: 'https://rpc.example.test/v1/secret-api-key' })

    logger.error('unhandled error', {
      error: new Error('request to https://rpc.example.test/v1/secret-api-key failed'),
      amount: 5n,
    })
    spy.mockRestore()

    expect(lines).toHaveLength(1)
    expect(lines[0]).not.toContain('secret-api-key')
    expect(JSON.parse(lines[0]!)).toEqual({
      level: 'error',
      message: 'unhandled error',
      error: { name: 'Error', message: 'request to [node] failed' },
      amount: '5',
    })
  })
})

describe('core adapter', () => {
  const forecastBody = (start: number) => {
    const quarter = Array.from({ length: 16 }, (_, i) => start + i * 900)
    const hours = Array.from({ length: 4 }, (_, i) => start + i * 3600)
    return JSON.stringify({
      minutely_15: { time: quarter, precipitation: quarter.map(() => 0.1) },
      hourly: { time: hours, precipitation_probability: hours.map(() => 40) },
    })
  }
  const key = (1n << 64n) | (2844n << 32n) | 4020n

  it('prices from the forecast and reuses it for a while', async () => {
    let requests = 0
    const pricing = corePricing({
      fetch: async () => {
        requests++
        return { status: 200, text: async () => forecastBody(T0) }
      },
      userAgent: 'test',
    })
    const request = { key, lat: 52.2, lon: 21, start: T0 + 900, end: T0 + 1_800, ratePerSecond: 1_000n, now: T0 }

    const first = await pricing.price(request)
    const second = await pricing.price({ ...request, now: T0 + 30 })
    await pricing.price({ ...request, now: T0 + 500 })

    expect(first.premium).toBeGreaterThan(0n)
    expect(second.premium).toBe(first.premium)
    expect((first.inputs as { slots: unknown[] }).slots).toHaveLength(1)
    expect(requests).toBe(2)
  })

  it('fails to price without a forecast, and asks again next time', async () => {
    let requests = 0
    const pricing = corePricing({
      fetch: async () => {
        requests++
        return { status: 503, text: async () => 'unavailable' }
      },
      userAgent: 'test',
    })
    const request = { key, lat: 52.2, lon: 21, start: T0 + 900, end: T0 + 1_800, ratePerSecond: 1_000n, now: T0 }

    await expect(pricing.price(request)).rejects.toThrow()
    await expect(pricing.price(request)).rejects.toThrow()

    expect(requests).toBe(2)
  })

  it('has no verdict when the sources are down', async () => {
    const weather = coreWeather({
      fetch: async () => {
        throw new Error('offline')
      },
      userAgent: 'test',
    })

    expect((await weather.observe([key], T0)).size).toBe(0)
    expect((await weather.observe([], T0)).size).toBe(0)
  })

  it('chains readings from where each cell was last reported', () => {
    const weather = coreWeather({ fetch: async () => ({ status: 500, text: async () => '' }), userAgent: 'test' })
    const other = key + 1n

    const readings = weather.buildReadings({
      verdicts: new Map([
        [key, true],
        [other, false],
      ]),
      lastTo: new Map([[key, BigInt(T0 - 240)]]),
      now: T0 + 59,
      firstReadingSeconds: 300,
    })

    expect(readings).toEqual([
      { key, from: BigInt(T0 - 240), to: BigInt(T0), wetSeconds: 240 },
      { key: other, from: BigInt(T0 - 300), to: BigInt(T0), wetSeconds: 0 },
    ])
  })
})
