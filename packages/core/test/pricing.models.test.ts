import { describe, expect, it } from 'vitest'
import { FORECAST_MODELS, type Forecast, fetchForecast, forecastRequest, parseForecast } from '../src/pricing/forecast'
import { ForecastUnavailableError, PRICING_DEFAULTS, type PriceSlot, quotePremium } from '../src/pricing/quote'
import { aggregateAll } from '../src/weather/aggregate'
import { METAR_NOMINAL_MM_PER_HOUR, METAR_SOURCE_ID, metarAreas, metarRequest, parseMetar } from '../src/weather/metar'
import { OPEN_METEO_MODELS } from '../src/weather/openMeteo'
import { fetchObservations } from '../src/weather/plan'
import type { ReadingsBySource } from '../src/weather/types'
import { forecastRecordedAt, recordedAt, recordedCell, recordedForecasts, replay, replayFetch } from './replay'

// The forecasts were recorded at 09:25:52 UTC from the three models the oracle settles from. Times below are
// UTC on that day.
const NOW = forecastRecordedAt
const clock = (hour: number, minute = 0) => NOW - (NOW % 86_400) + hour * 3600 + minute * 60
const RATE = 1000n // 0.001 dollars per wet second
const userAgent = 'cover-tests/1.0 (unit tests)'

const warsaw = recordedCell('warsaw')
const moscow = recordedCell('moscow')

const bodyOf = (name: string): string => {
  const recorded = recordedForecasts.find((forecast) => forecast.name === name)
  if (!recorded) throw new Error(`no recorded forecast for ${name}`)
  return recorded.body
}
const forecastOf = (name: string): Forecast => parseForecast(bodyOf(name))

/** The recorded answer with one model's series removed, as if that model had not answered. */
function without(name: string, model: string): string {
  const body = JSON.parse(bodyOf(name)) as Record<string, Record<string, unknown>>
  for (const section of ['minutely_15', 'hourly']) {
    for (const key of Object.keys(body[section] ?? {})) {
      if (key.endsWith(`_${model}`)) delete body[section]?.[key]
    }
  }
  return JSON.stringify(body)
}

const quote = (name: string, start: number, end: number, extra: Partial<Parameters<typeof quotePremium>[0]> = {}) =>
  quotePremium({ cell: recordedCell(name), start, end, ratePerSecond: RATE, forecast: forecastOf(name), now: NOW, ...extra })

const why = (slots: PriceSlot[]) =>
  slots.map((slot) => [slot.model, slot.basis, slot.forecastMmPerHour, slot.precipitationProbability, slot.probabilityWet])

