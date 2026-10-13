import { describe, expect, it } from 'vitest'
import type { SigningSession } from '@/lib/account'
import { areaAt } from '@/lib/cover/area'
import {
  CoverEngine,
  NeedsConfirmation,
  RefusalError,
  type CoverEngineOptions,
  type CoverEnginePorts,
} from '@/lib/cover/engine'
import { ServiceFailure } from '@/lib/service/errors'
import { T0, fakeMarket, session } from './support/market'

const RATE = 2000n
const BLOCK = 600
const options: CoverEngineOptions = { blockSeconds: BLOCK, renewLeadSeconds: 45 }
const warsaw = areaAt(52.2297, 21.0122, 'city', 'central Warsaw')
const krakow = areaAt(50.0647, 19.945, 'city', 'central Kraków')

function setup(
  marketOptions: Parameters<typeof fakeMarket>[0] = {},
  scope: Parameters<typeof session>[1] = {},
  engineOptions: Partial<CoverEngineOptions> = {},
) {
  const market = fakeMarket(marketOptions)
  const key = crypto.getRandomValues(new Uint8Array(32))
  let signer: SigningSession | null = session(market.now, scope, key)
  const awake: boolean[] = []
  const ports: CoverEnginePorts = {
    ...market.ports,
    signer: () => signer,
    keepAwake(value) {
      awake.push(value)
      signer?.keepAwake(value)
    },
  }
  const engine = new CoverEngine(ports, { ...options, ...engineOptions })
  return {
    market,
    engine,
    ports,
    awake,
    key,
    signer: () => signer!,
    signOut() {
      signer?.end()
      signer = null
    },
    swapSigner() {
      signer = session(market.now, scope)
    },
    /** Moves the clock second by second, ticking the engine as a page would. */
    async run(seconds: number) {
      for (let i = 0; i < seconds; i++) {
        market.advance(1)
        await engine.tick()
      }
    },
  }
}

describe('turning cover on', () => {
  it('buys the first block from the next minute that can still be bought', async () => {
    const { market, engine, signer, awake } = setup()
    await engine.turnOn(warsaw, RATE)

    expect(market.purchases).toHaveLength(1)
    const { quote, digest, authorization } = market.purchases[0]!
    expect(quote).toMatchObject({ holder: signer().address, key: warsaw.key, start: BigInt(T0 + 60), end: BigInt(T0 + 660) })
    expect(authorization.validBefore).toBe(quote.expiry)
    expect(digest).toMatch(/^0x[0-9a-f]{64}$/)

    expect(engine.getState()).toMatchObject({
      status: 'on',
      activity: 'idle',
      coveredUntil: T0 + 660,
      stopped: null,
      blocks: [{ key: warsaw.key, start: T0 + 60, end: T0 + 660, kind: 'block', premium: quote.premium, policyId: 1n }],
    })
    expect(engine.getState().price).toMatchObject({ premium: quote.premium, seconds: BLOCK, costPerMinute: quote.premium / 10n })
    expect(awake).toEqual([true])
  })

  it('respects the lead time the book demands', async () => {
    const { market, engine } = setup({ minLead: 600 })
    await engine.turnOn(warsaw, RATE)
    expect(Number(market.purchases[0]!.quote.start)).toBe(T0 + 660)
  })

  it('needs someone signed in', async () => {
    const { market, engine, signOut } = setup()
    signOut()
    await engine.turnOn(warsaw, RATE)
    expect(engine.getState()).toMatchObject({ status: 'off', stopped: { kind: 'session_expired' } })
    expect(market.quotesAsked()).toBe(0)
  })
})

