import type { Address, Hex } from 'viem'
import { parseEther, parseGwei, zeroAddress } from 'viem'
import type { CoverReader, Head, Market, Oracle, Policy, TokenDomain } from '../../src/chain/reader'
import type { Logger } from '../../src/http/respond'
import type { Price, PriceRequest, Pricing, ReadingsRequest, WeatherReporter } from '../../src/ports'
import { BroadcastRejected, SimulationReverted } from '../../src/relayer/errors'
import type { RelayLog, RelayReceipt, RelayerRpc, SimulatedCall } from '../../src/relayer/rpc'
import type { Reading } from '../../src/types'

export const T0 = 1_800_000_000

export function fakeMarket(overrides: Partial<Market> = {}): Market {
  return {
    head: { number: 100n, timestamp: T0 },
    assets: 1_000_000_000n,
    lockedExposure: 0n,
    cellExposure: 0n,
    maxUtilizationBps: 8000,
    maxCellBps: 2500,
    maxPolicyPayout: 500_000_000n,
    minPremium: 0n,
    minLead: 0,
    minDuration: 60,
    maxDuration: 43_200,
    maxHorizon: 45_000,
    maxOracleAge: 1_200,
    heartbeat: T0 - 60,
    maxActiveCells: 64,
    activeCells: 0,
    cellOpenPolicies: 0n,
    ...overrides,
  }
}

export class FakeReader implements CoverReader {
  marketState: Market = fakeMarket()
  marketCalls = 0
  policyRows = new Map<bigint, Policy>()
  claimableAmounts = new Map<bigint, bigint>()
  cells: bigint[] = []
  lastToValues = new Map<bigint, bigint>()
  domain: TokenDomain = { name: 'Test Dollar', version: '1', chainId: 10143, verifyingContract: zeroAddress }
  allowances = new Map<string, bigint>()

  async head(): Promise<Head> {
    return this.marketState.head
  }

  async market(): Promise<Market> {
    this.marketCalls++
    return this.marketState
  }

  async policyCount(): Promise<bigint> {
    return [...this.policyRows.keys()].reduce((a, b) => (b > a ? b : a), 0n)
  }

  async policies(ids: readonly bigint[]): Promise<Policy[]> {
    return ids.map((id) => {
      const policy = this.policyRows.get(id)
      if (!policy) throw new Error(`no policy ${id}`)
      return policy
    })
  }

  async claimable(ids: readonly bigint[]): Promise<bigint[]> {
    return ids.map((id) => this.claimableAmounts.get(id) ?? 0n)
  }

  async activeCells(): Promise<bigint[]> {
    return [...this.cells]
  }

  async lastTo(keys: readonly bigint[]): Promise<Map<bigint, bigint>> {
    return new Map(keys.map((key) => [key, this.lastToValues.get(key) ?? 0n]))
  }

  oracleState: Oracle = { heartbeat: T0 - 60, lastIssuedAt: BigInt(T0 - 60) }

  async oracle(): Promise<Oracle> {
    return this.oracleState
  }

  async tokenDomain(): Promise<TokenDomain> {
    return this.domain
  }

  async allowance(owner: Address, spender: Address): Promise<bigint> {
    return this.allowances.get(`${owner}:${spender}`) ?? 0n
  }

  usedQuotes = new Set<Hex>()

  async quoteUsed(digest: Hex): Promise<boolean> {
    return this.usedQuotes.has(digest)
  }
}

export function fakePolicy(id: bigint, overrides: Partial<Policy> = {}): Policy {
  return {
    id,
    holder: '0x1111111111111111111111111111111111111111',
    key: (1n << 64n) | 7n,
    start: T0,
    end: T0 + 600,
    ratePerSecond: 1_000n,
    premium: 10_000n,
    maxPayout: 600_000n,
    paid: 0n,
    settledUntil: T0,
    closed: false,
    ...overrides,
  }
}

