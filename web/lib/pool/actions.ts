import { coverPoolAbi } from '@cover/core/abi'
import {
  BaseError,
  ContractFunctionRevertedError,
  createWalletClient,
  decodeErrorResult,
  encodeFunctionData,
  http,
  type Address,
  type Hex,
  type LocalAccount,
  type PublicClient,
} from 'viem'
import { randomNonce, receiveAuthorization, toAuthorization } from '../chain/erc3009'
import type { ChainReader } from '../chain/reader'
import type { AppConfig } from '../config'
import { refusalFrom, type Refusal } from '../cover/refusals'
import type { DepositReceipt, ServiceClient } from '../service/client'
import { feeCheck, type FeeCheck } from './leave'

/** How long a deposit authorization stays valid. */
const DEPOSIT_VALIDITY_SECONDS = 10 * 60

/**
 * Adds money to the pool without a network fee: the backer signs a payment only the pool can collect, and the
 * service submits it. Run it inside a fresh passkey prompt; `account` is the key that prompt produced.
 */
export async function depositToPool(options: {
  account: LocalAccount
  amount: bigint
  reader: Pick<ChainReader, 'tokenDomain'>
  service: Pick<ServiceClient, 'relayDeposit'>
  pool: Address
  /** Unix seconds. */
  now: number
}): Promise<DepositReceipt> {
  const { account, amount, pool } = options
  if (amount <= 0n) throw new RangeError('the amount must be positive')
  const domain = await options.reader.tokenDomain()
  const message = {
    from: account.address,
    to: pool,
    value: amount,
    validAfter: 0n,
    validBefore: BigInt(options.now + DEPOSIT_VALIDITY_SECONDS),
    nonce: randomNonce(),
  }
  const signature = await account.signTypedData(receiveAuthorization(domain, message))
  return options.service.relayDeposit(
    { assets: amount, receiver: account.address, nonce: message.nonce },
    toAuthorization(message, signature),
  )
}

/** The three steps of leaving. Each is a transaction from the backer's own account. */
export type LeaveStep = 'request' | 'take' | 'cancel'

export type PoolActionProblem =
  /** The account cannot pay the network fee. */
  | { kind: 'fee'; check: Exclude<FeeCheck, { ok: true }> }
  /** The notice is not over yet. */
  | { kind: 'notice' }
  /** The money is still backing cover. */
  | { kind: 'locked' }
  /** There is nothing to leave with, or no request to act on. */
  | { kind: 'nothing' }
  | { kind: 'failed'; reason: string }
  | { kind: 'refused'; refusal: Refusal }

export class PoolActionError extends Error {
  readonly problem: PoolActionProblem

  constructor(problem: PoolActionProblem) {
    super(`pool action failed: ${problem.kind}`)
    this.name = 'PoolActionError'
    this.problem = problem
  }
}

const REVERTS: Record<string, PoolActionProblem['kind']> = {
  NoticeNotOver: 'notice',
  ExposureLocked: 'locked',
  ERC4626ExceededMaxRedeem: 'locked',
  ERC4626ExceededMaxWithdraw: 'locked',
  InsufficientRequest: 'nothing',
  NoRedeemRequest: 'nothing',
  ZeroShares: 'nothing',
  NotController: 'failed',
}

function revertName(error: unknown): string | null {
  if (!(error instanceof BaseError)) return null
  const reverted = error.walk((cause) => cause instanceof ContractFunctionRevertedError)
  if (reverted instanceof ContractFunctionRevertedError) return reverted.data?.errorName ?? reverted.reason ?? 'unknown'
  const raw = error.walk((cause) => typeof (cause as { data?: unknown }).data === 'string')
  const data = (raw as { data?: unknown } | null)?.data
  if (typeof data === 'string' && /^0x[0-9a-fA-F]{8,}$/.test(data)) {
    try {
      return decodeErrorResult({ abi: coverPoolAbi, data: data as Hex }).errorName
    } catch {
      return 'unknown'
    }
  }
  return null
}

function problemOf(error: unknown): PoolActionProblem {
  if (error instanceof PoolActionError) return error.problem
  const name = revertName(error)
  if (name !== null) {
    const kind = REVERTS[name] ?? 'failed'
    return kind === 'failed' ? { kind, reason: name } : ({ kind } as PoolActionProblem)
  }
  if (error instanceof BaseError && /insufficient funds/i.test(error.message)) {
    return { kind: 'fee', check: { ok: false, reason: 'no_balance' } }
  }
  return { kind: 'refused', refusal: refusalFrom(error) }
}

export interface LeaveCallContext {
  account: LocalAccount
  publicClient: PublicClient
  config: Pick<AppConfig, 'chainId' | 'rpcUrl' | 'contracts'>
}

function calldata(step: LeaveStep, owner: Address, shares: bigint): Hex {
  switch (step) {
    case 'request':
      return encodeFunctionData({ abi: coverPoolAbi, functionName: 'requestRedeem', args: [shares, owner, owner] })
    case 'take':
      return encodeFunctionData({ abi: coverPoolAbi, functionName: 'redeem', args: [shares, owner, owner] })
    case 'cancel':
      return encodeFunctionData({ abi: coverPoolAbi, functionName: 'cancelRedeemRequest', args: [] })
  }
}

/**
 * Sends one step of leaving the pool from the backer's own account. The contracts offer no signed variant of
 * these calls, so the account pays the network fee in MON; before anything is signed the call is simulated
 * and its cost compared with the account's balance.
 *
 * @throws PoolActionError saying why nothing was sent, or why the transaction failed.
 */
export async function leavePool(
  step: LeaveStep,
  shares: bigint,
  { account, publicClient, config }: LeaveCallContext,
): Promise<{ transactionHash: Hex }> {
  const owner = account.address
  const to = config.contracts.coverPool
  const data = calldata(step, owner, shares)

  try {
    const [native, gas, fees] = await Promise.all([
      publicClient.getBalance({ address: owner }),
      publicClient.estimateGas({ account: owner, to, data }),
      publicClient.estimateFeesPerGas(),
    ])
    const limit = (gas * 13n) / 10n
    const check = feeCheck(native, limit * (fees.maxFeePerGas ?? 0n))
    if (!check.ok) throw new PoolActionError({ kind: 'fee', check })

    const wallet = createWalletClient({ account, chain: publicClient.chain, transport: http(config.rpcUrl) })
    const transactionHash = await wallet.sendTransaction({
      to,
      data,
      gas: limit,
      maxFeePerGas: fees.maxFeePerGas,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
      chain: publicClient.chain,
    })
    const receipt = await publicClient.waitForTransactionReceipt({ hash: transactionHash, timeout: 60_000 })
    if (receipt.status !== 'success') throw new PoolActionError({ kind: 'failed', reason: 'reverted' })
    return { transactionHash }
  } catch (error) {
    throw new PoolActionError(problemOf(error))
  }
}