describe('pay as you go', () => {
  it('keeps buying the next block back to back while the switch is on', async () => {
    const { market, engine } = setup()
    await engine.turnOn(warsaw, RATE)

    for (let i = 0; i < 3600; i++) {
      market.advance(1)
      await engine.tick()
    }
    const windows = market.purchases.map(({ quote }) => [Number(quote.start) - T0, Number(quote.end) - T0])
    expect(windows).toEqual([
      [60, 660],
      [660, 1260],
      [1260, 1860],
      [1860, 2460],
      [2460, 3060],
      [3060, 3660],
    ])
    expect(market.overlaps()).toEqual([])
    expect(engine.getState().gaps).toEqual([])
    expect(engine.getState().coveredUntil).toBe(T0 + 3660)
  })

  it('buys the next block shortly before the current one ends, not earlier', async () => {
    const { market, engine, run } = setup()
    await engine.turnOn(warsaw, RATE)
    await run(660 - 46)
    expect(market.purchases).toHaveLength(1)
    await run(1)
    expect(market.purchases).toHaveLength(2)
  })

  it('never buys a window twice when ticks overlap', async () => {
    const { market, engine, run } = setup()
    await Promise.all([engine.turnOn(warsaw, RATE), engine.tick(), engine.tick(), engine.tick()])
    await run(620)
    await Promise.all(Array.from({ length: 10 }, () => engine.tick()))
    expect(market.purchases).toHaveLength(2)
    expect(market.overlaps()).toEqual([])
  })

  it('resumes from the present after the tab slept, and reports the gap', async () => {
    const { market, engine } = setup()
    await engine.turnOn(warsaw, RATE)
    market.advance(1800)
    await engine.tick()

    expect(market.purchases).toHaveLength(2)
    expect(Number(market.purchases[1]!.quote.start)).toBe(T0 + 1860)
    expect(engine.getState().gaps).toEqual([{ from: T0 + 660, to: T0 + 1860 }])
    expect(market.overlaps()).toEqual([])
  })

  it('picks up cover already bought on the chain, so a reload does not buy the same minutes again', async () => {
    const first = setup()
    await first.engine.turnOn(warsaw, RATE)
    const holder = first.signer()

    const reloaded = new CoverEngine({ ...first.market.ports, signer: () => holder }, options)
    first.market.advance(30)
    await reloaded.turnOn(warsaw, RATE)
    expect(first.market.purchases).toHaveLength(1)
    expect(reloaded.getState()).toMatchObject({ status: 'on', coveredUntil: T0 + 660 })

    first.market.advance(660 - 45 - 30)
    await reloaded.tick()
    expect(first.market.purchases).toHaveLength(2)
    expect(Number(first.market.purchases[1]!.quote.start)).toBe(T0 + 660)
    expect(first.market.overlaps()).toEqual([])
  })

  it('stops buying when turned off, and keeps what was bought', async () => {
    const { market, engine, run, awake } = setup()
    await engine.turnOn(warsaw, RATE)
    engine.turnOff()
    await run(3600)
    expect(market.purchases).toHaveLength(1)
    expect(engine.getState()).toMatchObject({ status: 'off', stopped: null, coveredUntil: T0 + 660 })
    expect(engine.getState().blocks).toHaveLength(1)
    expect(awake).toEqual([true, false])
  })

  it('does not sign a block once the switch was turned off mid-request', async () => {
    const { market, engine, ports } = setup()
    const quote = ports.quote
    ports.quote = async (request) => {
      const signed = await quote(request)
      engine.turnOff()
      return signed
    }
    await engine.turnOn(warsaw, RATE)
    expect(market.purchases).toHaveLength(0)
    expect(engine.getState()).toMatchObject({ status: 'off', activity: 'idle' })
  })
})

