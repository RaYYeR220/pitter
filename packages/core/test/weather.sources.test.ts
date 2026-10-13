import { describe, expect, it } from 'vitest'
import { keyFromLatLon } from '../src/cells'
import {
  METAR_NOMINAL_MM_PER_HOUR,
  METAR_SOURCE_ID,
  metarAreas,
  metarRequest,
  parseMetar,
  rainRateFromWeather,
} from '../src/weather/metar'
import { MET_NORWAY_SOURCE_ID, metNorwayRequest, parseMetNorway } from '../src/weather/metNorway'
import { OPEN_METEO_MODELS, openMeteoRequest, parseOpenMeteo } from '../src/weather/openMeteo'
import { fetchObservations, planRequests, readResponses, targetsFromKeys } from '../src/weather/plan'
import type { CellTarget } from '../src/weather/types'
import { recordedAt, recordedCell, recordedCells, replay, replayFetch } from './replay'

const userAgent = 'cover-tests/1.0 (unit tests)'
const warsaw = recordedCell('warsaw')
const sumburgh = recordedCell('sumburgh')
const manchester = recordedCell('manchester')
const bergen = recordedCell('bergen')
const midAtlantic = recordedCell('mid-atlantic')

const body = (url: string) => {
  const answer = replay(url)
  if (!answer) throw new Error(`no recorded answer for ${url}`)
  return answer.body
}

describe('Open-Meteo', () => {
  it('asks for every cell and every model in one request', () => {
    const request = openMeteoRequest([warsaw, sumburgh])
    expect(request.url).toBe(
      'https://api.open-meteo.com/v1/forecast?latitude=52.225,59.875&longitude=21.025,-1.275' +
        '&minutely_15=precipitation&models=icon_seamless,gfs_seamless,meteofrance_seamless' +
        '&past_minutely_15=1&forecast_minutely_15=1&timeformat=unixtime&timezone=UTC',
    )
    expect(request.keys).toEqual([warsaw.key, sumburgh.key])
  })

  it('reads the latest finished 15-minute step of each model as mm/h', () => {
    const cells = [warsaw, sumburgh]
    const readings = parseOpenMeteo(body(openMeteoRequest(cells).url), cells, OPEN_METEO_MODELS, recordedAt)
    const step = recordedAt - (recordedAt % 900)
    expect(readings.get(sumburgh.key)).toEqual({
      'open-meteo:icon_seamless': { mmPerHour: 3.6, observedAt: step },
      'open-meteo:gfs_seamless': { mmPerHour: 5.2, observedAt: step },
      'open-meteo:meteofrance_seamless': { mmPerHour: 4.8, observedAt: step },
    })
    expect(readings.get(warsaw.key)?.['open-meteo:gfs_seamless']).toEqual({ mmPerHour: 0, observedAt: step })
  })

  it('accepts the single-object answer the API gives for one location', () => {
    const readings = parseOpenMeteo(body(openMeteoRequest([sumburgh]).url), [sumburgh], OPEN_METEO_MODELS, recordedAt)
    expect(readings.get(sumburgh.key)?.['open-meteo:icon_seamless']?.mmPerHour).toBe(3.6)
  })

  it('gives no reading for a model the answer does not contain', () => {
    const models = ['icon_seamless', 'icon_d2']
    const readings = parseOpenMeteo(body(openMeteoRequest([warsaw]).url), [warsaw], models, recordedAt)
    expect(readings.get(warsaw.key)).toEqual({
      'open-meteo:icon_seamless': { mmPerHour: 0, observedAt: recordedAt - (recordedAt % 900) },
      'open-meteo:icon_d2': { mmPerHour: null, observedAt: null },
    })
  })

  it('ignores steps that have not ended yet and steps that are too old', () => {
    const answer = JSON.stringify({
      minutely_15: { time: [1000, 1900, 2800], precipitation_icon_seamless: [0.5, 0.25, 9], precipitation_gfs_seamless: [0.1, null, null] },
    })
    const models = ['icon_seamless', 'gfs_seamless']
    const at = (now: number) => parseOpenMeteo(answer, [warsaw], models, now).get(warsaw.key)
    expect(at(2000)).toEqual({
      'open-meteo:icon_seamless': { mmPerHour: 1, observedAt: 1900 },
      'open-meteo:gfs_seamless': { mmPerHour: 0.4, observedAt: 1000 },
    })
    expect(at(999)?.['open-meteo:icon_seamless']).toEqual({ mmPerHour: null, observedAt: null })
    expect(at(2800 + 3601)?.['open-meteo:icon_seamless']).toEqual({ mmPerHour: null, observedAt: null })
  })

  it('refuses an answer for a different number of locations', () => {
    const answer = body(openMeteoRequest([warsaw, sumburgh]).url)
    expect(() => parseOpenMeteo(answer, [warsaw], OPEN_METEO_MODELS, recordedAt)).toThrow('2 locations, expected 1')
  })
})

