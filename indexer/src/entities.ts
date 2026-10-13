import type { Cell, EvmOnEventContext, Holder, PoolDay, PoolState } from 'envio'
import { decodeKey } from './key'

export type Context = EvmOnEventContext

const POOL_ID = 'pool'
const SECONDS_PER_DAY = 86_400
const BPS = 10_000n
const RATIO_SCALE = 1_000_000n

/** What the contracts are deployed with. `FeeSet` and `RedeemNoticeSet` replace them. */
const INITIAL_FEE_BPS = 500
const INITIAL_REDEEM_NOTICE = 13 * 60 * 60

export function loadPool(context: Context): Promise<PoolState> {
  return context.PoolState.getOrCreate({
    id: POOL_ID,
    lockedExposure: 0n,
    lastHeartbeat: 0,
    policyCount: 0,
    openPolicies: 0,
    holderCount: 0,
    activeCells: 0,
    settlementCount: 0,
    readingCount: 0,
    openRedeemRequests: 0,
    totalPremiums: 0n,
    totalFees: 0n,
    totalPayouts: 0n,
    totalDeposits: 0n,
    totalWithdrawals: 0n,
    escrowedShares: 0n,
    totalDeferred: 0n,
    totalSurplus: 0n,
    treasury: undefined,
    servedOnly: false,
    servedCells: 0,
    lossRatio: undefined,
    feeBps: INITIAL_FEE_BPS,
    redeemNotice: INITIAL_REDEEM_NOTICE,
    updatedAt: 0,
  })
}

/** The roll-up of the UTC day `timestamp` falls in. */
export function loadDay(context: Context, timestamp: number): Promise<PoolDay> {
  const startsAt = timestamp - (timestamp % SECONDS_PER_DAY)
  return context.PoolDay.getOrCreate({
    id: new Date(startsAt * 1000).toISOString().slice(0, 10),
    startsAt,
    premiums: 0n,
    fees: 0n,
    payouts: 0n,
    deposits: 0n,
    withdrawals: 0n,
    surplus: 0n,
    policiesBought: 0,
    settlements: 0,
    lossRatio: undefined,
  })
}

export function loadCell(context: Context, key: bigint): Promise<Cell> {
  const { triggerId, cellId, grid } = decodeKey(key)
  return context.Cell.getOrCreate({
    id: key.toString(),
    key,
    triggerId,
    cellId,
    latIndex: grid?.latIndex,
    lonIndex: grid?.lonIndex,
    lat: grid?.lat,
    lon: grid?.lon,
    exposure: 0n,
    openPolicies: 0,
    policyCount: 0,
    totalPremiums: 0n,
    totalPaid: 0n,
    wetSeconds: 0n,
    lastWetAt: undefined,
    lastReadingAt: undefined,
    served: false,
  })
}

export function loadHolder(context: Context, address: string, timestamp: number): Promise<Holder> {
  return context.Holder.getOrCreate({
    id: address,
    policyCount: 0,
    openPolicies: 0,
    totalPremiums: 0n,
    totalPaid: 0n,
    deferred: 0n,
    firstPolicyAt: undefined,
    lastActivityAt: timestamp,
  })
}

/** The treasury's part of a premium. Rounds down, as the book does. */
export function feeOf(premium: bigint, feeBps: number): bigint {
  return (premium * BigInt(feeBps)) / BPS
}

/** `payouts / premiums` to six decimal places, or undefined while no premium has been paid. */
export function lossRatio(payouts: bigint, premiums: bigint): number | undefined {
  if (premiums === 0n) return undefined
  return Number((payouts * RATIO_SCALE) / premiums) / Number(RATIO_SCALE)
}
