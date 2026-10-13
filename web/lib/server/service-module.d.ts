import type { Address } from 'viem'

/**
 * The part of `@cover/service` the web app uses, typed here so that the app is checked against the browser's
 * type library while the service keeps being checked against Node's in its own package.
 */

export type Handler = (request: Request) => Promise<Response>

export interface Service {
  /** Routes a request by its path, below the configured base path. */
  fetch: Handler
  handlers: {
    quote: Handler
    relayBuy: Handler
    relayDeposit: Handler
    relayTransfer: Handler
    relaySettle: Handler
    cronTick: Handler
    cover: Handler
    blobs: Handler
    sandboxDrip: Handler
    sandboxStorm: Handler
  }
  /** The account that pays for relayed transactions. */
  relayerAddress: Address
}

export interface Settings {
  chainId: number
  basePath: string
  contracts: {
    token: Address
    coverBook: Address
    coverPool: Address
    weatherIndex: Address
  }
  relayer: {
    /** Native balance below which the relayer stops sending, in wei. */
    minBalance: bigint
  }
  x402: { enabled: boolean }
  sandbox: { enabled: boolean; simulatorKey: bigint | null }
}

export interface Secrets {
  rpcUrl: string
  cronSecret: string | undefined
  sandboxSecret: string | undefined
}

export interface Logger {
  info(message: string, fields?: Record<string, unknown>): void
  warn(message: string, fields?: Record<string, unknown>): void
  error(message: string, fields?: Record<string, unknown>): void
}

export interface EnvOverrides {
  fetch?: typeof fetch
  /** Current time in unix seconds. */
  now?: () => number
  logger?: Logger
}

export class ConfigError extends Error {
  readonly problems: readonly string[]
}

export const CRON_SECRET_HEADER: string
export const SANDBOX_SECRET_HEADER: string

/** Parses the environment. Throws `ConfigError`, which names variables and never prints their values. */
export function loadConfig(env: Record<string, string | undefined>): { settings: Settings; secrets: Secrets }

export function createServiceFromEnv(
  env?: Record<string, string | undefined>,
  overrides?: EnvOverrides,
): Promise<Service>
