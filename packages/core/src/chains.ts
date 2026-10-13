import type { Address } from 'viem'
import mainnetDeployment from './deployments/143.json'
import testnetDeployment from './deployments/10143.json'

export const MONAD_MAINNET = 143
export const MONAD_TESTNET = 10143

export type SupportedChainId = typeof MONAD_MAINNET | typeof MONAD_TESTNET

export type ChainConfig = {
  id: SupportedChainId
  name: string
  testnet: boolean
  rpcUrl: string
  explorerUrl: string
  nativeCurrency: { name: string; symbol: string; decimals: number }
  multicall3: Address
  /** Circle's native USDC. Absent on the test network, where the test dollar stands in. */
  usdc?: Address
  /** How the Chainlink Runtime Environment names and addresses this chain. */
  cre: {
    chainName: string
    chainSelector: bigint
    /** Forwarder used by `cre workflow simulate --broadcast`. It relays any caller's report. */
    simulationForwarder: Address
    /** Forwarder used by workflows deployed to a DON. */
    productionForwarder: Address
  }
}

export const chains: Record<SupportedChainId, ChainConfig> = {
  [MONAD_MAINNET]: {
    id: MONAD_MAINNET,
    name: 'Monad',
    testnet: false,
    rpcUrl: 'https://rpc.monad.xyz',
    explorerUrl: 'https://monadscan.com',
    nativeCurrency: { name: 'Monad', symbol: 'MON', decimals: 18 },
    multicall3: '0xcA11bde05977b3631167028862bE2a173976CA11',
    usdc: '0x754704Bc059F8C67012fEd69BC8A327a5aafb603',
    cre: {
      chainName: 'monad-mainnet',
      chainSelector: 8481857512324358265n,
      simulationForwarder: '0x9eF6468C5f37b976E57d52054c693269479A784d',
      productionForwarder: '0x76c9cf548b4179F8901cda1f8623568b58215E62',
    },
  },
  [MONAD_TESTNET]: {
    id: MONAD_TESTNET,
    name: 'Monad Testnet',
    testnet: true,
    rpcUrl: 'https://testnet-rpc.monad.xyz',
    explorerUrl: 'https://testnet.monadexplorer.com',
    nativeCurrency: { name: 'Testnet MON', symbol: 'MON', decimals: 18 },
    multicall3: '0xcA11bde05977b3631167028862bE2a173976CA11',
    cre: {
      chainName: 'monad-testnet',
      chainSelector: 2183018362218727504n,
      simulationForwarder: '0xB9F79d863261869B234c481D1f9A7af84AeAd192',
      productionForwarder: '0xF8344CFd5c43616a4366C34E3EEE75af79a74482',
    },
  },
}

export function isSupportedChainId(chainId: number): chainId is SupportedChainId {
  return chainId === MONAD_MAINNET || chainId === MONAD_TESTNET
}

export function getChain(chainId: number): ChainConfig {
  if (!isSupportedChainId(chainId)) throw new Error(`unsupported chain ${chainId}`)
  return chains[chainId]
}

/** Record written by the deployment, as stored in `src/deployments/<chainId>.json`. Empty strings mean "not deployed". */
export type DeploymentRecord = {
  chainId: number
  startBlock: number
  token: string
  testDollar: boolean
  weatherIndex: string
  coverPool: string
  coverBook: string
  reporter: string
  underwriter: string
  treasury: string
  forwarders: string[]
}

export type Deployment = {
  chainId: SupportedChainId
  /** Block of the deployment; indexers start here. */
  startBlock: number
  /** The dollar token policies are priced and paid in. */
  token: Address
  /** Whether `token` is the test dollar rather than USDC. */
  testDollar: boolean
  weatherIndex: Address
  coverPool: Address
  coverBook: Address
  reporter: Address
  underwriter: Address
  treasury: Address
  forwarders: Address[]
}

export const deploymentRecords: Record<SupportedChainId, DeploymentRecord> = {
  [MONAD_MAINNET]: mainnetDeployment,
  [MONAD_TESTNET]: testnetDeployment,
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/
const REQUIRED = ['token', 'weatherIndex', 'coverPool', 'coverBook'] as const

/** Whether the contracts have been deployed on `chainId` and their addresses recorded. */
export function isDeployed(chainId: number): boolean {
  if (!isSupportedChainId(chainId)) return false
  const record = deploymentRecords[chainId]
  return REQUIRED.every((field) => ADDRESS.test(record[field]))
}

/** Parses a deployment record, failing when a contract address is missing or malformed. */
export function parseDeployment(record: DeploymentRecord): Deployment {
  if (!isSupportedChainId(record.chainId)) throw new Error(`unsupported chain ${record.chainId}`)
  for (const field of REQUIRED) {
    if (!ADDRESS.test(record[field])) {
      throw new Error(`no ${field} address recorded for chain ${record.chainId}: the contracts are not deployed there`)
    }
  }
  const optional = (value: string): Address =>
    ADDRESS.test(value) ? (value as Address) : '0x0000000000000000000000000000000000000000'
  return {
    chainId: record.chainId,
    startBlock: record.startBlock,
    token: record.token as Address,
    testDollar: record.testDollar,
    weatherIndex: record.weatherIndex as Address,
    coverPool: record.coverPool as Address,
    coverBook: record.coverBook as Address,
    reporter: optional(record.reporter),
    underwriter: optional(record.underwriter),
    treasury: optional(record.treasury),
    forwarders: record.forwarders.filter((forwarder) => ADDRESS.test(forwarder)) as Address[],
  }
}

/** Contract addresses on `chainId`. Throws until the deployment has been recorded. */
export function getDeployment(chainId: number): Deployment {
  if (!isSupportedChainId(chainId)) throw new Error(`unsupported chain ${chainId}`)
  return parseDeployment(deploymentRecords[chainId])
}
