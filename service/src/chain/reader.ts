import { hashDomain, type Abi, type Address, type Hex, type PublicClient } from 'viem'
import type { Settings } from '../config'
import type { ContractAbis } from '../ports'

export interface Head {
  number: bigint
  timestamp: number
}

/** Everything a quote for one cell depends on, read from one block. */
export interface Market {
  head: Head
  /** Assets the caps are measured against. */
  assets: bigint
  lockedExposure: bigint
  cellExposure: bigint
  maxUtilizationBps: number
  maxCellBps: number
  maxPolicyPayout: bigint
  minPremium: bigint
  minLead: number
  minDuration: number
  maxDuration: number
  /** Furthest ahead of its purchase a window may end; null when the book sets no horizon. */
  maxHorizon: number | null
  maxOracleAge: number
  heartbeat: number
  maxActiveCells: number
  activeCells: number
  /** Open policies in this cell; zero means a purchase would activate a new cell. */
  cellOpenPolicies: bigint
}

export interface Policy {
  id: bigint
  holder: Address
  key: bigint
  start: number
  end: number
  ratePerSecond: bigint
  premium: bigint
  maxPayout: bigint
  paid: bigint
  settledUntil: number
  closed: boolean
}

/** Liveness of the weather index. */
export interface Oracle {
  /** Time of the last accepted report. */
  heartbeat: number
  /** `issuedAt` of the last accepted report; the next one must be later. */
  lastIssuedAt: bigint
}

export interface TokenDomain {
  name: string
  version: string
  chainId: number
  verifyingContract: Address
}

/** The chain state the service reads. */
export interface CoverReader {
  head(): Promise<Head>
  market(key: bigint): Promise<Market>
  policyCount(): Promise<bigint>
  policies(ids: readonly bigint[]): Promise<Policy[]>
  claimable(ids: readonly bigint[]): Promise<bigint[]>
  activeCells(): Promise<bigint[]>
  lastTo(keys: readonly bigint[]): Promise<Map<bigint, bigint>>
  oracle(): Promise<Oracle>
  /** The token's EIP-712 domain, confirmed against the domain separator the token reports. */
  tokenDomain(): Promise<TokenDomain>
  allowance(owner: Address, spender: Address): Promise<bigint>
  /** Whether a quote with this digest has been bought. */
  quoteUsed(digest: Hex): Promise<boolean>
}

const hasFunction = (abi: Abi, name: string) => abi.some((item) => item.type === 'function' && item.name === name)

const eip712Domain = [
  { name: 'name', type: 'string' },
  { name: 'version', type: 'string' },
  { name: 'chainId', type: 'uint256' },
  { name: 'verifyingContract', type: 'address' },
] as const