describe('METAR present weather', () => {
  it.each([
    [undefined, 0],
    ['', 0],
    ['-RA', METAR_NOMINAL_MM_PER_HOUR.light],
    ['RA', METAR_NOMINAL_MM_PER_HOUR.moderate],
    ['+RA', METAR_NOMINAL_MM_PER_HOUR.heavy],
    ['-SHRA', METAR_NOMINAL_MM_PER_HOUR.light],
    ['SHRA', METAR_NOMINAL_MM_PER_HOUR.moderate],
    ['TSRA', METAR_NOMINAL_MM_PER_HOUR.moderate],
    ['+TSRA', METAR_NOMINAL_MM_PER_HOUR.heavy],
    ['FZRA', METAR_NOMINAL_MM_PER_HOUR.moderate],
    ['-RADZ', METAR_NOMINAL_MM_PER_HOUR.light],
    ['RASN', METAR_NOMINAL_MM_PER_HOUR.moderate],
    ['DZ RA', METAR_NOMINAL_MM_PER_HOUR.moderate],
    ['-RA BR', METAR_NOMINAL_MM_PER_HOUR.light],
    ['DZ', METAR_NOMINAL_MM_PER_HOUR.drizzle],
    ['-DZ', METAR_NOMINAL_MM_PER_HOUR.drizzle],
    ['VCSH', 0],
    ['VCTSRA', 0],
    ['RERA', 0],
    ['SN', 0],
    ['TS', 0],
    ['MIFG BR', 0],
    ['HZ', 0],
    ['FU', 0],
  ])('%s -> %d mm/h', (wx, expected) => {
    expect(rainRateFromWeather(wx)).toBe(expected)
  })

  it('treats light rain as above the trigger and drizzle as below it', () => {
    expect(METAR_NOMINAL_MM_PER_HOUR.light).toBeGreaterThanOrEqual(1)
    expect(METAR_NOMINAL_MM_PER_HOUR.drizzle).toBeLessThan(1)
  })
})

