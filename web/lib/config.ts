import { cellFromKey } from '@cover/core/cells'
import { getChain, isSupportedChainId } from '@cover/core/chains'
import { getAddress, isAddress, type Address } from 'viem'

export const PRODUCT_NAME = 'Pitter'

/** How cover is sold by default. Amounts are base units of the dollar (six decimals). */
export const COVER_DEFAULTS = {
  /** Length of one pay-as-you-go block. */
  blockSeconds: 600,
  /** Payout per second of heavy rain a holder can choose from. 2000 is $0.12 a minute. */
  rates: [1000n, 2000n, 5000n] as readonly bigint[],
  defaultRate: 2000n,
  /** Shift lengths offered when locking the price, in hours. */
  shiftHours: [1, 2, 4, 6, 8, 10, 12] as readonly number[],
  defaultShiftHours: 4,
  /** How long before the current block ends the next one is bought. */
  renewLeadSeconds: 45,
} as const

/** What a sign-in allows without asking again. */
export const SESSION_DEFAULTS = {
  /** A sign-in lasts one shift at most. */
  lengthMs: 4 * 60 * 60 * 1000,
  /** With cover off and nobody using the app, the sign-in ends after this long. */
  idleMs: 20 * 60 * 1000,
  /** Most that cover may cost per hour without asking again. */
  maxSpendPerHour: 5_000_000n,
  /** The sign-in is shown as about to end this long before it does. */
  warnMs: 5 * 60 * 1000,
} as const

export type RelayerBalance = 'ok' | 'low' | 'empty' | 'unknown'

/** What `/api/health` reports. Nothing in it is secret. */
export interface HealthReport {
  /** Server time, unix seconds. */
  time: number
  chainId: number
  contracts: ContractAddresses
  /** Whether the account that sends transactions for users can still do so. */
  relayer: { balance: RelayerBalance }
  /** Liveness of the weather check. Nulls mean the chain could not be read. */
  weather: {
    heartbeat: number | null
    ageSeconds: number | null
    maxAgeSeconds: number | null
    fresh: boolean | null
  }
  /** Practice mode: play money and the simulator area. Off on a live deployment. */
  practice: { enabled: boolean; simulator: { key: string; lat: number; lon: number } | null }
  paidCover: { enabled: boolean }
}

export interface ContractAddresses {
  token: Address
  coverBook: Address
  coverPool: Address
  weatherIndex: Address
}

/** Everything the browser needs to know about the deployment it talks to. */
export interface AppConfig {
  chainId: number
  explorerUrl: string
  /** Node the browser reads from. Public by definition. */
  rpcUrl: string
  multicall3: Address
  contracts: ContractAddresses
  /** Null outside practice mode. */
  practice: { simulator: { key: bigint; lat: number; lon: number } } | null
  paidCover: boolean
}

export class ConfigProblem extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigProblem'
  }
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const numberOrNull = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : null)

const BALANCES = new Set<RelayerBalance>(['ok', 'low', 'empty', 'unknown'])

/** Checks the shape of a health report. Throws `ConfigProblem` when it is not one. */
export function parseHealth(body: unknown): HealthReport {
  if (!isObject(body) || !isObject(body.contracts)) throw new ConfigProblem('not a health report')
  const address = (name: string): Address => {
    const value = (body.contracts as Record<string, unknown>)[name]
    if (typeof value !== 'string' || !isAddress(value, { strict: false })) {
      throw new ConfigProblem(`the health report has no ${name} address`)
    }
    return getAddress(value)
  }
  if (typeof body.chainId !== 'number' || typeof body.time !== 'number') {
    throw new ConfigProblem('the health report has no chain or time')
  }

  const relayer = isObject(body.relayer) ? body.relayer.balance : undefined
  const weather = isObject(body.weather) ? body.weather : {}
  const practice = isObject(body.practice) ? body.practice : {}
  const simulator = isObject(practice.simulator) ? practice.simulator : null
  const paidCover = isObject(body.paidCover) ? body.paidCover : {}

  return {
    time: body.time,
    chainId: body.chainId,
    contracts: {
      token: address('token'),
      coverBook: address('coverBook'),
      coverPool: address('coverPool'),
      weatherIndex: address('weatherIndex'),
    },
    relayer: { balance: BALANCES.has(relayer as RelayerBalance) ? (relayer as RelayerBalance) : 'unknown' },
    weather: {
      heartbeat: numberOrNull(weather.heartbeat),
      ageSeconds: numberOrNull(weather.ageSeconds),
      maxAgeSeconds: numberOrNull(weather.maxAgeSeconds),
      fresh: typeof weather.fresh === 'boolean' ? weather.fresh : null,
    },
    practice: {
      enabled: practice.enabled === true,
      simulator:
        practice.enabled === true &&
        simulator &&
        typeof simulator.key === 'string' &&
        /^[1-9]\d{0,77}$/.test(simulator.key) &&
        typeof simulator.lat === 'number' &&
        typeof simulator.lon === 'number'
          ? { key: simulator.key, lat: simulator.lat, lon: simulator.lon }
          : null,
    },
    paidCover: { enabled: paidCover.enabled === true },
  }
}

/**
 * Builds the browser configuration from what the server reports about itself, so the addresses the page uses
 * are always the ones the service signs and relays for.
 *
 * @param publicRpcUrl A node chosen at build time. Without one the chain's public node is used.
 */
export function configFromHealth(health: HealthReport, publicRpcUrl?: string): AppConfig {
  if (!isSupportedChainId(health.chainId)) throw new ConfigProblem(`chain ${health.chainId} is not supported`)
  const chain = getChain(health.chainId)
  const simulator = health.practice.enabled && !chain.testnet ? null : health.practice.simulator

  return {
    chainId: chain.id,
    explorerUrl: chain.explorerUrl,
    rpcUrl: publicRpcUrl?.trim() || chain.rpcUrl,
    multicall3: chain.multicall3,
    contracts: health.contracts,
    practice: health.practice.enabled && simulator ? { simulator: simulatorArea(BigInt(simulator.key)) } : null,
    paidCover: health.paidCover.enabled,
  }
}

function simulatorArea(key: bigint): { key: bigint; lat: number; lon: number } {
  const cell = cellFromKey(key)
  return { key, lat: cell.lat, lon: cell.lon }
}

/** Link to the public record of a transaction. */
export function transactionUrl(config: Pick<AppConfig, 'explorerUrl'>, hash: string): string {
  return `${config.explorerUrl}/tx/${hash}`
}

/** Link to the public record of an account or contract. */
export function accountUrl(config: Pick<AppConfig, 'explorerUrl'>, address: string): string {
  return `${config.explorerUrl}/address/${address}`
}
