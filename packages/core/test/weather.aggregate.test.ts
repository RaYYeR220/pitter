import { describe, expect, it } from 'vitest'
import { aggregate, aggregateAll } from '../src/weather/aggregate'
import { fetchObservations } from '../src/weather/plan'
import type { CellTarget, ReadingsBySource } from '../src/weather/types'
import { recordedAt, recordedCell, replayFetch, type ReplayOptions } from './replay'

const userAgent = 'cover-tests/1.0 (unit tests)'
const cell = recordedCell('warsaw')

const readings = (...values: (number | null)[]): ReadingsBySource =>
  Object.fromEntries(values.map((mmPerHour, i) => [`source-${i}`, { mmPerHour, observedAt: mmPerHour === null ? null : 1000 }]))

async function observe(names: string[], options: ReplayOptions = {}) {
  const cells: CellTarget[] = names.map(recordedCell)
  const { observations } = await fetchObservations(cells, { fetch: replayFetch(options), now: recordedAt, userAgent })
  return aggregateAll(cells, observations)
}

describe('aggregate', () => {
  it('is wet when the median of the answers reaches the threshold', () => {
    expect(aggregate(cell, readings(0.4, 1.6, 2.0))).toMatchObject({ verdict: 'wet', medianMmPerHour: 1.6, answered: 3 })
    expect(aggregate(cell, readings(0.4, 0.8, 2.0))).toMatchObject({ verdict: 'dry', medianMmPerHour: 0.8 })
  })

  it('averages the two middle answers of an even count', () => {
    expect(aggregate(cell, readings(0.4, 0.4, 1.6, 5))).toMatchObject({ verdict: 'wet', medianMmPerHour: 1 })
    expect(aggregate(cell, readings(0, 0.4, 1.2, 5))).toMatchObject({ verdict: 'dry', medianMmPerHour: 0.8 })
    expect(aggregate(cell, readings(0.8, 1.2))).toMatchObject({ verdict: 'wet', medianMmPerHour: 1 })
  })

  it('counts exactly 1.0 mm/h as wet', () => {
    expect(aggregate(cell, readings(1, 1, 1)).verdict).toBe('wet')
    expect(aggregate(cell, readings(0.999, 0.999, 0.999)).verdict).toBe('dry')
  })

  it('gives no verdict with fewer than two answers', () => {
    expect(aggregate(cell, readings())).toMatchObject({ verdict: 'unknown', medianMmPerHour: null, answered: 0 })
    expect(aggregate(cell, readings(9))).toMatchObject({ verdict: 'unknown', medianMmPerHour: null, answered: 1 })
    expect(aggregate(cell, readings(9, null, null, null))).toMatchObject({ verdict: 'unknown', answered: 1 })
  })

  it('leaves sources without an answer out of the median', () => {
    expect(aggregate(cell, readings(null, 2, null, 4, null))).toMatchObject({ verdict: 'wet', medianMmPerHour: 3, answered: 2 })
  })

  it('takes the threshold as a parameter', () => {
    expect(aggregate(cell, readings(2, 2, 2), 2.5).verdict).toBe('dry')
    expect(aggregate(cell, readings(0.5, 0.5), 0.5).verdict).toBe('wet')
  })

  it('reports the cell and the readings it judged', () => {
    const input = readings(0, 3)
    expect(aggregate(cell, input)).toEqual({
      key: cell.key,
      verdict: 'wet',
      medianMmPerHour: 1.5,
      answered: 2,
      readings: input,
    })
  })
})

describe('aggregate over the recorded snapshot', () => {
  it('wet: every source reports rain at Sumburgh', async () => {
    const [sumburgh] = await observe(['sumburgh'])
    expect(sumburgh).toMatchObject({ verdict: 'wet', medianMmPerHour: 4.8, answered: 5 })
  })

  it('dry: every source reports no rain in Warsaw', async () => {
    const [warsaw] = await observe(['warsaw'])
    expect(warsaw).toMatchObject({ verdict: 'dry', medianMmPerHour: 0, answered: 5 })
  })

  it('sources disagree: the median decides', async () => {
    const [manchester, aberdeen, spadeadam, amsterdam] = await observe(['manchester', 'aberdeen', 'spadeadam', 'amsterdam'])
    // the airport reports no rain and one model stays below the trigger; three sources are above it
    expect(manchester).toMatchObject({ verdict: 'wet', medianMmPerHour: 1.2, answered: 5 })
    // one model reports rain; the other four sources do not
    expect(aberdeen).toMatchObject({ verdict: 'dry', medianMmPerHour: 0.1, answered: 5 })
    // the airport reports rain, the models are split
    expect(spadeadam).toMatchObject({ verdict: 'wet', medianMmPerHour: 1.2, answered: 4 })
    // drizzle at the airport, nothing in the models
    expect(amsterdam).toMatchObject({ verdict: 'dry', medianMmPerHour: 0, answered: 5 })
  })

  it('one source down: the remaining sources still decide', async () => {
    const down = { down: ['open-meteo'] as const }
    const [sumburgh, warsaw, bergen] = await observe(['sumburgh', 'warsaw', 'bergen'], down)
    expect(sumburgh).toMatchObject({ verdict: 'wet', medianMmPerHour: 6.95, answered: 2 })
    expect(warsaw).toMatchObject({ verdict: 'dry', medianMmPerHour: 0, answered: 2 })
    // only the airport observation is left for Bergen: one source is not enough
    expect(bergen).toMatchObject({ verdict: 'unknown', medianMmPerHour: null, answered: 1 })

    const [withoutAirports] = await observe(['sumburgh'], { unreachable: ['metar'] })
    expect(withoutAirports).toMatchObject({ verdict: 'wet', medianMmPerHour: 4.35, answered: 4 })
  })

  it('all sources down: no cell gets a verdict', async () => {
    const observed = await observe(['sumburgh', 'warsaw', 'manchester'], { down: ['open-meteo', 'metar', 'met-norway'] })
    expect(observed.map((observation) => observation.verdict)).toEqual(['unknown', 'unknown', 'unknown'])
    expect(observed.every((observation) => observation.answered === 0 && observation.medianMmPerHour === null)).toBe(true)
  })

  it('judges a cell with no airport nearby on the models alone', async () => {
    const [midAtlantic] = await observe(['mid-atlantic'])
    expect(midAtlantic).toMatchObject({ verdict: 'dry', medianMmPerHour: 0, answered: 3 })
  })
})