describe('METAR stations', () => {
  it('asks for a box of 40 km around a single cell', () => {
    const [area, ...rest] = metarAreas([warsaw])
    expect(rest).toEqual([])
    const request = metarRequest(area!, userAgent)
    expect(request.url).toBe('https://aviationweather.gov/api/data/metar?bbox=51.86,20.43,52.59,21.62&format=json')
    expect(request.headers).toEqual({ 'User-Agent': userAgent })
    expect(request.keys).toEqual([warsaw.key])
  })

  it('shares one request between nearby cells and splits distant ones', () => {
    const areas = metarAreas([warsaw, recordedCell('warsaw-block-0-0'), manchester, recordedCell('shawbury'), midAtlantic])
    expect(areas.map((area) => area.cells.length).sort()).toEqual([1, 2, 2])
    for (const area of areas) {
      expect(area.north - area.south).toBeLessThanOrEqual(6)
      expect(area.east - area.west).toBeLessThanOrEqual(10)
    }
  })

  it('uses the nearest station within 40 km', () => {
    const [area] = metarAreas([warsaw])
    const readings = parseMetar(body(metarRequest(area!, userAgent).url), [warsaw], recordedAt)
    const reading = readings.get(warsaw.key)
    expect(reading?.station).toBe('EPWA')
    expect(reading?.distanceKm).toBeGreaterThan(5)
    expect(reading?.distanceKm).toBeLessThan(10)
    expect(reading?.mmPerHour).toBe(0)
    expect(recordedAt - (reading?.observedAt ?? 0)).toBeLessThan(90 * 60)
  })

  it('reads heavy rain at Sumburgh and none at Bergen from the same answer', () => {
    const [area] = metarAreas([sumburgh, bergen])
    const readings = parseMetar(body(metarRequest(area!, userAgent).url), [sumburgh, bergen], recordedAt)
    expect(readings.get(sumburgh.key)).toMatchObject({ station: 'EGPB', mmPerHour: METAR_NOMINAL_MM_PER_HOUR.heavy })
    expect(readings.get(bergen.key)).toMatchObject({ station: 'ENBR', mmPerHour: 0 })
  })

  it('gives no reading where no station is in range', () => {
    const [area] = metarAreas([midAtlantic])
    const answer = replay(metarRequest(area!, userAgent).url)
    expect(answer).toEqual({ status: 204, body: '' })
    expect(parseMetar('', [midAtlantic], recordedAt).get(midAtlantic.key)).toEqual({
      mmPerHour: null,
      observedAt: null,
      station: null,
      distanceKm: null,
    })
    const farStation = JSON.stringify([{ icaoId: 'EPWA', lat: 52.163, lon: 20.961, obsTime: recordedAt, wxString: 'RA' }])
    expect(parseMetar(farStation, [manchester], recordedAt).get(manchester.key)?.mmPerHour).toBeNull()
  })

  it('ignores observations older than 90 minutes and prefers the newest per station', () => {
    const station = { icaoId: 'EPWA', lat: 52.163, lon: 20.961 }
    const stale = JSON.stringify([{ ...station, obsTime: recordedAt - 91 * 60, wxString: 'RA' }])
    expect(parseMetar(stale, [warsaw], recordedAt).get(warsaw.key)?.mmPerHour).toBeNull()
    const two = JSON.stringify([
      { ...station, obsTime: recordedAt - 3600, wxString: '+RA' },
      { ...station, obsTime: recordedAt - 600 },
    ])
    expect(parseMetar(two, [warsaw], recordedAt).get(warsaw.key)).toMatchObject({ mmPerHour: 0, observedAt: recordedAt - 600 })
  })
})

describe('MET Norway', () => {
  it('asks for one cell and identifies the caller', () => {
    const request = metNorwayRequest(sumburgh, userAgent)
    expect(request.url).toBe('https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=59.875&lon=-1.275')
    expect(request.headers).toEqual({ 'User-Agent': userAgent })
  })

  it('reads the precipitation of the current hour', () => {
    const hour = recordedAt - (recordedAt % 3600)
    expect(parseMetNorway(body(metNorwayRequest(sumburgh, userAgent).url), recordedAt)).toEqual({ mmPerHour: 3.9, observedAt: hour })
    expect(parseMetNorway(body(metNorwayRequest(warsaw, userAgent).url), recordedAt)).toEqual({ mmPerHour: 0, observedAt: hour })
  })

  it('moves to the next hourly step when the hour changes and gives up on a stale forecast', () => {
    const answer = body(metNorwayRequest(manchester, userAgent).url)
    const hour = recordedAt - (recordedAt % 3600)
    expect(parseMetNorway(answer, hour + 3600 + 5).observedAt).toBe(hour + 3600)
    expect(parseMetNorway(answer, hour - 1)).toEqual({ mmPerHour: null, observedAt: null })
    expect(parseMetNorway(answer, hour + 4 * 3600 + 2 * 3600 + 1)).toEqual({ mmPerHour: null, observedAt: null })
  })

  it('refuses an answer without a time series', () => {
    expect(() => parseMetNorway('{"properties":{}}', recordedAt)).toThrow('no time series')
  })
})

