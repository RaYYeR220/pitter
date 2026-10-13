import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import * as core from '../src/index'

const srcDir = join(__dirname, '..', 'src')

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return sourceFiles(path)
    return name.endsWith('.ts') ? [path] : []
  })
}

describe('package surface', () => {
  it('exports the ABIs, the cell math, the typed data helpers, the oracle and the pricing model', () => {
    for (const name of [
      'coverBookAbi',
      'coverPoolAbi',
      'weatherIndexAbi',
      'testDollarAbi',
      'multicall3Abi',
      'chains',
      'getDeployment',
      'cellFromLatLon',
      'keyFromLatLon',
      'hashQuote',
      'hashReport',
      'signQuote',
      'planRequests',
      'readResponses',
      'fetchObservations',
      'aggregate',
      'buildReport',
      'signReport',
      'encodeReport',
      'sealReports',
      'quotePremium',
      'fetchForecast',
      'FORECAST_MODELS',
      'DEFAULT_FORECAST_MODEL',
      'CONTRACT_REFUSALS',
      'contractRefusal',
    ]) {
      expect(core).toHaveProperty(name)
    }
  })

  it('exposes the functions the oracle calls on the contracts', () => {
    const functions = (abi: readonly { type: string; name?: string }[]) =>
      abi.filter((entry) => entry.type === 'function').map((entry) => entry.name)
    expect(functions(core.coverBookAbi)).toEqual(expect.arrayContaining(['activeCells', 'hashQuote', 'buy', 'settle']))
    expect(functions(core.weatherIndexAbi)).toEqual(
      expect.arrayContaining(['lastTo', 'onReport', 'submit', 'hashReport', 'heartbeat', 'wetSeconds']),
    )
  })

  it('matches the deployed interface: served areas, the oldest-open mark, exits that wait for cover', () => {
    const functions = (abi: readonly { type: string; name?: string }[]) =>
      abi.filter((entry) => entry.type === 'function').map((entry) => entry.name)
    expect(functions(core.coverBookAbi)).toEqual(
      expect.arrayContaining(['oldestOpenId', 'syncOldestOpen', 'servedOnly', 'isServed', 'servedKeys']),
    )
    expect(functions(core.coverPoolAbi)).toEqual(expect.arrayContaining(['claimBlockedByCover', 'treasury']))
    const redeemRequests = core.coverPoolAbi.find(
      (entry) => entry.type === 'function' && entry.name === 'redeemRequests',
    ) as { outputs: readonly { name: string }[] } | undefined
    expect(redeemRequests?.outputs.map((output) => output.name)).toEqual([
      'shares',
      'assetsAtRequest',
      'claimableAt',
      'lastPolicyAtRequest',
    ])
    // Reports are always signature-checked: the switch and its event are gone.
    expect(functions(core.weatherIndexAbi)).not.toContain('requireReporterSig')
    const items = core.weatherIndexAbi as readonly { name?: string }[]
    expect(items.some((entry) => entry.name === 'RequireReporterSigSet')).toBe(false)
  })

  it('stays free of platform APIs so that it bundles for the oracle runtime', () => {
    const forbidden = [
      /from ['"]node:/,
      /require\(/,
      /\bimport\(/,
      /\bprocess\./,
      /\bBuffer\b/,
      /\bglobalThis\b/,
      /\bsetTimeout\b/,
      /\bDate\.now\(/,
      /\bnew Date\(\)/,
      /\bMath\.random\(/,
      /(?<![\w.])fetch\(/,
    ]
    for (const file of sourceFiles(srcDir)) {
      const source = readFileSync(file, 'utf8')
      for (const pattern of forbidden) {
        expect(pattern.test(source), `${file} matches ${pattern}`).toBe(false)
      }
    }
  })
})
