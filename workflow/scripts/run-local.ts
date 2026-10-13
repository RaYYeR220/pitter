// Runs the weather oracle once, outside the Chainlink Runtime Environment, against the real weather sources.
//
//   bun scripts/run-local.ts --cells "52.23,21.01;59.88,-1.296"
//       observe the given points and print the report the oracle would write
//   bun scripts/run-local.ts --rpc http://127.0.0.1:8545 --cover-book 0x... --weather-index 0x...
//       read the cells with open policies from a chain and print the report
//   ... --submit
//       also send the report with WeatherIndex.submit (local chains only; needs REPORTER_KEY)
//
// Environment: REPORTER_KEY (signs the reports), SENDER_KEY (pays for --submit; defaults to the node's first
// unlocked account), WEATHER_USER_AGENT (overrides the userAgent of the config).
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type FetchLike, cellFromKey } from '@cover/core'
import { type Address, type Hex, zeroAddress } from 'viem'
import { configSchema, settingsFromConfig } from '../src/config'
import { type LocalRunResult, runLocal } from '../src/local'

const here = dirname(fileURLToPath(import.meta.url))

export type CliEnvironment = {
  env: Record<string, string | undefined>
  fetch: FetchLike
  print: (line: string) => void
  now?: () => number
}

type Flags = {
  config: string
  rpc?: string
  coverBook?: Address
  weatherIndex?: Address
  cells?: { lat: number; lon: number }[]
  submit: boolean
  json: boolean
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/
const PRIVATE_KEY = /^0x[0-9a-fA-F]{64}$/

function parseCells(value: string): { lat: number; lon: number }[] {
  return value.split(';').map((pair) => {
    const [lat, lon] = pair.split(',').map((part) => Number(part.trim()))
    if (lat === undefined || lon === undefined || !Number.isFinite(lat) || !Number.isFinite(lon)) {
      throw new Error(`not a "lat,lon" pair: ${pair}`)
    }
    return { lat, lon }
  })
}

function parseFlags(argv: string[]): Flags {
  const flags: Flags = { config: join(here, '..', 'config.testnet.json'), submit: false, json: false }
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    const value = () => {
      const next = argv[++i]
      if (next === undefined) throw new Error(`${flag} needs a value`)
      return next
    }
    const address = () => {
      const next = value()
      if (!ADDRESS.test(next)) throw new Error(`${flag} needs an address`)
      return next as Address
    }
    if (flag === '--config') flags.config = resolve(value())
    else if (flag === '--rpc') flags.rpc = value()
    else if (flag === '--cover-book') flags.coverBook = address()
    else if (flag === '--weather-index') flags.weatherIndex = address()
    else if (flag === '--cells') flags.cells = parseCells(value())
    else if (flag === '--submit') flags.submit = true
    else if (flag === '--json') flags.json = true
    else throw new Error(`unknown option ${flag}`)
  }
  return flags
}

function privateKey(env: CliEnvironment['env'], name: string): Hex | undefined {
  const raw = env[name]?.trim()
  if (!raw) return undefined
  const key = raw.startsWith('0x') ? raw : `0x${raw}`
  if (!PRIVATE_KEY.test(key)) throw new Error(`${name} is not a 32-byte hex private key`)
  return key as Hex
}

const time = (seconds: bigint | number) => new Date(Number(seconds) * 1000).toISOString().replace('.000Z', 'Z')

function printRun(result: LocalRunResult, print: (line: string) => void, signedByKnownKey: boolean) {
  const { summary } = result
  print(`time           ${time(summary.now)}`)
  print(`open cells     ${summary.activeCells}`)
  print(`HTTP requests  ${summary.httpRequests} of 15 allowed per run`)
  for (const failure of result.failures) print(`source failed  ${failure.provider}: ${failure.reason}`)

  print('')
  print('cells')
  for (const observation of result.observations) {
    const cell = cellFromKey(observation.key)
    const median = observation.medianMmPerHour === null ? 'no quorum' : `median ${observation.medianMmPerHour} mm/h`
    print(`  ${cell.lat.toFixed(3)}, ${cell.lon.toFixed(3)}  ${observation.verdict.toUpperCase().padEnd(7)} ${median}  (${observation.answered} sources)`)
    for (const source of Object.keys(observation.readings).sort()) {
      const reading = observation.readings[source]
      const value = !reading || reading.mmPerHour === null ? 'no answer' : `${reading.mmPerHour} mm/h at ${time(reading.observedAt ?? 0)}`
      print(`      ${source.padEnd(34)} ${value}`)
    }
  }

  print('')
  if (result.reports.length === 0) {
    print(`reports        none (${summary.outcome})`)
    return
  }
  result.reports.forEach((report, index) => {
    const delivered = summary.reports[index]
    const state = !result.submitted ? 'not sent (dry run)' : delivered?.accepted ? `accepted in ${delivered.txHash}` : 'NOT accepted'
    print(`report ${index + 1} of ${result.reports.length}  issued ${time(report.issuedAt)}  ${report.readings.length} readings  ${state}`)
    for (const reading of report.readings) {
      const cell = cellFromKey(reading.key)
      print(`  ${cell.lat.toFixed(3)}, ${cell.lon.toFixed(3)}  ${time(reading.from)} -> ${time(reading.to)}  wet ${reading.wetSeconds} s`)
    }
    print(`  digest     ${report.digest}`)
    print(`  signature  ${report.signature}${signedByKnownKey ? '' : '  (throwaway key: set REPORTER_KEY)'}`)
    print(`  payload    ${report.payload}`)
  })
}

export async function main(argv: string[], environment: CliEnvironment): Promise<LocalRunResult> {
  const flags = parseFlags(argv)
  const config = configSchema.parse(await Bun.file(flags.config).json())
  const userAgent = environment.env.WEATHER_USER_AGENT || config.userAgent
  const reporterKey = privateKey(environment.env, 'REPORTER_KEY')

  // Without a deployed index the signature is still produced, over a placeholder address.
  const settings = settingsFromConfig({
    ...config,
    userAgent,
    coverBook: flags.coverBook ?? (config.coverBook || (flags.cells ? zeroAddress : '')),
    weatherIndex: flags.weatherIndex ?? (config.weatherIndex || (flags.cells ? zeroAddress : '')),
  })

  const result = await runLocal({
    settings,
    fetch: environment.fetch,
    rpcUrl: flags.rpc,
    coverBook: flags.coverBook ?? (config.coverBook ? (config.coverBook as Address) : undefined),
    cells: flags.cells,
    reporterKey,
    senderKey: privateKey(environment.env, 'SENDER_KEY'),
    submit: flags.submit,
    now: environment.now,
    log: flags.json ? undefined : (message) => environment.print(`log            ${message}`),
  })

  if (flags.json) {
    environment.print(
      JSON.stringify(
        { summary: result.summary, observations: result.observations, reports: result.reports, failures: result.failures },
        (_, value) => (typeof value === 'bigint' ? value.toString() : value),
        2,
      ),
    )
  } else {
    printRun(result, environment.print, reporterKey !== undefined)
  }
  return result
}

if (import.meta.main) {
  main(process.argv.slice(2), { env: process.env, fetch, print: (line) => console.log(line) }).catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  })
}