describe('forecast from the settlement models', () => {
  it('asks for the models the oracle settles from, in one request', () => {
    expect(FORECAST_MODELS).toEqual([...OPEN_METEO_MODELS])
    expect(forecastRequest(warsaw).url).toBe(
      'https://api.open-meteo.com/v1/forecast?latitude=52.225&longitude=21.025&minutely_15=precipitation' +
        '&hourly=precipitation_probability,precipitation&models=icon_seamless,gfs_seamless,meteofrance_seamless' +
        '&forecast_minutely_15=104&forecast_hours=26&timeformat=unixtime&timezone=UTC',
    )
  })

  it('parses one forecast per model and keeps the wettest of them at the top level', async () => {
    const forecast = await fetchForecast(moscow, replayFetch())
    const models = forecast.models ?? []
    expect(models.map((model) => model.model)).toEqual(['icon_seamless', 'gfs_seamless', 'meteofrance_seamless'])
    for (const model of models) {
      expect(model.minutely15.time).toEqual(forecast.minutely15.time)
      expect(model.minutely15.precipitation).toHaveLength(104)
      expect(model.hourly.precipitation).toHaveLength(26)
    }
    // Météo-France gives amounts but no chance of rain.
    expect(models[2]?.hourly.precipitationProbability.every((value) => value === null)).toBe(true)

    // 09:30-09:45: ICON 0.2 mm, GFS 0.1 mm, Météo-France 0.3 mm
    expect(forecast.minutely15.time[2]).toBe(clock(9, 45))
    expect(models.map((model) => model.minutely15.precipitation[2])).toEqual([0.2, 0.1, 0.3])
    expect(forecast.minutely15.precipitation[2]).toBe(0.3)
    for (const [i, value] of forecast.minutely15.precipitation.entries()) {
      expect(value).toBe(Math.max(...models.map((model) => model.minutely15.precipitation[i] ?? 0)))
    }
    for (const [i, value] of forecast.hourly.precipitationProbability.entries()) {
      expect(value).toBe(Math.max(...models.map((model) => model.hourly.precipitationProbability[i] ?? 0)))
    }
    expect(forecast.hourly.precipitation?.[4]).toBe(0.8)
  })

  it('leaves out a model that did not answer', () => {
    const missing = parseForecast(without('moscow', 'meteofrance_seamless'))
    expect(missing.models?.map((model) => model.model)).toEqual(['icon_seamless', 'gfs_seamless'])
    expect(missing.minutely15.precipitation[2]).toBe(0.2)

    const body = JSON.parse(bodyOf('moscow'))
    body.minutely_15.precipitation_gfs_seamless = body.minutely_15.precipitation_gfs_seamless.map(() => null)
    body.hourly.precipitation_gfs_seamless = body.hourly.precipitation_gfs_seamless.map(() => null)
    body.hourly.precipitation_probability_gfs_seamless = body.hourly.precipitation_probability_gfs_seamless.map(() => null)
    expect(parseForecast(JSON.stringify(body)).models?.map((model) => model.model)).toEqual([
      'icon_seamless',
      'meteofrance_seamless',
    ])
  })

  it('still reads an answer for the default model, including its hourly amounts', () => {
    const forecast = parseForecast(
      JSON.stringify({
        minutely_15: { time: [900, 1800], precipitation: [0.1, 0.2] },
        hourly: { time: [3600], precipitation_probability: [40], precipitation: [0.6] },
      }),
    )
    expect(forecast).toEqual({
      minutely15: { time: [900, 1800], precipitation: [0.1, 0.2] },
      hourly: { time: [3600], precipitationProbability: [40], precipitation: [0.6] },
    })
  })
})

describe('price from the wettest settlement model', () => {
  it('models disagree: each slot is priced from the wettest of them', () => {
    const quoted = quote('moscow', clock(9, 30), clock(10, 30))
    expect(why(quoted.slots)).toEqual([
      // Météo-France forecasts 1.2 mm/h, above the trigger; ICON 0.8 mm/h, GFS 0.4 mm/h with an 85% chance
      ['meteofrance_seamless', 'nowcast', 1.2, null, 1],
      ['meteofrance_seamless', 'nowcast', 1.2, null, 1],
      // GFS gives a 68% chance of rain in the hour; ICON 20%, Météo-France 0.4 mm/h
      ['gfs_seamless', 'hourly', 0.4, 68, 0.68],
      ['gfs_seamless', 'hourly', 0.4, 68, 0.68],
    ])
    expect(quoted.models).toEqual(['icon_seamless', 'gfs_seamless', 'meteofrance_seamless'])
    expect(quoted.expectedWetSeconds).toBe(3024)
    expect(quoted.premium).toBe(3_780_000n)
  })

  it('is never cheaper than any one of the models', () => {
    for (const name of ['warsaw', 'bergen', 'moscow', 'sydney']) {
      const forecast = forecastOf(name)
      const window = { cell: recordedCell(name), start: clock(9, 30), end: clock(21, 30), ratePerSecond: RATE, now: NOW }
      const combined = quotePremium({ ...window, forecast })
      const singles = (forecast.models ?? []).map((model) => quotePremium({ ...window, forecast: { ...forecast, models: [model] } }))
      expect(singles).toHaveLength(3)
      combined.slots.forEach((slot, i) => {
        expect(slot.probabilityWet).toBe(Math.max(...singles.map((single) => single.slots[i]?.probabilityWet ?? 0)))
      })
      for (const single of singles) expect(combined.premium).toBeGreaterThanOrEqual(single.premium)
    }
  })

  it('prices beyond two hours from the hourly forecast, amounts included', () => {
    // Météo-France expects 0.8 mm in the hour but gives no chance of rain; GFS gives 38%, ICON 5%.
    const quoted = quote('moscow', clock(12), clock(13))
    expect(why(quoted.slots)).toEqual(Array(4).fill(['meteofrance_seamless', 'hourly', 0.8, null, 0.8]))
    expect(quoted.premium).toBe(3_600_000n)
  })

  it('one model missing: the others still price the window', () => {
    const quoted = quotePremium({
      cell: moscow,
      start: clock(9, 30),
      end: clock(10),
      ratePerSecond: RATE,
      forecast: parseForecast(without('moscow', 'meteofrance_seamless')),
      now: NOW,
    })
    expect(quoted.models).toEqual(['icon_seamless', 'gfs_seamless'])
    expect(why(quoted.slots)).toEqual(Array(2).fill(['gfs_seamless', 'hourly', 0.4, 85, 0.85]))
    expect(quoted.premium).toBe(1_912_500n)
    expect(quoted.premium).toBeLessThan(quote('moscow', clock(9, 30), clock(10)).premium)
  })

  it('refuses a slot for which no model has a value', () => {
    const forecast = forecastOf('warsaw')
    const blank = (forecast.models ?? []).map((model) => ({
      ...model,
      minutely15: { ...model.minutely15, precipitation: model.minutely15.precipitation.map(() => null) },
      hourly: {
        ...model.hourly,
        precipitationProbability: model.hourly.precipitationProbability.map(() => null),
        precipitation: model.hourly.precipitation.map(() => null),
      },
    }))
    expect(() =>
      quotePremium({ cell: warsaw, start: clock(10), end: clock(10, 15), ratePerSecond: RATE, forecast: { ...forecast, models: blank }, now: NOW }),
    ).toThrow(ForecastUnavailableError)
  })

  it('all dry: every slot is priced at the 1% floor', () => {
    const quoted = quote('warsaw', clock(14), clock(16))
    expect(quoted.slots).toHaveLength(8)
    expect(why(quoted.slots)).toEqual(Array(8).fill(['icon_seamless', 'floor', 0, 0, 0.01]))
    expect(quoted.slots.every((slot) => slot.observationFloor === false)).toBe(true)
    expect(quoted.expectedWetSeconds).toBe(72)
    expect(quoted.premium).toBe(90_000n)

    // GFS's 1% chance in the coming hour is no more than the floor either
    expect(why(quote('warsaw', clock(9, 30), clock(10)).slots)).toEqual(Array(2).fill(['gfs_seamless', 'floor', 0, 1, 0.01]))
  })
})