describe('an answer that never arrived', () => {
  it('asks the chain, and counts a purchase that landed instead of buying it again', async () => {
    const { market, engine, run } = setup()
    market.failRelay(new ServiceFailure(504, 'relay_pending', 'sent'), true)
    await engine.turnOn(warsaw, RATE)
    expect(engine.getState()).toMatchObject({ status: 'on', activity: 'confirming', blocks: [] })
    expect(market.purchases).toHaveLength(1)

    await run(3)
    expect(engine.getState()).toMatchObject({ activity: 'idle', coveredUntil: T0 + 660 })
    expect(engine.getState().blocks).toHaveLength(1)
    expect(engine.getState().blocks[0]).toMatchObject({ policyId: null, transactionHash: null })
    expect(market.purchases).toHaveLength(1)
  })

  it('treats a dropped connection the same way', async () => {
    const { market, engine, run } = setup()
    market.failRelay(new ServiceFailure(0, 'network', 'fetch failed'), true)
    await engine.turnOn(warsaw, RATE)
    await run(5)
    expect(market.purchases).toHaveLength(1)
    expect(engine.getState().blocks).toHaveLength(1)
  })

  it('buys afresh only once the lost quote can no longer land', async () => {
    const { market, engine, run, signer } = setup()
    market.failRelay(new ServiceFailure(504, 'relay_pending', 'sent'), false)
    await engine.turnOn(warsaw, RATE)
    expect(market.purchases).toHaveLength(0)

    await run(60)
    expect(market.purchases).toHaveLength(0)
    expect(engine.getState().activity).toBe('confirming')
    expect(signer().timing().spentThisHour).toBeGreaterThan(0n)

    await run(40)
    expect(market.purchases).toHaveLength(1)
    expect(market.overlaps()).toEqual([])
    expect(signer().timing().spentThisHour).toBe(market.purchases[0]!.quote.premium)
  })

  it('blocks every other purchase while it is unresolved', async () => {
    const { market, engine } = setup()
    market.failRelay(new ServiceFailure(504, 'relay_pending', 'sent'), false)
    await engine.turnOn(warsaw, RATE)
    const offer = await engine.quoteShift(warsaw, RATE, 3600)
    await expect(engine.lockShift(offer)).rejects.toMatchObject({ refusal: { kind: 'busy' } })
  })

  it('takes a "quote already used" answer as a purchase that landed', async () => {
    const { market, engine } = setup()
    market.failRelay(new ServiceFailure(409, 'would_revert', 'QuoteUsed', { reason: 'QuoteUsed' }))
    await engine.turnOn(warsaw, RATE)
    expect(engine.getState().blocks).toHaveLength(1)
    expect(engine.getState().status).toBe('on')
  })
})