export class FakePricing implements Pricing {
  premium = 50_000n
  failure: Error | undefined
  requests: PriceRequest[] = []

  async price(request: PriceRequest): Promise<Price> {
    this.requests.push(request)
    if (this.failure) throw this.failure
    return { premium: this.premium, inputs: { slots: [{ from: request.start, to: request.end, wetProbability: 0.1 }] } }
  }
}

export class FakeWeather implements WeatherReporter {
  verdicts = new Map<bigint, boolean>()
  failure: Error | undefined
  observed: bigint[][] = []

  async observe(keys: readonly bigint[]): Promise<Map<bigint, boolean>> {
    this.observed.push([...keys])
    if (this.failure) throw this.failure
    return new Map(keys.filter((key) => this.verdicts.has(key)).map((key) => [key, this.verdicts.get(key)!]))
  }

  buildReadings({ verdicts, lastTo, now, firstReadingSeconds }: ReadingsRequest): Reading[] {
    const to = BigInt(Math.floor(now / 60) * 60)
    const readings: Reading[] = []
    for (const [key, wet] of verdicts) {
      const last = lastTo.get(key) ?? 0n
      const from = last > 0n ? last : to - BigInt(firstReadingSeconds)
      if (to <= from) continue
      readings.push({ key, from, to, wetSeconds: wet ? Number(to - from) : 0 })
    }
    return readings
  }
}

export interface FakeTransaction {
  serialized: Hex
}

/** A node that includes every transaction it is sent, unless told otherwise. */
export class FakeRpc implements RelayerRpc {
  chain = 10143
  chainNonce = 0
  funds = parseEther('100')
  fee = parseGwei('100')
  simulated: SimulatedCall[] = []
  sent: Hex[] = []
  chainNonceReads = 0
  inFlight = 0
  maxInFlight = 0
  delayMs = 0
  logs: RelayLog[] = []
  simulate: (call: SimulatedCall) => Promise<void> = async (call) => {
    this.simulated.push(call)
    if (this.revertWith !== null) throw new SimulationReverted(this.revertWith)
  }
  /** Revert data every simulation fails with; null lets simulations pass. */
  revertWith: Hex | undefined | null = null
  onSend: ((serialized: Hex, attempt: number) => RelayReceipt | Promise<RelayReceipt> | undefined) | undefined

  async chainId(): Promise<number> {
    return this.chain
  }

  async transactionCount(): Promise<number> {
    this.chainNonceReads++
    return this.chainNonce
  }

  async balance(): Promise<bigint> {
    return this.funds
  }

  async baseFee(): Promise<bigint> {
    return this.fee
  }

  async send(serialized: Hex): Promise<RelayReceipt> {
    this.inFlight++
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight)
    try {
      if (this.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.delayMs))
      this.sent.push(serialized)
      const custom = await this.onSend?.(serialized, this.sent.length)
      if (custom) return custom
      this.chainNonce++
      return this.receipt()
    } finally {
      this.inFlight--
    }
  }

  receipt(overrides: Partial<RelayReceipt> = {}): RelayReceipt {
    return {
      transactionHash: `0x${this.sent.length.toString(16).padStart(64, '0')}`,
      blockNumber: BigInt(1_000 + this.sent.length),
      status: 'success',
      gasUsed: 100_000n,
      logs: this.logs,
      ...overrides,
    }
  }
}

export const nonceTooLow = () => new BroadcastRejected(true)

export class RecordingLogger implements Logger {
  entries: Array<{ level: string; message: string; fields: Record<string, unknown> | undefined }> = []

  info(message: string, fields?: Record<string, unknown>): void {
    this.entries.push({ level: 'info', message, fields })
  }

  warn(message: string, fields?: Record<string, unknown>): void {
    this.entries.push({ level: 'warn', message, fields })
  }

  error(message: string, fields?: Record<string, unknown>): void {
    this.entries.push({ level: 'error', message, fields })
  }
}
