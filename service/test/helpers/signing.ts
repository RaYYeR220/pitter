import { parseSignature, type Address, type Hex, type PrivateKeyAccount } from 'viem'
import type { TokenDomain } from '../../src/chain/reader'

const fields = [
  { name: 'from', type: 'address' },
  { name: 'to', type: 'address' },
  { name: 'value', type: 'uint256' },
  { name: 'validAfter', type: 'uint256' },
  { name: 'validBefore', type: 'uint256' },
  { name: 'nonce', type: 'bytes32' },
] as const

export interface TransferTerms {
  from?: Address
  to: Address
  value: bigint
  nonce: Hex
  validAfter?: bigint
  validBefore: bigint
}

/** Signs an ERC-3009 authorization the way a wallet would, and returns the fields a relay body carries. */
export async function signAuthorization(
  account: PrivateKeyAccount,
  kind: 'ReceiveWithAuthorization' | 'TransferWithAuthorization',
  domain: TokenDomain,
  terms: TransferTerms,
) {
  const validAfter = terms.validAfter ?? 0n
  const signature = await account.signTypedData({
    domain,
    types: { ReceiveWithAuthorization: fields, TransferWithAuthorization: fields },
    primaryType: kind,
    message: {
      from: terms.from ?? account.address,
      to: terms.to,
      value: terms.value,
      validAfter,
      validBefore: terms.validBefore,
      nonce: terms.nonce,
    },
  })
  const { r, s, yParity } = parseSignature(signature)
  return {
    validAfter: validAfter.toString(),
    validBefore: terms.validBefore.toString(),
    v: 27 + yParity,
    r,
    s,
  }
}

export const randomNonce = (): Hex =>
  `0x${[...crypto.getRandomValues(new Uint8Array(32))].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`
