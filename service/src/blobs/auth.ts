import type { Address, Hex } from 'viem'

/**
 * What a client signs to use the blob store. This file has no dependencies beyond types, so an application
 * can import it to build the exact typed data the service verifies.
 */

export const BLOB_SIGNATURE_HEADER = 'x-blob-signature'
export const BLOB_ISSUED_AT_HEADER = 'x-blob-issued-at'

export const blobTypes = {
  BlobWrite: [
    { name: 'owner', type: 'address' },
    { name: 'name', type: 'string' },
    { name: 'contentHash', type: 'bytes32' },
    { name: 'issuedAt', type: 'uint64' },
  ],
  BlobRead: [
    { name: 'owner', type: 'address' },
    { name: 'name', type: 'string' },
    { name: 'issuedAt', type: 'uint64' },
  ],
} as const

/** The signing domain. It names the chain so a signature made for the sandbox means nothing in production. */
export function blobDomain(chainId: number) {
  return { name: 'Cover Blob Store', version: '1', chainId } as const
}

export interface BlobWrite {
  owner: Address
  name: string
  /** keccak256 of the bytes being stored. */
  contentHash: Hex
  /** Unix seconds; must be close to the server clock and later than the stored version. */
  issuedAt: bigint
}

export interface BlobRead {
  owner: Address
  name: string
  issuedAt: bigint
}

export function blobWriteTypedData(chainId: number, message: BlobWrite) {
  return { domain: blobDomain(chainId), types: blobTypes, primaryType: 'BlobWrite', message } as const
}

export function blobReadTypedData(chainId: number, message: BlobRead) {
  return { domain: blobDomain(chainId), types: blobTypes, primaryType: 'BlobRead', message } as const
}