/** `CoverReader` over a viem client. Reads that belong together are pinned to the same block. */
export function viemCoverReader(
  client: PublicClient,
  abis: ContractAbis,
  settings: Pick<Settings, 'chainId' | 'contracts'>,
): CoverReader {
  const { token, coverBook, coverPool, weatherIndex } = settings.contracts
  const assetsFunction = hasFunction(abis.coverPool, 'activeAssets') ? 'activeAssets' : 'totalAssets'
  const hasMinPremium = hasFunction(abis.coverBook, 'minPremium')
  const hasMaxHorizon = hasFunction(abis.coverBook, 'maxHorizon')
  let domain: Promise<TokenDomain> | undefined

  const read = <T>(address: Address, abi: Abi, functionName: string, args: readonly unknown[], blockNumber?: bigint) =>
    client.readContract({ address, abi, functionName, args, ...(blockNumber ? { blockNumber } : {}) }) as Promise<T>

  const book = <T>(name: string, args: readonly unknown[] = [], block?: bigint) =>
    read<T>(coverBook, abis.coverBook, name, args, block)
  const pool = <T>(name: string, args: readonly unknown[] = [], block?: bigint) =>
    read<T>(coverPool, abis.coverPool, name, args, block)
  const index = <T>(name: string, args: readonly unknown[] = [], block?: bigint) =>
    read<T>(weatherIndex, abis.weatherIndex, name, args, block)
  const dollar = <T>(name: string, args: readonly unknown[] = []) => read<T>(token, abis.token, name, args)

  async function head(): Promise<Head> {
    const block = await client.getBlock({ blockTag: 'latest' })
    return { number: block.number, timestamp: Number(block.timestamp) }
  }

  async function loadTokenDomain(): Promise<TokenDomain> {
    const [name, version, separator] = await Promise.all([
      dollar<string>('name'),
      dollar<string>('version'),
      dollar<Hex>('DOMAIN_SEPARATOR'),
    ])
    const candidate: TokenDomain = { name, version, chainId: settings.chainId, verifyingContract: token }
    const computed = hashDomain({
      domain: { ...candidate, chainId: BigInt(candidate.chainId) },
      types: { EIP712Domain: eip712Domain },
    })
    if (computed !== separator) {
      throw new Error('The token does not use the EIP-712 domain its name and version describe')
    }
    return candidate
  }

  return {
    head,

    async market(key) {
      const at = await head()
      const n = at.number
      const [
        assets,
        lockedExposure,
        cellExposure,
        maxUtilizationBps,
        maxCellBps,
        maxPolicyPayout,
        minPremium,
        minLead,
        minDuration,
        maxDuration,
        maxHorizon,
        maxOracleAge,
        maxActiveCells,
        activeCells,
        cellOpenPolicies,
        heartbeat,
      ] = await Promise.all([
        pool<bigint>(assetsFunction, [], n),
        pool<bigint>('lockedExposure', [], n),
        pool<bigint>('cellExposure', [key], n),
        pool<number>('maxUtilizationBps', [], n),
        pool<number>('maxCellBps', [], n),
        book<bigint>('maxPolicyPayout', [], n),
        hasMinPremium ? book<bigint>('minPremium', [], n) : Promise.resolve(0n),
        book<bigint>('minLead', [], n),
        book<bigint>('minDuration', [], n),
        book<bigint>('maxDuration', [], n),
        hasMaxHorizon ? book<bigint>('maxHorizon', [], n) : Promise.resolve(null),
        book<bigint>('maxOracleAge', [], n),
        book<number>('maxActiveCells', [], n),
        book<readonly bigint[]>('activeCells', [], n),
        book<bigint>('openPolicies', [key], n),
        index<bigint>('heartbeat', [], n),
      ])
      return {
        head: at,
        assets,
        lockedExposure,
        cellExposure,
        maxUtilizationBps: Number(maxUtilizationBps),
        maxCellBps: Number(maxCellBps),
        maxPolicyPayout,
        minPremium: BigInt(minPremium),
        minLead: Number(minLead),
        minDuration: Number(minDuration),
        maxDuration: Number(maxDuration),
        maxHorizon: maxHorizon === null ? null : Number(maxHorizon),
        maxOracleAge: Number(maxOracleAge),
        heartbeat: Number(heartbeat),
        maxActiveCells: Number(maxActiveCells),
        activeCells: activeCells.length,
        cellOpenPolicies,
      }
    },

    policyCount: () => book<bigint>('policyCount'),

    async policies(ids) {
      type Row = readonly [Address, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, boolean]
      const rows = await Promise.all(ids.map((id) => book<Row>('policies', [id])))
      return rows.map((row, i) => ({
        id: ids[i]!,
        holder: row[0],
        key: row[1],
        start: Number(row[2]),
        end: Number(row[3]),
        ratePerSecond: row[4],
        premium: row[5],
        maxPayout: row[6],
        paid: row[7],
        settledUntil: Number(row[8]),
        closed: row[9],
      }))
    },

    claimable: (ids) => Promise.all(ids.map((id) => book<bigint>('claimable', [id]))),

    async activeCells() {
      return [...(await book<readonly bigint[]>('activeCells'))]
    },

    async lastTo(keys) {
      const values = await Promise.all(keys.map((key) => index<bigint>('lastTo', [key])))
      return new Map(keys.map((key, i) => [key, BigInt(values[i]!)]))
    },

    async oracle() {
      const [heartbeat, lastIssuedAt] = await Promise.all([index<bigint>('heartbeat'), index<bigint>('lastIssuedAt')])
      return { heartbeat: Number(heartbeat), lastIssuedAt: BigInt(lastIssuedAt) }
    },

    tokenDomain() {
      domain ??= loadTokenDomain().catch((error: unknown) => {
        domain = undefined
        throw error
      })
      return domain
    },

    allowance: (owner, spender) => dollar<bigint>('allowance', [owner, spender]),

    quoteUsed: (digest) => book<boolean>('quoteUsed', [digest]),
  }
}
