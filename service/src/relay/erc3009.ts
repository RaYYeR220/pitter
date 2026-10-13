import { isAddressEqual, recoverTypedDataAddress, type Address, type Hex } from 'viem'
import type { TokenDomain } from '../chain/reader'
import { badRequest } from '../http/errors'
import type { Authorization } from '../types'

const fields = [
  { name: 'from', type: 'address' },
  { name: 'to', type: 'address' },
  { name: 'value', type: 'uint256' },
  { name: 'validAfter', type: 'uint256' },
  { name: 'validBefore', type: 'uint256' },
  { name: 'nonce', type: 'bytes32' },
] as const

const types = {
  ReceiveWithAuthorization: fields,
  TransferWithAuthorization: fields,
} as const

export type AuthorizationKind = keyof typeof types

export interface AuthorizedTransfer {
  from: Address
  to: Address
  value: bigint
  nonce: Hex
}

/**
 * Checks, before any gas is spent, that an ERC-3009 authorization was signed by `from` for exactly this
 * payee, amount and nonce, and that it is inside its validity window. The token repeats the check on chain;
 * doing it here keeps junk and mismatched signatures away from the relayer.
 */
export async function assertAuthorization(
  kind: AuthorizationKind,
  domain: TokenDomain,
  transfer: AuthorizedTransfer,
  authorization: Authorization,
  now: number,
): Promise<void> {
  if (authorization.validBefore <= BigInt(now)) {
    throw badRequest('authorization_expired', 'The payment authorization has expired')
  }
  if (authorization.validAfter >= BigInt(now)) {
    throw badRequest('authorization_not_yet_valid', 'The payment authorization is not valid yet')
  }

  let signer: Address
  try {
    signer = await recoverTypedDataAddress({
      domain,
      types,
      primaryType: kind,
      message: {
        ...transfer,
        validAfter: authorization.validAfter,
        validBefore: authorization.validBefore,
      },
      signature: { r: authorization.r, s: authorization.s, v: BigInt(authorization.v) },
    })
  } catch {
    throw badRequest('authorization_invalid', 'The payment authorization is not a valid signature')
  }
  if (!isAddressEqual(signer, transfer.from)) {
    throw badRequest('authorization_invalid', 'The payment authorization was not signed by the payer for these terms')
  }
}
