import { recordedAt, recordedCell, replay, type ReplayOptions } from '@cover/core/testing'
import type { FetchLike } from '@cover/core/weather'
import { describe, expect, it } from 'vitest'
import { OBSERVATIONS_UNAVAILABLE, corePricing, type CoreOptions } from '../../src/adapters/core'
import type { PriceRequest } from '../../src/ports'

/** The moment the recorded weather snapshot was taken: Warsaw was dry, Sumburgh was raining. */
const NOW = recordedAt
const HOUR = Math.floor(NOW / 3_600) * 3_600
const warsaw = recordedCell('warsaw')
const sumburgh = recordedCell('sumburgh')

/** A dry forecast for six hours from the top of the hour: no rain, a 5% chance of it every hour. */
function dryForecast(): string {
  const quarters = Array.from({ length: 24 }, (_, i) => HOUR + (i + 1) * 900)
  const hours = Array.from({ length: 6 }, (_, i) => HOUR + (i + 1) * 3_600)
  return JSON.stringify({
    minutely_15: { time: quarters, precipitation: quarters.map(() => 0) },
    hourly: { time: hours, precipitation_probability: hours.map(() => 5), precipitation: hours.map(() => 0) },
  })
}

interface Sources {
  fetch: FetchLike
  forecastCalls: string[]
  observationCalls: string[]
}

/** The forecast from `dryForecast`, the weather sources from the recorded snapshot. */
function sources(
  options: ReplayOptions & { forecastStatus?: number; hang?: 'forecast' | 'observations' } = {},
): Sources {
  const forecastCalls: string[] = []
  const observationCalls: string[] = []
  const never = new Promise<never>(() => undefined)
  const fetch: FetchLike = async (url) => {
    if (url.includes('hourly=')) {
      forecastCalls.push(url)
      if (options.hang === 'forecast') return never
      const status = options.forecastStatus ?? 200
      return { status, text: async () => (status === 200 ? dryForecast() : 'unavailable') }
    }
    observationCalls.push(url)
    if (options.hang === 'observations') return never
    const answer = replay(url, options)
    if (answer === null) throw new TypeError('fetch failed')
    return { status: answer.status, text: async () => answer.body }
  }
  return { fetch, forecastCalls, observationCalls }
}

const pricingWith = (fetch: FetchLike, extra: Partial<CoreOptions> = {}) =>
  corePricing({ fetch, userAgent: 'test', ...extra })

/** A window starting at the next minute two minutes out, `minutes` long. */
function window(cell: { key: bigint; lat: number; lon: number }, minutes = 30, aheadSeconds = 120): PriceRequest {
  const start = Math.ceil((NOW + aheadSeconds) / 60) * 60
  return { ...cell, start, end: start + minutes * 60, ratePerSecond: 1_000n, now: NOW }
}

interface Slot {
  start: number
  probabilityWet: number
  model: string | null
  observationFloor: boolean
}

interface Inputs {
  models: string[]
  observation: { status: string; verdict: string; sources: number; observedAt: number }
  slots: Slot[]
}

const inputsOf = (price: { inputs: unknown }) => price.inputs as Inputs

