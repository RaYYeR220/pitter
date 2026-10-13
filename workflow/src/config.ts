import { getDeployment, isDeployed } from '@cover/core'
import type { Address } from 'viem'
import { z } from 'zod'
import type { OracleSettings } from './oracle'

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/)

export const configSchema = z.object({
  /** Cron expression with seconds. The run starts a little after the minute so that the minute it reports has passed. */
  schedule: z.string(),
  chainSelectorName: z.string(),
  isTestnet: z.boolean(),
  chainId: z.number().int().positive(),
  /** Leave empty to use the address recorded for the chain in `@cover/core`. */
  coverBook: z.union([address, z.literal('')]),
  weatherIndex: z.union([address, z.literal('')]),
  multicall3: address,
  /** Identifies the operator to the weather sources. MET Norway rejects anonymous callers. */
  userAgent: z.string().min(8),
  thresholdMmPerHour: z.number().positive(),
  intervalSeconds: z.number().int().positive(),
  maxHttpRequests: z.number().int().min(1).max(15),
  /** Cell observed while no policy is open, to keep the index heartbeat fresh. Null switches the heartbeat off. */
  heartbeatCell: z.object({ lat: z.number(), lon: z.number() }).nullable(),
  httpTimeout: z.string(),
  httpCacheMaxAge: z.string(),
  gasLimitBase: z.string().regex(/^\d+$/),
  gasLimitPerReading: z.string().regex(/^\d+$/),
})

export type Config = z.infer<typeof configSchema>

/** The contracts a run talks to: from the config when set, otherwise from the recorded deployment. */
export function contractAddresses(config: Config): { coverBook: Address; weatherIndex: Address } {
  if (config.coverBook !== '' && config.weatherIndex !== '') {
    return { coverBook: config.coverBook as Address, weatherIndex: config.weatherIndex as Address }
  }
  if (!isDeployed(config.chainId)) {
    throw new Error(`no contract addresses for chain ${config.chainId}: set coverBook and weatherIndex in the config`)
  }
  const deployment = getDeployment(config.chainId)
  return {
    coverBook: (config.coverBook || deployment.coverBook) as Address,
    weatherIndex: (config.weatherIndex || deployment.weatherIndex) as Address,
  }
}

export function settingsFromConfig(config: Config): OracleSettings {
  return {
    chainId: config.chainId,
    weatherIndex: contractAddresses(config).weatherIndex,
    userAgent: config.userAgent,
    thresholdMmPerHour: config.thresholdMmPerHour,
    intervalSeconds: config.intervalSeconds,
    maxHttpRequests: config.maxHttpRequests,
    heartbeatCell: config.heartbeatCell,
    gasLimitBase: BigInt(config.gasLimitBase),
    gasLimitPerReading: BigInt(config.gasLimitPerReading),
  }
}
