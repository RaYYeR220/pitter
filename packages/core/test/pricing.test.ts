import { describe, expect, it } from 'vitest'
import { type Forecast, fetchForecast, parseForecast } from '../src/pricing/forecast'
import { ForecastUnavailableError, PRICING_DEFAULTS, quotePremium } from '../src/pricing/quote'
import defaultForecasts from './fixtures/forecast-default.json'
import { recordedCell } from './replay'

// A forecast that names no models: Open-Meteo's default model, as callers built before the price was taken from
// the settlement models still pass. `fixtures/forecast-default.json` was recorded at 06:58:01 UTC with
// `minutely_15=precipitation&hourly=precipitation_probability` and no `models`; 07:00 UTC is the reference for
// the windows below. Pricing from the models the oracle settles from is tested in `pricing.models.test.ts`.
const NOW = defaultForecasts.recordedAt
const T0700 = NOW - (NOW % 3600) + 3600
const minutes = (n: number) => n * 60
const RATE = 1000n // 0.001 dollars per wet second

const forecastOf = (name: string): Forecast => {
  const recorded = defaultForecasts.forecasts.find((forecast) => forecast.name === name)
  if (!recorded) throw new Error(`no recorded forecast for ${name}`)
  return parseForecast(JSON.stringify(recorded.body))
}

const warsaw = recordedCell('warsaw')
const sumburgh = recordedCell('sumburgh')
const manchester = recordedCell('manchester')

describe('forecast without named models', () => {
  it('parses the default-model answer as one series, without models', () => {
    const forecast = forecastOf('sumburgh')
    expect(forecast.models).toBeUndefined()
    expect(forecast.minutely15.time).toHaveLength(104)
    expect(forecast.minutely15.time[0]).toBe(T0700 - minutes(15))
    expect(forecast.minutely15.precipitation.slice(0, 7)).toEqual([1, 1, 0.5, 0.5, 0.5, 0.5, 0])
    expect(forecast.hourly.time).toHaveLength(26)
    expect(forecast.hourly.time[0]).toBe(T0700 - minutes(60))
    expect(forecast.hourly.precipitationProbability.slice(0, 6)).toEqual([100, 100, 100, 100, 76, 42])
    expect(forecast.hourly.precipitation).toBeUndefined()
  })

  it('fails when the source refuses or answers without data', async () => {
    await expect(fetchForecast(warsaw, async () => ({ status: 429, text: async () => '' }))).rejects.toThrow('status 429')
    expect(() => parseForecast('{"error":true}')).toThrow('no time steps')
  })

  it('keeps gaps in the data as gaps', () => {
    const forecast = parseForecast(
      JSON.stringify({
        minutely_15: { time: [900, 1800], precipitation: [null, 0.2] },
        hourly: { time: [3600], precipitation_probability: [null] },
      }),
    )
    expect(forecast.minutely15.precipitation).toEqual([null, 0.2])
    expect(forecast.hourly.precipitationProbability).toEqual([null])
  })
})