describe('request plan', () => {
  const named = recordedCells.slice(0, 13)

  it('reproduces the requests the snapshot was recorded with', () => {
    const calls: string[] = []
    for (const request of planRequests(recordedCells, { userAgent })) replay(request.url, { calls })
    expect(calls).toHaveLength(15)
    expect(calls.filter((url) => url.includes('open-meteo'))).toHaveLength(1)
    expect(calls.filter((url) => url.includes('aviationweather'))).toHaveLength(8)
    expect(calls.filter((url) => url.includes('api.met.no'))).toHaveLength(6)
  })

  it('makes three requests for one cell: models, airport observation, MET Norway', () => {
    expect(planRequests([warsaw], { userAgent }).map((request) => request.provider)).toEqual([
      'open-meteo',
      'metar',
      'met-norway',
    ])
  })

  it('never exceeds the request budget and spends it on batched sources first', () => {
    for (const maxRequests of [0, 1, 2, 5, 9, 12, 15]) {
      const plan = planRequests(named, { userAgent, maxRequests })
      expect(plan.length).toBeLessThanOrEqual(maxRequests)
      expect(plan.map((request) => request.provider)).toEqual(
        ['open-meteo', ...Array(8).fill('metar'), ...Array(6).fill('met-norway')].slice(0, maxRequests),
      )
    }
  })

  it('covers a whole city of cells with three requests plus MET Norway while the budget lasts', () => {
    const block = recordedCells.filter((cell) => cell.name.startsWith('warsaw-block'))
    expect(block.length).toBeGreaterThan(20)
    const plan = planRequests(block, { userAgent })
    expect(plan.filter((request) => request.provider === 'open-meteo')).toHaveLength(1)
    expect(plan.filter((request) => request.provider === 'metar')).toHaveLength(1)
    expect(plan.filter((request) => request.provider === 'met-norway')).toHaveLength(13)
    expect(plan).toHaveLength(15)
  })

  it('splits the model request above 200 cells', () => {
    const many: CellTarget[] = Array.from({ length: 450 }, (_, i) => {
      const lat = 50.025 + 0.05 * (i % 30)
      const lon = 19.025 + 0.05 * Math.floor(i / 30)
      return { key: keyFromLatLon(lat, lon), lat, lon }
    })
    const plan = planRequests(many, { userAgent })
    expect(plan.filter((request) => request.provider === 'open-meteo').map((request) => request.keys.length)).toEqual([200, 200, 50])
    expect(plan.length).toBeLessThanOrEqual(15)
  })

  it('plans nothing for no cells', () => {
    expect(planRequests([], { userAgent })).toEqual([])
  })

  it('maps index keys to cell centres and leaves out keys it cannot report on', () => {
    const otherTrigger = (2n << 64n) | (warsaw.key & ((1n << 64n) - 1n))
    const offGrid = (1n << 64n) | (9999n << 32n)
    expect(targetsFromKeys([warsaw.key, otherTrigger, offGrid, sumburgh.key, warsaw.key])).toEqual([warsaw, sumburgh])
  })
})

