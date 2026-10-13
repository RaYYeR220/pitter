import { hashDomain, parseSignature, toHex, type Address, type Hex } from 'viem'

/** EIP-712 domain of the dollar token. USDC is "USDC" version "2"; the test dollar is "Test Dollar" version "1". */
export interface TokenDomain {
  name: string
  version: string
  chainId: number
  verifyingContract: Address
}

/** The message of an ERC-3009 authorization: who pays whom how much, when it is valid, and its one-time nonce. */
export interface AuthorizationMessage {
  from: Address
  to: Address
  value: bigint
  validAfter: bigint
  validBefore: bigint
  nonce: Hex
}

/** Validity window and split signature of an ERC-3009 authorization, as the contracts take it. */
export interface Authorization {
  validAfter: bigint
  validBefore: bigint
  v: 27 | 28
  r: Hex
  s: Hex
}

const fields = [
  { name: 'from', type: 'address' },
  { name: 'to', type: 'address' },
  { name: 'value', type: 'uint256' },
  { name: 'validAfter', type: 'uint256' },
  { name: 'validBefore', type: 'uint256' },
  { name: 'nonce', type: 'bytes32' },
] as const

export const authorizationTypes = {
  ReceiveWithAuthorization: fields,
  TransferWithAuthorization: fields,
} as const

/**
 * Typed data of a payment only its payee can collect. Cover purchases and pool deposits use it: the book or
 * the pool calls the token itself, so nobody in between can redirect the money.
 */
export function receiveAuthorization(domain: TokenDomain, message: AuthorizationMessage) {
  return { domain, types: authorizationTypes, primaryType: 'ReceiveWithAuthorization', message } as const
}

/** Typed data of a payment anyone may submit on the payer's behalf. Cash-outs use it. */
export function transferAuthorization(domain: TokenDomain, message: AuthorizationMessage) {
  return { domain, types: authorizationTypes, primaryType: 'TransferWithAuthorization', message } as const
}

/** Splits a 65-byte signature into the `v`, `r`, `s` the token takes. */
export function splitSignature(signature: Hex): Pick<Authorization, 'v' | 'r' | 's'> {
  const { r, s, yParity } = parseSignature(signature)
  return { v: yParity === 0 ? 27 : 28, r, s }
}

export function toAuthorization(message: AuthorizationMessage, signature: Hex): Authorization {
  return { validAfter: message.validAfter, validBefore: message.validBefore, ...splitSignature(signature) }
}

/** A fresh one-time nonce for an authorization that is not tied to a quote. */
export function randomNonce(): Hex {
  return toHex(crypto.getRandomValues(new Uint8Array(32)))
}

const eip712Domain = [
  { name: 'name', type: 'string' },
  { name: 'version', type: 'string' },
  { name: 'chainId', type: 'uint256' },
  { name: 'verifyingContract', type: 'address' },
] as const

/** The domain separator a token with this domain reports from `DOMAIN_SEPARATOR()`. */
export function domainSeparator(domain: TokenDomain): Hex {
  return hashDomain({
    domain: { ...domain, chainId: BigInt(domain.chainId) },
    types: { EIP712Domain: eip712Domain },
  })
}