describe('observation floor', () => {
  /** What the sources said about Warsaw in the recorded snapshot: dry everywhere. */
  async function warsawReadings(): Promise<ReadingsBySource> {
    const { observations } = await fetchObservations([warsaw], { fetch: replayFetch(), now: recordedAt, userAgent })
    const readings = observations.get(warsaw.key)
    if (!readings) throw new Error('no readings for Warsaw')
    return readings
  }

  /** The recorded airport report for Warsaw, with its present weather replaced. */
  function airportReporting(wx: string) {
    const [area] = metarAreas([warsaw])
    const recorded = replay(metarRequest(area!, userAgent).url)
    const stations = JSON.parse(recorded?.body ?? '[]') as { icaoId: string; wxString?: string }[]
    const changed = stations.map((station) => (station.icaoId === 'EPWA' ? { ...station, wxString: wx } : station))
    const reading = parseMetar(JSON.stringify(changed), [warsaw], recordedAt).get(warsaw.key)
    expect(reading?.station).toBe('EPWA')
    return reading!
  }

  const withinHour = [true, true, true, true, false, false, false, false]

  it('is 90% for the coming hour by default', () => {
    expect(PRICING_DEFAULTS).toMatchObject({ observedWetBps: 9000, observationWindowSeconds: 3600 })
  })

  it('METAR says rain while every model is dry: slots starting within the hour are priced at 90%', async () => {
    const readings = await warsawReadings()
    expect(Object.values(readings).every((reading) => reading.mmPerHour === 0)).toBe(true)
    const airport = airportReporting('-RA')
    expect(airport.mmPerHour).toBe(METAR_NOMINAL_MM_PER_HOUR.light)
    const observed = { ...readings, [METAR_SOURCE_ID]: airport }

    const dry = quote('warsaw', clock(9, 30), clock(11, 30))
    const raining = quote('warsaw', clock(9, 30), clock(11, 30), { observed })

    expect(dry.slots.map((slot) => slot.probabilityWet)).toEqual([0.01, 0.01, 0.02, 0.02, 0.02, 0.02, 0.03, 0.03])
    expect(dry.premium).toBe(180_000n)
    // slots from 09:30 to 10:15 start within an hour of the quote at 09:25:52; 10:30 does not
    expect(raining.slots.map((slot) => slot.probabilityWet)).toEqual([0.9, 0.9, 0.9, 0.9, 0.02, 0.02, 0.03, 0.03])
    expect(raining.slots.map((slot) => slot.observationFloor)).toEqual(withinHour)
    // the floor lifts the price; the slot still names the forecast it would otherwise have been priced from
    expect(dry.slots.map((slot) => slot.basis)).toEqual(['floor', 'floor', ...Array(6).fill('hourly')])
    expect(raining.slots.map((slot) => [slot.model, slot.basis])).toEqual(Array(8).fill(['gfs_seamless', 'hourly']))
    expect(raining.expectedWetSeconds).toBe(3330)
    expect(raining.premium).toBe(4_162_500n)
  })

  it('counts rain at the airport even when it is lighter than the trigger', async () => {
    const observed = { ...(await warsawReadings()), [METAR_SOURCE_ID]: airportReporting('-RA') }
    const quoted = quote('warsaw', clock(9, 30), clock(11, 30), { observed, thresholdMmPerHour: 4 })
    expect(quoted.slots.map((slot) => slot.observationFloor)).toEqual(withinHour)
  })

  it('does not count drizzle or showers in the vicinity', async () => {
    const readings = await warsawReadings()
    for (const wx of ['DZ', '-DZ', 'VCSH']) {
      const quoted = quote('warsaw', clock(9, 30), clock(11, 30), { observed: { ...readings, [METAR_SOURCE_ID]: airportReporting(wx) } })
      expect(quoted.slots.some((slot) => slot.observationFloor)).toBe(false)
      expect(quoted.premium).toBe(180_000n)
    }
  })

  it('applies when any settlement source reports rain at the trigger, and takes the oracle observation as well', async () => {
    const cells = ['sumburgh', 'warsaw', 'manchester'].map(recordedCell)
    const { observations } = await fetchObservations(cells, { fetch: replayFetch(), now: recordedAt, userAgent })
    const [sumburgh, dryWarsaw, manchester] = aggregateAll(cells, observations)
    expect([sumburgh?.verdict, dryWarsaw?.verdict, manchester?.verdict]).toEqual(['wet', 'dry', 'wet'])

    const floored = (observed: Parameters<typeof quotePremium>[0]['observed']) =>
      quote('warsaw', clock(9, 30), clock(11, 30), { observed }).slots.map((slot) => slot.observationFloor)
    expect(floored(sumburgh)).toEqual(withinHour)
    expect(floored(dryWarsaw)).toEqual(Array(8).fill(false))
    // Manchester's airport saw no rain, but MET Norway and two of the models were at or above the trigger
    expect(manchester?.readings[METAR_SOURCE_ID]?.mmPerHour).toBe(0)
    expect(floored(manchester?.readings)).toEqual(withinHour)
    expect(floored({})).toEqual(Array(8).fill(false))
  })

  it('leaves slots that are already wetter as they are', () => {
    const observed = { [METAR_SOURCE_ID]: { mmPerHour: METAR_NOMINAL_MM_PER_HOUR.moderate, observedAt: NOW - 600 } }
    const quoted = quote('moscow', clock(9, 30), clock(10, 30), { observed })
    expect(quoted.slots.map((slot) => [slot.model, slot.probabilityWet, slot.observationFloor])).toEqual([
      ['meteofrance_seamless', 1, false],
      ['meteofrance_seamless', 1, false],
      ['gfs_seamless', 0.9, true],
      ['gfs_seamless', 0.9, true],
    ])
  })

  it('takes the floor and the window as parameters', () => {
    const observed = { 'open-meteo:icon_seamless': { mmPerHour: 2, observedAt: NOW - 600 } }
    const quoted = quote('warsaw', clock(9, 30), clock(11, 30), { observed, observedWetBps: 5000, observationWindowSeconds: 1800 })
    expect(quoted.slots.map((slot) => slot.probabilityWet)).toEqual([0.5, 0.5, 0.02, 0.02, 0.02, 0.02, 0.03, 0.03])
    expect(() => quote('warsaw', clock(9, 30), clock(10), { observed, observedWetBps: 10_001 })).toThrow(RangeError)
    expect(() => quote('warsaw', clock(9, 30), clock(10), { observed, observationWindowSeconds: -1 })).toThrow(RangeError)
  })
})
