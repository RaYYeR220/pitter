import { isAddressEqual, keccak256, recoverTypedDataAddress, type Address, type Hex } from 'viem'
import type { Context } from '../context'
import { readBytes } from '../http/body'
import { ServiceError, badRequest, conflict, forbidden, notFound, unauthorized } from '../http/errors'
import { limitByAddress, limitByIp, pathAfter, requireMethod } from '../http/request'
import { json, type Handler } from '../http/respond'
import { address as addressSchema, blobName, signature as signatureSchema } from '../validation'
import {
  BLOB_ISSUED_AT_HEADER,
  BLOB_SIGNATURE_HEADER,
  blobReadTypedData,
  blobWriteTypedData,
  type BlobRead,
  type BlobWrite,
} from './auth'

export const BLOBS_PATH = '/blobs'

/**
 * `PUT` and `GET /blobs/:address/:name` — storage for data the owner encrypted on their own device.
 *
 * The service stores and returns the bytes untouched and has no key for them. Every request carries the
 * owner's EIP-712 signature: a write commits to the exact bytes and a timestamp, and can only replace an
 * older version, so a captured request can neither be redirected to other content nor used to roll back.
 */
export function blobHandler(context: Context): Handler {
  const { settings, stores } = context
  const { limits, blobs } = settings

  function target(request: Request): { owner: Address; name: string } {
    const segments = pathAfter(request, settings.basePath, BLOBS_PATH)
    if (!segments || segments.length !== 2) throw notFound()
    const owner = addressSchema.safeParse(segments[0])
    const name = blobName.safeParse(segments[1])
    if (!owner.success || !name.success) throw badRequest('invalid_request', 'Expected /blobs/<address>/<name>')
    return { owner: owner.data, name: name.data }
  }

  function credentials(request: Request): { signature: Hex; issuedAt: number } {
    const signature = signatureSchema.safeParse(request.headers.get(BLOB_SIGNATURE_HEADER))
    const issuedAt = request.headers.get(BLOB_ISSUED_AT_HEADER) ?? ''
    if (!signature.success || !/^[1-9]\d{0,11}$/.test(issuedAt)) throw unauthorized()
    if (Math.abs(context.now() - Number(issuedAt)) > blobs.clockSkewSeconds) {
      throw unauthorized('The request timestamp is too far from the current time')
    }
    return { signature: signature.data, issuedAt: Number(issuedAt) }
  }

  async function assertSignedByOwner(
    owner: Address,
    signature: Hex,
    typedData: ReturnType<typeof blobWriteTypedData> | ReturnType<typeof blobReadTypedData>,
  ): Promise<void> {
    let signer: Address
    try {
      signer = await recoverTypedDataAddress({ ...typedData, signature })
    } catch {
      throw unauthorized()
    }
    if (!isAddressEqual(signer, owner)) throw forbidden('not_owner', 'The request is not signed by the owner')
  }

  return async (request) => {
    requireMethod(request, 'GET', 'PUT')
    await limitByIp(context, request, 'blob', limits.blobPerIp)
    const { owner, name } = target(request)
    const { signature, issuedAt } = credentials(request)

    if (request.method === 'GET') {
      const message: BlobRead = { owner, name, issuedAt: BigInt(issuedAt) }
      await assertSignedByOwner(owner, signature, blobReadTypedData(settings.chainId, message))
      await limitByAddress(context, 'blob', owner, limits.blobPerAddress)

      const blob = await stores.blobs.get(owner, name)
      if (!blob) throw notFound()
      return new Response(blob.bytes, {
        status: 200,
        headers: {
          'content-type': 'application/octet-stream',
          'content-length': String(blob.bytes.byteLength),
          'cache-control': 'private, no-store',
          'x-content-type-options': 'nosniff',
          [BLOB_ISSUED_AT_HEADER]: String(blob.issuedAt),
        },
      })
    }

    const bytes = await readBytes(request, blobs.maxBytes)
    if (bytes.byteLength === 0) throw badRequest('invalid_request', 'The blob is empty')
    const contentHash = keccak256(bytes)
    const message: BlobWrite = { owner, name, contentHash, issuedAt: BigInt(issuedAt) }
    await assertSignedByOwner(owner, signature, blobWriteTypedData(settings.chainId, message))
    await limitByAddress(context, 'blob', owner, limits.blobPerAddress)

    const result = await stores.blobs.put(owner, name, { bytes, issuedAt }, blobs.maxPerAddress)
    if (result === 'stale') throw conflict('stale_write', 'A newer version of this blob is already stored')
    if (result === 'quota') {
      throw new ServiceError(409, 'quota_exceeded', `An address can store at most ${blobs.maxPerAddress} blobs`)
    }
    return json({ owner, name, size: bytes.byteLength, issuedAt, contentHash })
  }
}