describe('stopping cleanly', () => {
  const refusals = [
    ['area full', new ServiceFailure(409, 'capacity_exhausted', 'x', { scope: 'cell' }), 'area_full'],
    ['area full at the contract', new ServiceFailure(409, 'would_revert', 'x', { reason: 'CellCapExceeded' }), 'area_full'],
    ['pool at its limit', new ServiceFailure(409, 'capacity_exhausted', 'x', { scope: 'pool' }), 'pool_full'],
    ['pool at its limit at the contract', new ServiceFailure(409, 'would_revert', 'x', { reason: 'GlobalCapExceeded' }), 'pool_full'],
    ['weather sources silent', new ServiceFailure(503, 'oracle_stale', 'x'), 'weather_silent'],
    ['weather sources silent at the contract', new ServiceFailure(409, 'would_revert', 'x', { reason: 'OracleStale' }), 'weather_silent'],
    ['too small', new ServiceFailure(409, 'would_revert', 'x', { reason: 'PremiumTooSmall' }), 'too_small'],
    ['too far ahead', new ServiceFailure(422, 'window_too_far', 'x'), 'too_far'],
    ['too long', new ServiceFailure(422, 'window_too_long', 'x'), 'too_long'],
    ['too many areas', new ServiceFailure(409, 'too_many_cells', 'x'), 'no_more_areas'],
    ['a failed transaction', new ServiceFailure(409, 'reverted', 'x'), 'failed'],
  ] as const

  for (const [name, failure, kind] of refusals) {
    it(`on ${name} when quoting`, async () => {
      const { market, engine, run, awake } = setup()
      market.failQuote(failure)
      await engine.turnOn(warsaw, RATE)
      expect(engine.getState()).toMatchObject({ status: 'off', stopped: { kind: 'refused', refusal: { kind } } })
      await run(1200)
      expect(market.purchases).toHaveLength(0)
      expect(awake).toEqual([true, false])
    })

    it(`on ${name} when buying, and gives the spend back`, async () => {
      const { market, engine, signer } = setup()
      market.failRelay(failure)
      await engine.turnOn(warsaw, RATE)
      expect(engine.getState()).toMatchObject({ status: 'off', stopped: { kind: 'refused', refusal: { kind } } })
      expect(signer().timing().spentThisHour).toBe(0n)
    })
  }

  it('keeps the capacity figures of a refusal for the area', async () => {
    const { market, engine } = setup()
    const capacity = Object.fromEntries(
      ['assets', 'lockedExposure', 'cellExposure', 'globalLimit', 'cellLimit', 'globalRemaining', 'cellRemaining', 'maxPolicyPayout', 'available'].map(
        (name) => [name, '1000'],
      ),
    )
    market.failQuote(new ServiceFailure(409, 'capacity_exhausted', 'x', { scope: 'cell', capacity }))
    await engine.turnOn(warsaw, RATE)
    const stopped = engine.getState().stopped
    expect(stopped?.kind === 'refused' && stopped.refusal.capacity?.available).toBe(1000n)
  })

  it('when the balance cannot pay for the next block', async () => {
    const { market, engine, run, signer } = setup({ balance: 20_000n })
    await engine.turnOn(warsaw, RATE)
    expect(market.purchases).toHaveLength(1)
    await run(620)
    expect(engine.getState()).toMatchObject({
      status: 'off',
      stopped: { kind: 'insufficient_balance', needed: 12_000n, balance: 8_000n },
    })
    expect(market.purchases).toHaveLength(1)
    expect(signer().timing().spentThisHour).toBe(12_000n)
  })

  it('when the hourly limit is reached, without signing past it', async () => {
    const { market, engine, run, signer } = setup({}, { maxSpendPerHour: 30_000n })
    await engine.turnOn(warsaw, RATE)
    await run(1300)
    expect(market.purchases).toHaveLength(2)
    expect(engine.getState()).toMatchObject({ status: 'off', stopped: { kind: 'spend_limit', limit: 30_000n } })
    expect(signer().timing().spentThisHour).toBe(24_000n)
    await run(3600)
    expect(market.purchases).toHaveLength(2)
  })

  it('when the sign-in expires', async () => {
    const { market, engine, run } = setup({}, { expiresAt: (T0 + 500) * 1000 })
    await engine.turnOn(warsaw, RATE)
    await run(1800)
    expect(market.purchases).toHaveLength(1)
    expect(engine.getState()).toMatchObject({ status: 'off', stopped: { kind: 'session_expired' } })
  })

  it('when the person signs out', async () => {
    const { market, engine, run, signOut } = setup()
    await engine.turnOn(warsaw, RATE)
    signOut()
    await run(1800)
    expect(market.purchases).toHaveLength(1)
    expect(engine.getState().stopped).toEqual({ kind: 'session_expired' })
  })

  it('when another account signs in under it', async () => {
    const { market, engine, run, swapSigner } = setup()
    await engine.turnOn(warsaw, RATE)
    swapSigner()
    await run(1800)
    expect(market.purchases).toHaveLength(1)
    expect(engine.getState().stopped).toEqual({ kind: 'session_expired' })
  })

  it('and can be turned on again afterwards', async () => {
    const { market, engine } = setup()
    market.failQuote(new ServiceFailure(503, 'oracle_stale', 'x'))
    await engine.turnOn(warsaw, RATE)
    expect(engine.getState().status).toBe('off')
    await engine.turnOn(warsaw, RATE)
    expect(engine.getState()).toMatchObject({ status: 'on', stopped: null })
    expect(market.purchases).toHaveLength(1)
  })
})

