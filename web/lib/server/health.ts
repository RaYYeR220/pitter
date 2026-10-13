import 'server-only'
import { coverBookAbi, weatherIndexAbi } from '@cover/core/abi'
import { cellFromKey } from '@cover/core/cells'
import { createPublicClient, http, type Address } from 'viem'
import type { HealthReport, RelayerBalance } from '../config'
import { getService, serverConfig } from './service'

/** A relayer holding less than this many times its own floor is reported as running low. */
const LOW_MULTIPLE = 3n

const CACHE_MS = 10_000

let cached: { at: number; report: Promise<HealthReport> } | null = null

export function relayerBand(balance: bigint, floor: bigint): RelayerBalance {
  if (balance < floor) return 'empty'
  return balance < floor * LOW_MULTIPLE ? 'low' : 'ok'
}

async function build(): Promise<HealthReport> {
  const { settings, secrets } = serverConfig()
  const service = await getService()
  const client = createPublicClient({ transport: http(secrets.rpcUrl, { timeout: 8_000, retryCount: 1 }) })
  const time = Math.floor(Date.now() / 1000)

  const read = async <T>(work: () => Promise<T>): Promise<T | null> => {
    try {
      return await work()
    } catch {
      return null
    }
  }
  const [balance, heartbeat, maxAge, block] = await Promise.all([
    read(() => client.getBalance({ address: service.relayerAddress as Address })),
    read(() =>
      client.readContract({ address: settings.contracts.weatherIndex, abi: weatherIndexAbi, functionName: 'heartbeat' }),
    ),
    read(() =>
      client.readContract({ address: settings.contracts.coverBook, abi: coverBookAbi, functionName: 'maxOracleAge' }),
    ),
    read(() => client.getBlock({ blockTag: 'latest' })),
  ])

  const chainTime = block ? Number(block.timestamp) : time
  const age = heartbeat === null ? null : Math.max(0, chainTime - Number(heartbeat))
  const simulatorKey = settings.sandbox.enabled ? settings.sandbox.simulatorKey : null
  const simulator = simulatorKey === null ? null : cellFromKey(simulatorKey)

  return {
    time,
    chainId: settings.chainId,
    contracts: settings.contracts,
    relayer: { balance: balance === null ? 'unknown' : relayerBand(balance, settings.relayer.minBalance) },
    weather: {
      heartbeat: heartbeat === null ? null : Number(heartbeat),
      ageSeconds: age,
      maxAgeSeconds: maxAge === null ? null : Number(maxAge),
      fresh: age === null || maxAge === null ? null : age <= Number(maxAge),
    },
    practice: {
      enabled: settings.sandbox.enabled && simulator !== null,
      simulator:
        simulatorKey !== null && simulator ? { key: simulatorKey.toString(), lat: simulator.lat, lon: simulator.lon } : null,
    },
    paidCover: { enabled: settings.x402.enabled },
  }
}

/** What `/api/health` answers. Kept for a few seconds, so a busy page does not turn into a busy node. */
export function health(): Promise<HealthReport> {
  const now = Date.now()
  if (!cached || now - cached.at > CACHE_MS) {
    const report = build()
    cached = { at: now, report }
    report.catch(() => {
      if (cached?.report === report) cached = null
    })
  }
  return cached.report
}
