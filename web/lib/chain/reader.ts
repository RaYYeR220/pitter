import { coverBookAbi, coverPoolAbi, testDollarAbi, weatherIndexAbi } from '@cover/core/abi'
import { getAbiItem, type Abi, type Address, type Hex, type PublicClient } from 'viem'
import type { AppConfig } from '../config'
import { MULTICALL_BATCH_BYTES } from './client'
import { domainSeparator, type TokenDomain } from './erc3009'

/** One row of the cover book. */
export interface PolicyRow {
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

/** The book's rules for a sale, with the chain's clock. */
export interface MarketRules {
  /** Timestamp of the block the values were read at. */
  time: number
  minLead: number
  minDuration: number
  maxDuration: number
  maxHorizon: number
  maxOracleAge: number
  heartbeat: number
  feeBps: number
  maxPolicyPayout: bigint
  minPremium: bigint
}

/** What the weather index last said about one area. */
export interface AreaWeather {
  /** End of the last reading, unix seconds; null when the area was never reported. */
  lastCheckedAt: number | null
  /** Whether the final minute of that reading was wet. */
  raining: boolean
}

export interface AccountBalances {
  time: number
  dollars: bigint
  /** Native MON, in wei. Only leaving the pool needs any. */
  native: bigint
}

export interface PoolArea {
  key: bigint
  exposure: bigint
  openCover: bigint
}

export interface PoolState {
  time: number
  totalAssets: bigint
  /** Assets the limits are measured against: everything that has not asked to leave. */
  activeAssets: bigint
  lockedExposure: bigint
  freeAssets: bigint
  maxUtilizationBps: number
  maxCellBps: number
  totalSupply: bigint
  escrowedShares: bigint
  redeemNotice: number
  feeBps: number
  heartbeat: number
  maxOracleAge: number
  areas: PoolArea[]
}

export interface PoolPosition {
  time: number
  shares: bigint
  /** What the shares held outside a leave request are worth now. */
  value: bigint
  /** The pending request to leave, if any. */
  request: { shares: bigint; assetsAtRequest: bigint; claimableAt: number } | null
  /** What can be taken out right now. */
  claimableShares: bigint
  claimableAssets: bigint
  dollars: bigint
  native: bigint
}

export interface ActivityEvent {
  kind: 'bought' | 'settled'
  id: bigint
  holder: Address
  /** Premium of a sale or amount of a payout. */
  amount: bigint
  blockNumber: bigint
  transactionHash: Hex
}

/** Sales and payouts found in the most recent blocks. Nothing older is claimed to be covered. */
export interface RecentActivity {
  fromBlock: bigint
  toBlock: bigint
  events: ActivityEvent[]
}

/** Everything the app reads from the chain. One interface, so tests and a future indexer can stand in for it. */
export interface ChainReader {
  /** The token's EIP-712 domain, checked against the separator the token itself reports. */
  tokenDomain(): Promise<TokenDomain>
  balances(holder: Address): Promise<AccountBalances>
  rules(): Promise<MarketRules>
  quoteUsed(digest: Hex): Promise<boolean>
  policyCount(): Promise<bigint>
  policies(ids: readonly bigint[]): Promise<PolicyRow[]>
  claimable(ids: readonly bigint[]): Promise<bigint[]>
  weather(keys: readonly bigint[]): Promise<Map<bigint, AreaWeather>>
  pool(): Promise<PoolState>
  position(owner: Address): Promise<PoolPosition>
  recentActivity(options?: { chunks?: number; chunkBlocks?: number }): Promise<RecentActivity>
}

const multicall3Extras = [
  {
    type: 'function',
    name: 'getCurrentBlockTimestamp',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: 'timestamp', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'getEthBalance',
    stateMutability: 'view',
    inputs: [{ name: 'addr', type: 'address' }],
    outputs: [{ name: 'balance', type: 'uint256' }],
  },
] as const

interface Call {
  address: Address
  abi: Abi
  functionName: string
  args?: readonly unknown[]
}

/** Public nodes answer `eth_getLogs` for at most this many blocks at a time. */
export const LOG_RANGE_BLOCKS = 100

/** `ChainReader` over a viem client. Each method is one batched request unless it says otherwise. */
export function viemChainReader(
  client: PublicClient,
  config: Pick<AppConfig, 'chainId' | 'contracts' | 'multicall3'>,
): ChainReader {
  const { token, coverBook, coverPool, weatherIndex } = config.contracts

  const book = (functionName: string, args: readonly unknown[] = []): Call => ({
    address: coverBook,
    abi: coverBookAbi as Abi,
    functionName,
    args,
  })
  const pool = (functionName: string, args: readonly unknown[] = []): Call => ({
    address: coverPool,
    abi: coverPoolAbi as Abi,
    functionName,
    args,
  })
  const index = (functionName: string, args: readonly unknown[] = []): Call => ({
    address: weatherIndex,
    abi: weatherIndexAbi as Abi,
    functionName,
    args,
  })
  const dollar = (functionName: string, args: readonly unknown[] = []): Call => ({
    address: token,
    abi: testDollarAbi as Abi,
    functionName,
    args,
  })
  const clock: Call = { address: config.multicall3, abi: multicall3Extras as Abi, functionName: 'getCurrentBlockTimestamp' }
  const native = (owner: Address): Call => ({
    address: config.multicall3,
    abi: multicall3Extras as Abi,
    functionName: 'getEthBalance',
    args: [owner],
  })

  async function read<T extends unknown[]>(calls: readonly Call[]): Promise<T> {
    if (calls.length === 0) return [] as unknown as T
    const results = await client.multicall({
      contracts: calls as never,
      allowFailure: false,
      batchSize: MULTICALL_BATCH_BYTES,
    })
    return results as unknown as T
  }

  let domain: Promise<TokenDomain> | undefined

  async function loadTokenDomain(): Promise<TokenDomain> {
    const [name, version, separator] = await read<[string, string, Hex]>([
      dollar('name'),
      dollar('version'),
      dollar('DOMAIN_SEPARATOR'),
    ])
    const candidate: TokenDomain = { name, version, chainId: config.chainId, verifyingContract: token }
    if (domainSeparator(candidate) !== separator) {
      throw new Error('The dollar token does not use the signing domain its name and version describe')
    }
    return candidate
  }

  type PolicyTuple = readonly [Address, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, boolean]

  return {
    tokenDomain() {
      domain ??= loadTokenDomain().catch((error: unknown) => {
        domain = undefined
        throw error
      })
      return domain
    },

    async balances(holder) {
      const [time, dollars, wei] = await read<[bigint, bigint, bigint]>([
        clock,
        dollar('balanceOf', [holder]),
        native(holder),
      ])
      return { time: Number(time), dollars, native: wei }
    },

    async rules() {
      const [time, minLead, minDuration, maxDuration, maxHorizon, maxOracleAge, feeBps, maxPolicyPayout, minPremium, heartbeat] =
        await read<[bigint, bigint, bigint, bigint, bigint, bigint, number, bigint, bigint, bigint]>([
          clock,
          book('minLead'),
          book('minDuration'),
          book('maxDuration'),
          book('maxHorizon'),
          book('maxOracleAge'),
          book('feeBps'),
          book('maxPolicyPayout'),
          book('minPremium'),
          index('heartbeat'),
        ])
      return {
        time: Number(time),
        minLead: Number(minLead),
        minDuration: Number(minDuration),
        maxDuration: Number(maxDuration),
        maxHorizon: Number(maxHorizon),
        maxOracleAge: Number(maxOracleAge),
        heartbeat: Number(heartbeat),
        feeBps: Number(feeBps),
        maxPolicyPayout,
        minPremium,
      }
    },

    async quoteUsed(digest) {
      const [used] = await read<[boolean]>([book('quoteUsed', [digest])])
      return used
    },

    async policyCount() {
      const [count] = await read<[bigint]>([book('policyCount')])
      return count
    },

    async policies(ids) {
      const rows = await read<PolicyTuple[]>(ids.map((id) => book('policies', [id])))
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

    claimable: (ids) => read<bigint[]>(ids.map((id) => book('claimable', [id]))),

    async weather(keys) {
      const result = new Map<bigint, AreaWeather>()
      if (keys.length === 0) return result
      const lastTo = await read<bigint[]>(keys.map((key) => index('lastTo', [key])))
      const reported = keys.map((key, i) => ({ key, at: lastTo[i]! })).filter((entry) => entry.at > 0n)
      const wet = await read<bigint[]>(
        reported.map(({ key, at }) => index('wetSeconds', [key, at > 60n ? at - 60n : 0n, at])),
      )
      for (const key of keys) result.set(key, { lastCheckedAt: null, raining: false })
      reported.forEach(({ key, at }, i) => result.set(key, { lastCheckedAt: Number(at), raining: wet[i]! > 0n }))
      return result
    },

    async pool() {
      const [
        time,
        totalAssets,
        activeAssets,
        lockedExposure,
        freeAssets,
        maxUtilizationBps,
        maxCellBps,
        totalSupply,
        escrowedShares,
        redeemNotice,
        feeBps,
        heartbeat,
        maxOracleAge,
        keys,
      ] = await read<
        [bigint, bigint, bigint, bigint, bigint, number, number, bigint, bigint, bigint, number, bigint, bigint, readonly bigint[]]
      >([
        clock,
        pool('totalAssets'),
        pool('activeAssets'),
        pool('lockedExposure'),
        pool('freeAssets'),
        pool('maxUtilizationBps'),
        pool('maxCellBps'),
        pool('totalSupply'),
        pool('escrowedShares'),
        pool('redeemNotice'),
        book('feeBps'),
        index('heartbeat'),
        book('maxOracleAge'),
        book('activeCells'),
      ])
      const perArea = await read<bigint[]>(
        keys.flatMap((key) => [pool('cellExposure', [key]), book('openPolicies', [key])]),
      )
      return {
        time: Number(time),
        totalAssets,
        activeAssets,
        lockedExposure,
        freeAssets,
        maxUtilizationBps: Number(maxUtilizationBps),
        maxCellBps: Number(maxCellBps),
        totalSupply,
        escrowedShares,
        redeemNotice: Number(redeemNotice),
        feeBps: Number(feeBps),
        heartbeat: Number(heartbeat),
        maxOracleAge: Number(maxOracleAge),
        areas: keys.map((key, i) => ({ key, exposure: perArea[i * 2]!, openCover: perArea[i * 2 + 1]! })),
      }
    },

    async position(owner) {
      const [time, shares, request, claimableShares, claimableAssets, dollars, wei] = await read<
        [bigint, bigint, readonly [bigint, bigint, bigint], bigint, bigint, bigint, bigint]
      >([
        clock,
        pool('balanceOf', [owner]),
        pool('redeemRequests', [owner]),
        pool('maxRedeem', [owner]),
        pool('maxWithdraw', [owner]),
        dollar('balanceOf', [owner]),
        native(owner),
      ])
      const [value] = shares > 0n ? await read<[bigint]>([pool('convertToAssets', [shares])]) : [0n]
      return {
        time: Number(time),
        shares,
        value,
        request:
          request[0] > 0n ? { shares: request[0], assetsAtRequest: request[1], claimableAt: Number(request[2]) } : null,
        claimableShares,
        claimableAssets,
        dollars,
        native: wei,
      }
    },

    async recentActivity({ chunks = 5, chunkBlocks = LOG_RANGE_BLOCKS } = {}) {
      const size = BigInt(Math.min(Math.max(chunkBlocks, 1), LOG_RANGE_BLOCKS))
      const head = await client.getBlockNumber()
      const bought = getAbiItem({ abi: coverBookAbi, name: 'PolicyBought' })
      const settled = getAbiItem({ abi: coverBookAbi, name: 'PolicySettled' })

      const ranges: Array<{ fromBlock: bigint; toBlock: bigint }> = []
      for (let i = 0, toBlock = head; i < chunks && toBlock >= 0n; i++, toBlock -= size) {
        const fromBlock = toBlock - size + 1n > 0n ? toBlock - size + 1n : 0n
        ranges.push({ fromBlock, toBlock })
        if (fromBlock === 0n) break
      }

      const events: ActivityEvent[] = []
      for (const range of ranges) {
        const logs = await client.getLogs({ address: coverBook, events: [bought, settled], ...range })
        for (const log of logs) {
          if (log.eventName === 'PolicyBought') {
            events.push({
              kind: 'bought',
              id: log.args.id!,
              holder: log.args.holder!,
              amount: log.args.premium!,
              blockNumber: log.blockNumber,
              transactionHash: log.transactionHash,
            })
          } else {
            events.push({
              kind: 'settled',
              id: log.args.id!,
              holder: log.args.holder!,
              amount: log.args.paid!,
              blockNumber: log.blockNumber,
              transactionHash: log.transactionHash,
            })
          }
        }
      }
      events.sort((a, b) => (a.blockNumber === b.blockNumber ? 0 : a.blockNumber > b.blockNumber ? -1 : 1))
      return { fromBlock: ranges.at(-1)?.fromBlock ?? head, toBlock: head, events }
    },
  }
}
