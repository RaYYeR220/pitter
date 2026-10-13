import { coverPoolAbi } from '@cover/core/abi'
import {
  BaseError,
  ContractFunctionRevertedError,
  encodeErrorResult,
  recoverTypedDataAddress,
  type Address,
  type PublicClient,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { describe, expect, it } from 'vitest'
import { receiveAuthorization, transferAuthorization } from '@/lib/chain/erc3009'
import type { PolicyRow, PoolPosition, PoolState } from '@/lib/chain/reader'
import { cashOut, checkCashOut } from '@/lib/cover/cashout'
import {
  PoolActionError,
  depositToPool,
  feeCheck,
  leavePool,
  leaveState,
  poolMeters,
  poolTotals,
  recentTotals,
} from '@/lib/pool'
import { DOMAIN, T0 } from './support/market'

const POOL: Address = '0xfA7e2510EAadB2BB6316Aac81D0D6Aa51a5f4C56'
const account = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d')

const state = (overrides: Partial<PoolState> = {}): PoolState => ({
  time: T0,
  totalAssets: 1_200_000_000n,
  activeAssets: 1_000_000_000n,
  lockedExposure: 600_000_000n,
  freeAssets: 600_000_000n,
  maxUtilizationBps: 8000,
  maxCellBps: 2500,
  totalSupply: 1_200_000_000_000_000n,
  escrowedShares: 0n,
  redeemNotice: 46_800,
  feeBps: 500,
  heartbeat: T0,
  maxOracleAge: 1200,
  areas: [
    { key: 1n, exposure: 100_000_000n, openCover: 2n },
    { key: 2n, exposure: 250_000_000n, openCover: 5n },
  ],
  ...overrides,
})

describe('pool meters', () => {
  it('measure open cover against the limits of the capital still backing it', () => {
    const meters = poolMeters(state())
    expect(meters).toMatchObject({ total: 1_200_000_000n, active: 1_000_000_000n, leaving: 200_000_000n, free: 600_000_000n })
    expect(meters.pool).toEqual({ used: 600_000_000n, limit: 800_000_000n, room: 200_000_000n, share: 0.75 })
    expect(meters.areaLimit).toBe(250_000_000n)
    expect(meters.areas.map((area) => [area.key, area.share, area.room])).toEqual([
      [2n, 1, 0n],
      [1n, 0.4, 150_000_000n],
    ])
  })

  it('show cover running in a pool that has shrunk under it', () => {
    const meters = poolMeters(state({ activeAssets: 500_000_000n }))
    expect(meters.pool.share).toBe(1.5)
    expect(meters.pool.room).toBe(0n)
    expect(poolMeters(state({ activeAssets: 0n, lockedExposure: 0n, areas: [] })).pool.share).toBe(0)
  })
})

const row = (premium: bigint, paid: bigint): PolicyRow => ({
  id: 1n,
  holder: account.address,
  key: 1n,
  start: T0,
  end: T0 + 600,
  ratePerSecond: 2000n,
  premium,
  maxPayout: 1_200_000n,
  paid,
  settledUntil: T0,
  closed: false,
})

describe('pool totals', () => {
  it('add up premiums, fees and payouts from the book, rounding each fee down', () => {
    expect(poolTotals([row(12_345n, 0n), row(10_000n, 600_000n), row(19n, 0n)], 500)).toEqual({
      covers: 3,
      premiums: 22_364n,
      fees: 617n + 500n + 0n,
      payouts: 600_000n,
      net: 22_364n - 1_117n - 600_000n,
    })
  })

  it('sum recent sales and payouts', () => {
    const hash = `0x${'aa'.repeat(32)}` as const
    const totals = recentTotals({
      fromBlock: 1_000n,
      toBlock: 1_499n,
      events: [
        { kind: 'bought', id: 1n, holder: account.address, amount: 12_000n, blockNumber: 1_100n, transactionHash: hash },
        { kind: 'bought', id: 2n, holder: account.address, amount: 13_000n, blockNumber: 1_200n, transactionHash: hash },
        { kind: 'settled', id: 1n, holder: account.address, amount: 600_000n, blockNumber: 1_300n, transactionHash: hash },
      ],
    })
    expect(totals).toMatchObject({ blocks: 500, sold: 2, premiums: 25_000n, payouts: 600_000n })
  })
})

const position = (overrides: Partial<PoolPosition> = {}): PoolPosition => ({
  time: T0,
  shares: 0n,
  value: 0n,
  request: null,
  claimableShares: 0n,
  claimableAssets: 0n,
  dollars: 0n,
  native: 0n,
  ...overrides,
})

describe('leaving the pool', () => {
  it('goes from in, to waiting out the notice, to ready', () => {
    expect(leaveState(position(), T0 * 1000)).toEqual({ phase: 'none' })
    expect(leaveState(position({ shares: 5n, value: 7n }), T0 * 1000)).toEqual({ phase: 'in', shares: 5n, value: 7n })

    const request = { shares: 5n, assetsAtRequest: 7n, claimableAt: T0 + 46_800 }
    expect(leaveState(position({ request }), T0 * 1000)).toEqual({
      phase: 'waiting',
      shares: 5n,
      claimableAt: T0 + 46_800,
      remainingMs: 46_800_000,
    })
    expect(leaveState(position({ request, claimableShares: 5n, claimableAssets: 7n }), (T0 + 46_800) * 1000)).toEqual({
      phase: 'ready',
      shares: 5n,
      claimableShares: 5n,
      claimableAssets: 7n,
      partly: false,
    })
    expect(leaveState(position({ request, claimableShares: 2n }), (T0 + 50_000) * 1000)).toMatchObject({ partly: true })
  })

  it('detects an account that cannot pay the network fee', () => {
    expect(feeCheck(0n, null)).toEqual({ ok: false, reason: 'no_balance' })
    expect(feeCheck(0n, 5n)).toEqual({ ok: false, reason: 'no_balance' })
    expect(feeCheck(4n, 5n)).toEqual({ ok: false, reason: 'too_little', needed: 5n, balance: 4n })
    expect(feeCheck(5n, 5n)).toEqual({ ok: true })
  })

  const chainWith = (native: bigint, estimate: () => Promise<bigint>) =>
    ({
      chain: undefined,
      getBalance: async () => native,
      estimateGas: estimate,
      estimateFeesPerGas: async () => ({ maxFeePerGas: 100_000_000_000n, maxPriorityFeePerGas: 2_000_000_000n }),
    }) as unknown as PublicClient
  const context = (publicClient: PublicClient) => ({
    account,
    publicClient,
    config: {
      chainId: 10143,
      rpcUrl: 'http://127.0.0.1:9',
      contracts: { token: DOMAIN.verifyingContract, coverBook: POOL, coverPool: POOL, weatherIndex: POOL },
    },
  })

  it('refuses to send from an account with no MON, and says so', async () => {
    const error = await leavePool('request', 5n, context(chainWith(0n, async () => 120_000n))).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(PoolActionError)
    expect((error as PoolActionError).problem).toEqual({ kind: 'fee', check: { ok: false, reason: 'no_balance' } })
  })

  it('refuses to send when the fee costs more than the account holds', async () => {
    const error = await leavePool('take', 5n, context(chainWith(1n, async () => 120_000n))).catch((e: unknown) => e)
    expect((error as PoolActionError).problem).toMatchObject({ kind: 'fee', check: { reason: 'too_little' } })
  })

  it('reads the contract’s reason from raw revert data too', async () => {
    const data = encodeErrorResult({ abi: coverPoolAbi, errorName: 'NoticeNotOver' })
    const raw = Object.assign(new BaseError('execution reverted'), { data })
    const failing = chainWith(10n ** 18n, async () => {
      throw new BaseError('estimate failed', { cause: raw })
    })
    const error = (await leavePool('take', 5n, context(failing)).catch((e: unknown) => e)) as PoolActionError
    expect(error.problem).toEqual({ kind: 'notice' })
  })

  it('names the contract’s reason when the step would fail', async () => {
    const revert = (errorName: 'NoticeNotOver' | 'ExposureLocked' | 'NoRedeemRequest') => async () => {
      const data = encodeErrorResult({ abi: coverPoolAbi, errorName })
      const reverted = new ContractFunctionRevertedError({ abi: coverPoolAbi, data, functionName: 'redeem' })
      throw new BaseError('execution reverted', { cause: reverted })
    }
    const kindFor = async (name: Parameters<typeof revert>[0]) =>
      ((await leavePool('take', 5n, context(chainWith(10n ** 18n, revert(name)))).catch((e: unknown) => e)) as PoolActionError)
        .problem.kind
    expect(await kindFor('NoticeNotOver')).toBe('notice')
    expect(await kindFor('ExposureLocked')).toBe('locked')
    expect(await kindFor('NoRedeemRequest')).toBe('nothing')
  })
})

describe('moving money without a fee', () => {
  it('adds to the pool with a payment only the pool can collect', async () => {
    let sent: { deposit: unknown; authorization: { v: number; r: `0x${string}`; s: `0x${string}`; validBefore: bigint } } | undefined
    const receipt = await depositToPool({
      account,
      amount: 5_000_000n,
      pool: POOL,
      now: T0,
      reader: { tokenDomain: async () => DOMAIN },
      service: {
        relayDeposit: async (deposit, authorization) => {
          sent = { deposit, authorization }
          return { transactionHash: `0x${'11'.repeat(32)}`, blockNumber: 1n, receiver: account.address, assets: 5_000_000n, shares: 5n }
        },
      },
    })
    expect(receipt.assets).toBe(5_000_000n)
    const { deposit, authorization } = sent!
    expect(deposit).toMatchObject({ assets: 5_000_000n, receiver: account.address })
    expect(authorization.validBefore).toBe(BigInt(T0 + 600))
    const signer = await recoverTypedDataAddress({
      ...receiveAuthorization(DOMAIN, {
        from: account.address,
        to: POOL,
        value: 5_000_000n,
        validAfter: 0n,
        validBefore: authorization.validBefore,
        nonce: (deposit as { nonce: `0x${string}` }).nonce,
      }),
      signature: { r: authorization.r, s: authorization.s, v: BigInt(authorization.v) },
    })
    expect(signer).toBe(account.address)
  })

  it('cashes out with a signed transfer to the account number given', async () => {
    const to = '0x000000000000000000000000000000000000dEaD'
    let sent: Parameters<Parameters<typeof cashOut>[0]['service']['relayTransfer']> | undefined
    await cashOut({
      account,
      to,
      amount: 1_250_000n,
      now: T0,
      reader: { tokenDomain: async () => DOMAIN },
      service: {
        relayTransfer: async (...args) => {
          sent = args
          return { transactionHash: `0x${'22'.repeat(32)}`, blockNumber: 2n, from: account.address, to, value: 1_250_000n }
        },
      },
    })
    const [transfer, authorization] = sent!
    expect(transfer).toMatchObject({ from: account.address, to, value: 1_250_000n })
    const signer = await recoverTypedDataAddress({
      ...transferAuthorization(DOMAIN, { ...transfer, validAfter: 0n, validBefore: authorization.validBefore }),
      signature: { r: authorization.r, s: authorization.s, v: BigInt(authorization.v) },
    })
    expect(signer).toBe(account.address)
  })

  it('checks a cash-out before any prompt', () => {
    const from = account.address
    const other = '0x000000000000000000000000000000000000dEaD'
    expect(checkCashOut({ to: other, amount: '12.50' }, from, 20_000_000n)).toEqual({
      ok: true,
      to: other,
      amount: 12_500_000n,
    })
    expect(checkCashOut({ to: 'not an account', amount: '1' }, from, 20_000_000n)).toEqual({ ok: false, problem: 'invalid_to' })
    expect(checkCashOut({ to: `0x${'0'.repeat(40)}`, amount: '1' }, from, 20_000_000n)).toMatchObject({ problem: 'invalid_to' })
    expect(checkCashOut({ to: from.toLowerCase(), amount: '1' }, from, 20_000_000n)).toMatchObject({ problem: 'same_account' })
    expect(checkCashOut({ to: other, amount: 'lots' }, from, 20_000_000n)).toMatchObject({ problem: 'invalid_amount' })
    expect(checkCashOut({ to: other, amount: '0' }, from, 20_000_000n)).toMatchObject({ problem: 'invalid_amount' })
    expect(checkCashOut({ to: other, amount: '20.01' }, from, 20_000_000n)).toMatchObject({ problem: 'too_much' })
  })
})
