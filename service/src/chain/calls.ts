import {
  decodeFunctionData,
  encodeFunctionData,
  isAddressEqual,
  parseAbi,
  toFunctionSelector,
  type Abi,
  type AbiFunction,
  type Address,
  type Hex,
} from 'viem'
import type { Settings } from '../config'
import type { ContractAbis } from '../ports'
import { Allowlist, RELAYED_FUNCTIONS, selectorOf, type RelayedFunction } from '../relayer/allowlist'
import {
  APPROVE_GAS,
  BUY_GAS,
  BUY_WITH_AUTHORIZATION_GAS,
  DEPOSIT_WITH_AUTHORIZATION_GAS,
  DRIP_GAS,
  TRANSFER_WITH_AUTHORIZATION_GAS,
  settleManyGas,
  submitGas,
} from '../relayer/gas'
import type { RelayCall } from '../relayer/relayer'
import type { Authorization, Quote } from '../types'

type Contracts = Settings['contracts']

const HOME: Record<RelayedFunction, keyof ContractAbis> = {
  buyWithAuthorization: 'coverBook',
  buy: 'coverBook',
  settleMany: 'coverBook',
  depositWithAuthorization: 'coverPool',
  transferWithAuthorization: 'token',
  approve: 'token',
  drip: 'token',
  submit: 'weatherIndex',
}

const approveAbi = parseAbi(['function approve(address spender, uint256 amount)'])

/**
 * The relayer's allow-list for this deployment. Purchases paid by the relayer itself and the token approval
 * they need are only allowed while the paid cover endpoint is on; `drip` only while the sandbox is on.
 */
export function buildAllowlist(settings: Pick<Settings, 'contracts' | 'x402' | 'sandbox'>): Allowlist {
  const { token, coverBook, coverPool, weatherIndex } = settings.contracts
  const allowlist = new Allowlist()
    .allow(coverBook, 'buyWithAuthorization')
    .allow(coverBook, 'settleMany')
    .allow(coverPool, 'depositWithAuthorization')
    .allow(token, 'transferWithAuthorization')
    .allow(weatherIndex, 'submit')

  if (settings.x402.enabled) {
    allowlist.allow(coverBook, 'buy').allow(token, 'approve', (data) => {
      const { args } = decodeFunctionData({ abi: approveAbi, data })
      return isAddressEqual(args[0], coverBook)
    })
  }
  if (settings.sandbox.enabled) allowlist.allow(token, 'drip')

  return allowlist
}

function functionWithSelector(abi: Abi, name: string, selector: Hex): AbiFunction | undefined {
  return abi.find(
    (item): item is AbiFunction =>
      item.type === 'function' && item.name === name && toFunctionSelector(item) === selector,
  )
}

/**
 * Fails when an ABI does not contain a relayed function with exactly the signature the allow-list pins. This
 * catches a contract interface that moved on without the relayer.
 */
export function assertAbisMatchAllowlist(abis: ContractAbis, names: readonly RelayedFunction[]): void {
  for (const name of names) {
    if (!functionWithSelector(abis[HOME[name]], name, selectorOf(name))) {
      throw new Error(`The ${HOME[name]} ABI has no ${RELAYED_FUNCTIONS[name]}`)
    }
  }
}

/** Builds the calldata and gas limit of every transaction the service sends. */
export class Calls {
  private readonly abis: ContractAbis
  private readonly contracts: Contracts

  constructor(abis: ContractAbis, contracts: Contracts) {
    this.abis = abis
    this.contracts = contracts
  }

  buyWithAuthorization(quote: Quote, quoteSig: Hex, authorization: Authorization): RelayCall {
    const { validAfter, validBefore, v, r, s } = authorization
    return {
      to: this.contracts.coverBook,
      data: this.encode('buyWithAuthorization', [quote, quoteSig, validAfter, validBefore, v, r, s]),
      gas: BUY_WITH_AUTHORIZATION_GAS,
    }
  }

  buy(quote: Quote, quoteSig: Hex): RelayCall {
    return { to: this.contracts.coverBook, data: this.encode('buy', [quote, quoteSig]), gas: BUY_GAS }
  }

  settleMany(ids: readonly bigint[]): RelayCall {
    return {
      to: this.contracts.coverBook,
      data: this.encode('settleMany', [ids]),
      gas: settleManyGas(ids.length),
    }
  }

  depositWithAuthorization(assets: bigint, receiver: Address, nonce: Hex, authorization: Authorization): RelayCall {
    const { validAfter, validBefore, v, r, s } = authorization
    return {
      to: this.contracts.coverPool,
      data: this.encode('depositWithAuthorization', [assets, receiver, validAfter, validBefore, nonce, v, r, s]),
      gas: DEPOSIT_WITH_AUTHORIZATION_GAS,
    }
  }

  transferWithAuthorization(
    from: Address,
    to: Address,
    value: bigint,
    nonce: Hex,
    authorization: Authorization,
  ): RelayCall {
    const { validAfter, validBefore, v, r, s } = authorization
    return {
      to: this.contracts.token,
      data: this.encode('transferWithAuthorization', [from, to, value, validAfter, validBefore, nonce, v, r, s]),
      gas: TRANSFER_WITH_AUTHORIZATION_GAS,
    }
  }

  approve(spender: Address, amount: bigint): RelayCall {
    return { to: this.contracts.token, data: this.encode('approve', [spender, amount]), gas: APPROVE_GAS }
  }

  drip(to: Address): RelayCall {
    return { to: this.contracts.token, data: this.encode('drip', [to]), gas: DRIP_GAS }
  }

  submit(report: Hex, readings: { known: number; fresh: number }): RelayCall {
    return { to: this.contracts.weatherIndex, data: this.encode('submit', [report]), gas: submitGas(readings) }
  }

  private encode(name: RelayedFunction, args: readonly unknown[]): Hex {
    const item = functionWithSelector(this.abis[HOME[name]], name, selectorOf(name))
    if (!item) throw new Error(`The ${HOME[name]} ABI has no ${RELAYED_FUNCTIONS[name]}`)
    return encodeFunctionData({ abi: [item], functionName: name, args })
  }
}