describe('transient trouble', () => {
  it('asks for a fresh quote straight away when one ran out', async () => {
    const { market, engine, run } = setup()
    market.failRelay(new ServiceFailure(409, 'quote_expired', 'x'))
    await engine.turnOn(warsaw, RATE)
    expect(engine.getState()).toMatchObject({ status: 'on', activity: 'retrying', retrying: { kind: 'quote_expired' } })
    await run(2)
    expect(market.purchases).toHaveLength(1)
    expect(engine.getState()).toMatchObject({ status: 'on', activity: 'idle', retrying: null })
  })

  it('waits as long as the service asks when it is busy', async () => {
    const { market, engine, run } = setup()
    market.failQuote(new ServiceFailure(429, 'rate_limited', 'x', { retryAfterSeconds: 12 }))
    await engine.turnOn(warsaw, RATE)
    expect(engine.getState().retryAt).toBe(T0 + 12)
    await run(11)
    expect(market.purchases).toHaveLength(0)
    await run(1)
    expect(market.purchases).toHaveLength(1)
  })

  it('retries a service that is down, and gives up after five minutes', async () => {
    const { market, engine, run } = setup()
    for (let i = 0; i < 100; i++) market.failQuote(new ServiceFailure(503, 'relayer_unfunded', 'x'))
    await engine.turnOn(warsaw, RATE)
    expect(engine.getState().activity).toBe('retrying')
    await run(310)
    expect(engine.getState()).toMatchObject({
      status: 'off',
      stopped: { kind: 'unavailable', refusal: { kind: 'service_unavailable' } },
    })
    expect(market.quotesAsked()).toBeLessThan(40)
    expect(market.purchases).toHaveLength(0)
  })
})

describe('quotes that do not match the request', () => {
  const tampered = [
    ['another holder', { holder: '0x2222222222222222222222222222222222222222' }],
    ['another area', { key: 1n }],
    ['another start', { start: BigInt(T0 + 120) }],
    ['a higher premium than the cover can pay', { premium: 10n ** 12n }],
    ['another rate', { ratePerSecond: 1n }],
  ] as const

  for (const [name, change] of tampered) {
    it(`are refused before anything is signed: ${name}`, async () => {
      const { market, engine, signer } = setup()
      market.tamperQuotes((signed) => ({ ...signed, quote: { ...signed.quote, ...change } }))
      await engine.turnOn(warsaw, RATE)
      expect(engine.getState().stopped).toMatchObject({ kind: 'refused', refusal: { kind: 'invalid' } })
      expect(market.purchases).toHaveLength(0)
      expect(signer().timing().spentThisHour).toBe(0n)
    })
  }

  it('are refused when the stated digest is not the one the terms hash to', async () => {
    const { market, engine } = setup()
    market.tamperQuotes((signed) => ({ ...signed, digest: `0x${'00'.repeat(32)}` }))
    await engine.turnOn(warsaw, RATE)
    expect(engine.getState().stopped).toMatchObject({ refusal: { kind: 'invalid', cause: 'quote:digest' } })
  })
})

