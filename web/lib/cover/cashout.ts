import { getAddress, isAddress, isAddressEqual, type Address, type LocalAccount } from 'viem'
import { randomNonce, toAuthorization, transferAuthorization } from '../chain/erc3009'
import type { ChainReader } from '../chain/reader'
import { parseDollars } from '../format'
import type { ServiceClient, TransferReceipt } from '../service/client'

/** How long a cash-out authorization stays valid. */
const CASH_OUT_VALIDITY_SECONDS = 10 * 60

export type CashOutInputProblem = 'invalid_to' | 'same_account' | 'invalid_amount' | 'too_much'

export type CashOutInput = { ok: true; to: Address; amount: bigint } | { ok: false; problem: CashOutInputProblem }

/** Checks what the person typed before any prompt is shown. */
export function checkCashOut(input: { to: string; amount: string }, from: Address, balance: bigint): CashOutInput {
  const to = input.to.trim()
  if (!isAddress(to, { strict: false }) || /^0x0{40}$/i.test(to)) return { ok: false, problem: 'invalid_to' }
  if (isAddressEqual(to, from)) return { ok: false, problem: 'same_account' }
  const amount = parseDollars(input.amount)
  if (amount === null || amount <= 0n) return { ok: false, problem: 'invalid_amount' }
  if (amount > balance) return { ok: false, problem: 'too_much' }
  return { ok: true, to: getAddress(to), amount }
}

/**
 * Sends dollars from the account to another account number, with no network fee: the holder signs a transfer
 * and the service submits it. Run it inside a fresh passkey prompt; `account` is the key that prompt produced.
 */
export async function cashOut(options: {
  account: LocalAccount
  to: Address
  amount: bigint
  reader: Pick<ChainReader, 'tokenDomain'>
  service: Pick<ServiceClient, 'relayTransfer'>
  /** Unix seconds. */
  now: number
}): Promise<TransferReceipt> {
  const { account, to, amount } = options
  if (amount <= 0n) throw new RangeError('the amount must be positive')
  const domain = await options.reader.tokenDomain()
  const message = {
    from: account.address,
    to,
    value: amount,
    validAfter: 0n,
    validBefore: BigInt(options.now + CASH_OUT_VALIDITY_SECONDS),
    nonce: randomNonce(),
  }
  const signature = await account.signTypedData(transferAuthorization(domain, message))
  return options.service.relayTransfer(
    { from: account.address, to, value: amount, nonce: message.nonce },
    toAuthorization(message, signature),
  )
}