describe('pricing with current observations', () => {
  it('prices a dry cell from the forecast alone', async () => {
    const pricing = pricingWith(sources().fetch)

    const price = await pricing.price(window(warsaw))
    const inputs = inputsOf(price)

    expect(price.warnings).toEqual([])
    expect(inputs.observation).toEqual({ status: 'live', verdict: 'dry', sources: 5, observedAt: NOW })
    expect(inputs.models).toEqual(['best_match'])
    expect(inputs.slots.length).toBeGreaterThan(0)
    for (const slot of inputs.slots) {
      expect(slot).toMatchObject({ model: 'best_match', observationFloor: false, probabilityWet: 0.05 })
    }
  })

  it('lifts the coming hour to the observation floor while a source reports rain', async () => {
    const pricing = pricingWith(sources().fetch)

    const raining = await pricing.price(window(sumburgh))
    const dry = await pricing.price(window(warsaw))

    expect(inputsOf(raining).observation).toMatchObject({ status: 'live', verdict: 'wet', sources: 5 })
    expect(raining.warnings).toEqual([])
    for (const slot of inputsOf(raining).slots) {
      expect(slot.observationFloor).toBe(true)
      expect(slot.probabilityWet).toBeGreaterThanOrEqual(0.9)
    }
    expect(raining.premium).toBeGreaterThan(dry.premium * 10n)
  })

  it('leaves windows beyond the coming hour to the forecast', async () => {
    const pricing = pricingWith(sources().fetch)

    const later = await pricing.price(window(sumburgh, 30, 2 * 3_600))

    expect(inputsOf(later).slots.every((slot) => !slot.observationFloor && slot.probabilityWet === 0.05)).toBe(true)
  })

  describe('when the sources cannot be read', () => {
    it('prices as if it might be raining now, and says so', async () => {
      const down = sources({ unreachable: ['open-meteo', 'metar', 'met-norway'] })
      const pricing = pricingWith(down.fetch)

      const price = await pricing.price(window(warsaw))
      const live = await pricingWith(sources().fetch).price(window(warsaw))

      expect(price.warnings).toEqual([OBSERVATIONS_UNAVAILABLE])
      expect(inputsOf(price).observation).toEqual({
        status: 'unavailable',
        verdict: 'unknown',
        sources: 0,
        observedAt: NOW,
      })
      for (const slot of inputsOf(price).slots) {
        expect(slot.observationFloor).toBe(true)
        expect(slot.probabilityWet).toBeGreaterThanOrEqual(0.9)
      }
      expect(price.premium).toBeGreaterThan(live.premium)
    })

    it('still prices a later window from the forecast, with the warning', async () => {
      const pricing = pricingWith(sources({ unreachable: ['open-meteo', 'metar', 'met-norway'] }).fetch)

      const later = await pricing.price(window(warsaw, 30, 2 * 3_600))

      expect(later.warnings).toEqual([OBSERVATIONS_UNAVAILABLE])
      expect(inputsOf(later).slots.every((slot) => !slot.observationFloor)).toBe(true)
    })

    it('treats too few answering sources as no observation', async () => {
      const pricing = pricingWith(sources({ down: ['open-meteo', 'met-norway'] }).fetch)

      const price = await pricing.price(window(warsaw))

      expect(inputsOf(price).observation).toMatchObject({ status: 'unavailable', sources: 1 })
      expect(inputsOf(price).slots.every((slot) => slot.observationFloor)).toBe(true)
    })

    it('does not wait on sources that hang', async () => {
      const pricing = pricingWith(sources({ hang: 'observations' }).fetch, { observationTimeoutMs: 20 })

      const price = await pricing.price(window(warsaw))

      expect(price.warnings).toEqual([OBSERVATIONS_UNAVAILABLE])
    })
  })

  describe('caching', () => {
    it('asks the sources once per cell per minute, however many quotes arrive', async () => {
      const recorded = sources()
      const pricing = pricingWith(recorded.fetch)

      await Promise.all(Array.from({ length: 8 }, () => pricing.price(window(warsaw))))
      const perObservation = recorded.observationCalls.length
      await pricing.price({ ...window(warsaw), now: NOW + 59 })

      expect(perObservation).toBeGreaterThan(0)
      expect(recorded.observationCalls).toHaveLength(perObservation)
      expect(recorded.forecastCalls).toHaveLength(1)

      await pricing.price({ ...window(warsaw), now: NOW + 60 })
      expect(recorded.observationCalls).toHaveLength(2 * perObservation)

      await pricing.price(window(sumburgh))
      expect(recorded.observationCalls.length).toBeGreaterThan(2 * perObservation)
    })

    it('asks again sooner after the sources failed', async () => {
      let offline = true
      const live = sources()
      const failing = sources({ unreachable: ['open-meteo', 'metar', 'met-norway'] })
      const pricing = pricingWith(async (url, init) => (offline ? failing.fetch(url, init) : live.fetch(url, init)))

      const first = await pricing.price(window(warsaw))
      offline = false
      const cached = await pricing.price({ ...window(warsaw), now: NOW + 10 })
      const recovered = await pricing.price({ ...window(warsaw), now: NOW + 15 })

      expect(first.warnings).toEqual([OBSERVATIONS_UNAVAILABLE])
      expect(cached.warnings).toEqual([OBSERVATIONS_UNAVAILABLE])
      expect(recovered.warnings).toEqual([])
    })
  })

  describe('without a forecast', () => {
    it('refuses to price, and asks again next time', async () => {
      const recorded = sources({ forecastStatus: 503 })
      const pricing = pricingWith(recorded.fetch)

      await expect(pricing.price(window(warsaw))).rejects.toThrow()
      await expect(pricing.price(window(warsaw))).rejects.toThrow()

      expect(recorded.forecastCalls).toHaveLength(2)
    })

    it('does not wait on a forecast that hangs', async () => {
      const pricing = pricingWith(sources({ hang: 'forecast' }).fetch, { forecastTimeoutMs: 20 })

      await expect(pricing.price(window(warsaw))).rejects.toThrow(/in time/)
    })
  })
})