describe('locking the price for a shift', () => {
  it('prices the whole shift from where the paid-up cover ends, and buys it once', async () => {
    const { market, engine, signer } = setup()
    await engine.turnOn(warsaw, RATE)
    const offer = await engine.quoteShift(warsaw, RATE, 4 * 3600)
    expect(offer.price).toMatchObject({ start: T0 + 660, end: T0 + 660 + 4 * 3600, seconds: 4 * 3600 })

    const block = await engine.lockShift(offer)
    expect(block).toMatchObject({ kind: 'shift', start: T0 + 660, end: T0 + 660 + 4 * 3600 })
    expect(engine.getState().coveredUntil).toBe(T0 + 660 + 4 * 3600)
    expect(market.purchases.map(({ quote }) => quote.holder)).toEqual([signer().address, signer().address])
    await expect(engine.lockShift(offer)).rejects.toMatchObject({ refusal: { kind: 'already_bought' } })
    expect(market.overlaps()).toEqual([])
  })

  it('stops the switch from buying until the locked shift is nearly over', async () => {
    const { market, engine, run } = setup()
    await engine.turnOn(warsaw, RATE)
    await engine.lockShift(await engine.quoteShift(warsaw, RATE, 3600))
    await run(3600)
    expect(market.purchases).toHaveLength(2)
    await run(660)
    expect(market.purchases).toHaveLength(3)
    expect(Number(market.purchases[2]!.quote.start)).toBe(T0 + 660 + 3600)
    expect(market.overlaps()).toEqual([])
  })

  it('needs a passkey prompt above the hourly limit, and buys with one', async () => {
    const { market, engine, key, signer } = setup({}, { maxSpendPerHour: 50_000n })
    const offer = await engine.quoteShift(krakow, RATE, 4 * 3600)
    await expect(engine.lockShift(offer)).rejects.toBeInstanceOf(NeedsConfirmation)
    expect(market.purchases).toHaveLength(0)

    const stranger = session(market.now)
    await expect(
      engine.lockShift(offer, async (payment) => (await stranger.signCoverPayment(payment)).authorization),
    ).rejects.toMatchObject({ refusal: { kind: 'invalid' } })
    expect(market.purchases).toHaveLength(0)

    let prompts = 0
    const block = await engine.lockShift(offer, async (payment) => {
      prompts++
      const prompted = session(market.now, { maxSpendPerHour: 10n ** 12n }, key)
      try {
        return (await prompted.signCoverPayment(payment)).authorization
      } finally {
        prompted.end()
      }
    })
    expect(prompts).toBe(1)
    expect(block).toMatchObject({ kind: 'shift', premium: offer.signed.quote.premium })
    expect(market.purchases[0]!.quote.holder).toBe(signer().address)
    expect(signer().timing().spentThisHour).toBe(0n)
  })

  it('refuses an offer whose price ran out', async () => {
    const { market, engine } = setup()
    const offer = await engine.quoteShift(warsaw, RATE, 3600)
    market.advance(121)
    await expect(engine.lockShift(offer)).rejects.toMatchObject({ refusal: { kind: 'quote_expired' } })
  })

  it('reports why a shift cannot be priced', async () => {
    const { market, engine } = setup()
    market.failQuote(new ServiceFailure(422, 'window_too_long', 'x'))
    const error = await engine.quoteShift(warsaw, RATE, 13 * 3600).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(RefusalError)
    expect((error as RefusalError).refusal).toMatchObject({ kind: 'too_long', retry: 'never' })
  })

  it('moves the engine to the area of a shift locked while the switch is off', async () => {
    const { engine } = setup()
    await engine.lockShift(await engine.quoteShift(krakow, RATE, 3600))
    expect(engine.getState()).toMatchObject({ status: 'off', area: { key: krakow.key }, coveredUntil: T0 + 60 + 3600 })
  })
})

describe('showing the price before cover is on', () => {
  it('quotes the next block without buying it', async () => {
    const { market, engine } = setup()
    await engine.preview(warsaw, RATE)
    expect(market.purchases).toHaveLength(0)
    expect(engine.getState()).toMatchObject({ status: 'off', area: { key: warsaw.key }, priceRefusal: null })
    expect(engine.getState().price?.why?.slots).toHaveLength(1)
  })

  it('says why there is no price', async () => {
    const { market, engine } = setup()
    market.failQuote(new ServiceFailure(503, 'oracle_stale', 'x'))
    await engine.preview(warsaw, RATE)
    expect(engine.getState()).toMatchObject({ price: null, priceRefusal: { kind: 'weather_silent' } })
  })

  it('keeps only the answer to the latest question', async () => {
    const { engine, ports } = setup()
    const quote = ports.quote
    let release: () => void = () => undefined
    const held = new Promise<void>((resolve) => (release = resolve))
    ports.quote = async (request) => {
      if (request.lat === warsaw.lat) await held
      return quote(request)
    }
    const slow = engine.preview(warsaw, RATE)
    await engine.preview(krakow, RATE)
    release()
    await slow
    expect(engine.getState().area?.key).toBe(krakow.key)
  })
})