describe('quotePremium from a forecast without named models', () => {
  it('uses a 1% floor and a 25% load by default', () => {
    expect(PRICING_DEFAULTS).toMatchObject({ floorBps: 100, loadBps: 2500, thresholdMmPerHour: 1, nowcastHorizonSeconds: 7200 })
  })

  it('prices a dry ten minutes in Warsaw from the hourly chance of rain', () => {
    const quote = quotePremium({
      cell: warsaw,
      start: T0700 + minutes(10),
      end: T0700 + minutes(20),
      ratePerSecond: RATE,
      forecast: forecastOf('warsaw'),
      now: NOW,
    })
    expect(quote.slots).toEqual([
      {
        start: T0700 + minutes(10),
        end: T0700 + minutes(15),
        seconds: 300,
        forecastMmPerHour: 0,
        precipitationProbability: 2,
        probabilityWet: 0.02,
        basis: 'hourly',
        model: 'best_match',
        observationFloor: false,
      },
      {
        start: T0700 + minutes(15),
        end: T0700 + minutes(20),
        seconds: 300,
        forecastMmPerHour: 0,
        precipitationProbability: 2,
        probabilityWet: 0.02,
        basis: 'hourly',
        model: 'best_match',
        observationFloor: false,
      },
    ])
    expect(quote.expectedWetSeconds).toBe(12)
    expect(quote.maxPayout).toBe(600_000n)
    expect(quote.expectedPayout).toBe(12_000n)
    expect(quote.premium).toBe(15_000n)
    expect(quote.key).toBe(warsaw.key)
    expect(quote.loadBps).toBe(2500)
    expect(quote.floorBps).toBe(100)
    expect(quote.models).toEqual(['best_match'])
  })

  it('applies the floor when the forecast gives no chance of rain', () => {
    const quote = quotePremium({
      cell: warsaw,
      start: T0700 + minutes(300),
      end: T0700 + minutes(360),
      ratePerSecond: RATE,
      forecast: forecastOf('warsaw'),
      now: NOW,
    })
    expect(quote.slots).toHaveLength(4)
    expect(quote.slots.every((slot) => slot.basis === 'floor' && slot.probabilityWet === 0.01)).toBe(true)
    expect(quote.slots[0]?.precipitationProbability).toBe(0)
    expect(quote.expectedWetSeconds).toBe(36)
    expect(quote.premium).toBe(45_000n)
  })

  it('charges more than the payout while the nowcast shows rain above the trigger', () => {
    const quote = quotePremium({
      cell: sumburgh,
      start: T0700,
      end: T0700 + minutes(30),
      ratePerSecond: RATE,
      forecast: forecastOf('sumburgh'),
      now: NOW,
    })
    expect(quote.slots.map((slot) => [slot.forecastMmPerHour, slot.probabilityWet, slot.basis])).toEqual([
      [2, 1, 'nowcast'],
      [2, 1, 'nowcast'],
    ])
    expect(quote.expectedWetSeconds).toBe(1800)
    expect(quote.maxPayout).toBe(1_800_000n)
    expect(quote.premium).toBe(2_250_000n)
    expect(quote.premium).toBeGreaterThan(quote.maxPayout)
  })

  it('does not sell cheap cover when the nowcast is dry but rain is likely within the hour', () => {
    const quote = quotePremium({
      cell: manchester,
      start: T0700 + minutes(15),
      end: T0700 + minutes(45),
      ratePerSecond: RATE,
      forecast: forecastOf('manchester'),
      now: NOW,
    })
    expect(quote.slots.map((slot) => [slot.forecastMmPerHour, slot.precipitationProbability, slot.probabilityWet, slot.basis])).toEqual([
      [0, 97, 0.97, 'hourly'],
      [0, 97, 0.97, 'hourly'],
    ])
    expect(quote.premium).toBe(2_182_500n)
  })

  it('scales the nowcast below the trigger into a probability', () => {
    const forecast: Forecast = {
      minutely15: { time: [T0700 + minutes(15), T0700 + minutes(30)], precipitation: [0.1, 0.2] },
      hourly: { time: [T0700 + minutes(60)], precipitationProbability: [10] },
    }
    const quote = quotePremium({ cell: warsaw, start: T0700, end: T0700 + minutes(30), ratePerSecond: RATE, forecast, now: NOW })
    expect(quote.slots.map((slot) => [slot.forecastMmPerHour, slot.probabilityWet, slot.basis])).toEqual([
      [0.4, 0.4, 'nowcast'],
      [0.8, 0.8, 'nowcast'],
    ])
    expect(quote.expectedWetSeconds).toBe(1080)
    expect(quote.premium).toBe(1_350_000n)
  })

  it('prices beyond two hours from the hourly probability only', () => {
    const forecast = forecastOf('sumburgh')
    const quote = quotePremium({
      cell: sumburgh,
      start: T0700 + minutes(135),
      end: T0700 + minutes(195),
      ratePerSecond: RATE,
      forecast,
      now: NOW,
    })
    // 09:15-10:00 falls in the hour that ends at 10:00 (76%), 10:00-10:15 in the hour that ends at 11:00 (42%)
    expect(quote.slots.map((slot) => [slot.seconds, slot.precipitationProbability, slot.probabilityWet, slot.basis])).toEqual([
      [900, 76, 0.76, 'hourly'],
      [900, 76, 0.76, 'hourly'],
      [900, 76, 0.76, 'hourly'],
      [900, 42, 0.42, 'hourly'],
    ])
    expect(quote.slots.every((slot) => slot.forecastMmPerHour === null)).toBe(true)
    expect(quote.expectedWetSeconds).toBe(2430)
    expect(quote.premium).toBe(3_037_500n)
  })

  it('cuts the window along the 15-minute grid of the forecast', () => {
    const quote = quotePremium({
      cell: warsaw,
      start: T0700 + minutes(10),
      end: T0700 + minutes(40),
      ratePerSecond: RATE,
      forecast: forecastOf('warsaw'),
      now: NOW,
    })
    expect(quote.slots.map((slot) => [slot.start - T0700, slot.end - T0700, slot.seconds])).toEqual([
      [600, 900, 300],
      [900, 1800, 900],
      [1800, 2400, 600],
    ])
    expect(quote.slots.reduce((total, slot) => total + slot.seconds, 0)).toBe(1800)
  })

  it('rounds the premium up to a whole base unit', () => {
    const quote = quotePremium({
      cell: warsaw,
      start: T0700 + minutes(10),
      end: T0700 + minutes(11),
      ratePerSecond: 1n,
      forecast: forecastOf('warsaw'),
      now: NOW,
    })
    // 60 s at 2% is 1.2 wet seconds; with the load that is 1.5 base units
    expect(quote.expectedWetSeconds).toBe(1.2)
    expect(quote.expectedPayout).toBe(1n)
    expect(quote.premium).toBe(2n)
  })

  it('is proportional to the rate and grows with the window', () => {
    const base = { cell: manchester, start: T0700, forecast: forecastOf('manchester'), now: NOW }
    const short = quotePremium({ ...base, end: T0700 + minutes(30), ratePerSecond: RATE })
    const long = quotePremium({ ...base, end: T0700 + minutes(240), ratePerSecond: RATE })
    const tenfold = quotePremium({ ...base, end: T0700 + minutes(30), ratePerSecond: RATE * 10n })
    expect(long.premium).toBeGreaterThan(short.premium)
    expect(tenfold.premium).toBe(short.premium * 10n)
  })

  it('takes the load, the floor and the trigger as parameters', () => {
    const base = {
      cell: warsaw,
      start: T0700 + minutes(300),
      end: T0700 + minutes(360),
      ratePerSecond: RATE,
      forecast: forecastOf('warsaw'),
      now: NOW,
    }
    expect(quotePremium({ ...base, loadBps: 0 }).premium).toBe(36_000n)
    expect(quotePremium({ ...base, floorBps: 500 }).premium).toBe(225_000n)
    const drizzle: Forecast = {
      minutely15: { time: [T0700 + minutes(15)], precipitation: [0.1] },
      hourly: { time: [T0700 + minutes(60)], precipitationProbability: [0] },
    }
    const strict = quotePremium({ cell: warsaw, start: T0700, end: T0700 + minutes(15), ratePerSecond: RATE, forecast: drizzle, now: NOW, thresholdMmPerHour: 4 })
    expect(strict.slots[0]?.probabilityWet).toBe(0.1)
  })

  it('refuses to price a window the forecast does not cover', () => {
    const forecast = forecastOf('warsaw')
    const beyond = { cell: warsaw, ratePerSecond: RATE, forecast, now: NOW, start: T0700 + minutes(60 * 30), end: T0700 + minutes(60 * 31) }
    expect(() => quotePremium(beyond)).toThrow(ForecastUnavailableError)

    const gap: Forecast = {
      minutely15: { time: [T0700 + minutes(15)], precipitation: [null] },
      hourly: { time: [T0700 + minutes(60)], precipitationProbability: [null] },
    }
    expect(() => quotePremium({ cell: warsaw, start: T0700, end: T0700 + minutes(15), ratePerSecond: RATE, forecast: gap, now: NOW })).toThrow(
      'no forecast for',
    )
  })

  it('rejects windows and rates the contracts would not accept', () => {
    const base = { cell: warsaw, ratePerSecond: RATE, forecast: forecastOf('warsaw'), now: NOW }
    expect(() => quotePremium({ ...base, start: T0700 + 30, end: T0700 + minutes(10) })).toThrow(RangeError)
    expect(() => quotePremium({ ...base, start: T0700, end: T0700 + 90 })).toThrow(RangeError)
    expect(() => quotePremium({ ...base, start: T0700 + minutes(10), end: T0700 + minutes(10) })).toThrow(RangeError)
    expect(() => quotePremium({ ...base, start: T0700 + minutes(20), end: T0700 + minutes(10) })).toThrow(RangeError)
    expect(() => quotePremium({ ...base, start: T0700, end: T0700 + minutes(10), ratePerSecond: 0n })).toThrow(RangeError)
  })
})