describe('reading the sources', () => {
  const cells = [warsaw, sumburgh, manchester, recordedCell('aberdeen')]
  const sourcesOf = (readings: Record<string, { mmPerHour: number | null }> | undefined) =>
    Object.fromEntries(Object.entries(readings ?? {}).map(([source, reading]) => [source, reading.mmPerHour]))

  it('collects what every source says about every cell', async () => {
    const { observations, failures, requests } = await fetchObservations(cells, { fetch: replayFetch(), now: recordedAt, userAgent })
    expect(failures).toEqual([])
    expect(requests.length).toBeLessThanOrEqual(15)
    expect(sourcesOf(observations.get(sumburgh.key))).toEqual({
      'open-meteo:icon_seamless': 3.6,
      'open-meteo:gfs_seamless': 5.2,
      'open-meteo:meteofrance_seamless': 4.8,
      [METAR_SOURCE_ID]: 10,
      [MET_NORWAY_SOURCE_ID]: 3.9,
    })
    expect(sourcesOf(observations.get(warsaw.key))).toEqual({
      'open-meteo:icon_seamless': 0,
      'open-meteo:gfs_seamless': 0,
      'open-meteo:meteofrance_seamless': 0,
      [METAR_SOURCE_ID]: 0,
      [MET_NORWAY_SOURCE_ID]: 0,
    })
  })

  it('has no airport reading for a cell far from any station, and no MET Norway reading beyond the budget', async () => {
    const { observations, failures, requests } = await fetchObservations([bergen, midAtlantic], {
      fetch: replayFetch(),
      now: recordedAt,
      userAgent,
      maxRequests: 3,
    })
    expect(failures).toEqual([])
    expect(requests.map((request) => request.provider)).toEqual(['open-meteo', 'metar', 'metar'])
    expect(sourcesOf(observations.get(midAtlantic.key))).toEqual({
      'open-meteo:icon_seamless': 0,
      'open-meteo:gfs_seamless': 0,
      'open-meteo:meteofrance_seamless': 0,
      [METAR_SOURCE_ID]: null,
    })
    expect(sourcesOf(observations.get(bergen.key))[METAR_SOURCE_ID]).toBe(0)
    expect(observations.get(bergen.key)).not.toHaveProperty(MET_NORWAY_SOURCE_ID)
  })

  it('sends the identifying User-Agent to the sources that require one', async () => {
    const seen: Record<string, string | undefined> = {}
    const fetch = replayFetch()
    await fetchObservations([warsaw], {
      fetch: (url, init) => {
        seen[new URL(url).host] = init?.headers?.['User-Agent']
        return fetch(url, init)
      },
      now: recordedAt,
      userAgent,
    })
    expect(seen).toEqual({ 'api.open-meteo.com': undefined, 'aviationweather.gov': userAgent, 'api.met.no': userAgent })
  })

  it('keeps the other sources when one answers with an error', async () => {
    const { observations, failures } = await fetchObservations(cells, {
      fetch: replayFetch({ down: ['open-meteo'] }),
      now: recordedAt,
      userAgent,
    })
    expect(failures).toEqual([{ provider: 'open-meteo', url: expect.stringContaining('api.open-meteo.com'), reason: 'status 503' }])
    expect(sourcesOf(observations.get(sumburgh.key))).toEqual({
      'open-meteo:icon_seamless': null,
      'open-meteo:gfs_seamless': null,
      'open-meteo:meteofrance_seamless': null,
      [METAR_SOURCE_ID]: 10,
      [MET_NORWAY_SOURCE_ID]: 3.9,
    })
  })

  it('keeps the other sources when one cannot be reached at all', async () => {
    const { observations, failures } = await fetchObservations(cells, {
      fetch: replayFetch({ unreachable: ['metar'] }),
      now: recordedAt,
      userAgent,
    })
    expect(failures.map((failure) => failure.reason)).toEqual(['no response', 'no response', 'no response'])
    expect(sourcesOf(observations.get(sumburgh.key))[METAR_SOURCE_ID]).toBeNull()
    expect(sourcesOf(observations.get(sumburgh.key))['open-meteo:gfs_seamless']).toBe(5.2)
  })

  it('has no reading for any cell when every source is down', async () => {
    const { observations, failures, requests } = await fetchObservations(cells, {
      fetch: replayFetch({ down: ['open-meteo', 'metar', 'met-norway'], status: 500 }),
      now: recordedAt,
      userAgent,
    })
    expect(failures).toHaveLength(requests.length)
    for (const cell of cells) {
      const values = Object.values(sourcesOf(observations.get(cell.key)))
      expect(values.length).toBeGreaterThan(0)
      expect(values.every((value) => value === null)).toBe(true)
    }
  })

  it('treats an unreadable answer as a failure of that source only', () => {
    const requests = planRequests([warsaw], { userAgent })
    const results = requests.map((request) =>
      request.provider === 'metar' ? { status: 200, body: '<html>maintenance</html>' } : replay(request.url),
    )
    const { observations, failures } = readResponses([warsaw], requests, results, recordedAt)
    expect(failures).toHaveLength(1)
    expect(failures[0]?.provider).toBe('metar')
    expect(sourcesOf(observations.get(warsaw.key))).toEqual({
      'open-meteo:icon_seamless': 0,
      'open-meteo:gfs_seamless': 0,
      'open-meteo:meteofrance_seamless': 0,
      [METAR_SOURCE_ID]: null,
      [MET_NORWAY_SOURCE_ID]: 0,
    })
  })
})
