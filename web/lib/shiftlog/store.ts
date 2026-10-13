import { blobReadTypedData, blobWriteTypedData } from '@cover/service/blob-auth'
import { keccak256, type Address } from 'viem'
import type { BlobAuth, StoredBlob } from '../service/client'
import { openLog, sealLog, type ShiftLogKeys } from './crypto'
import { decodeLog, emptyLog, encodeLog, fitLog, type ShiftLog } from './model'

/** Name the encrypted log is stored under, per owner. */
export const SHIFT_LOG_BLOB = 'shiftlog'

/** Largest serialised log, kept under the blob store's own limit with room for the envelope. */
export const MAX_LOG_BYTES = 240_000

/** The two calls of the blob store the log needs. The service client provides them. */
export interface BlobTransport {
  getBlob(owner: Address, name: string, auth: BlobAuth): Promise<StoredBlob | null>
  putBlob(owner: Address, name: string, bytes: Uint8Array<ArrayBuffer>, auth: BlobAuth): Promise<void>
}

export interface ShiftLogStoreOptions {
  transport: BlobTransport
  /** The blob store's signing domain names the chain. */
  chainId: number
  /** Unix seconds. */
  now: () => number
}

export interface LoadedLog {
  log: ShiftLog
  /** Version stamp of the stored copy; null when nothing was stored yet. */
  storedAt: number | null
}

/**
 * Reads and writes the encrypted log through the service's blob store. The service sees ciphertext and the
 * storage identity's signature, nothing else; it could lose the blob, but it cannot read or forge one.
 */
export class ShiftLogStore {
  private readonly transport: BlobTransport
  private readonly chainId: number
  private readonly now: () => number

  constructor(options: ShiftLogStoreOptions) {
    this.transport = options.transport
    this.chainId = options.chainId
    this.now = options.now
  }

  async load(keys: ShiftLogKeys): Promise<LoadedLog> {
    const owner = keys.storage.address
    const issuedAt = this.now()
    const signature = await keys.storage.signTypedData(
      blobReadTypedData(this.chainId, { owner, name: SHIFT_LOG_BLOB, issuedAt: BigInt(issuedAt) }),
    )
    const stored = await this.transport.getBlob(owner, SHIFT_LOG_BLOB, { signature, issuedAt })
    if (!stored) return { log: emptyLog(), storedAt: null }
    return { log: decodeLog(await openLog(keys.encryption, stored.bytes)), storedAt: stored.issuedAt }
  }

  /**
   * Encrypts and stores the log.
   *
   * @param after Version stamp of the copy this one replaces. The store only accepts a newer stamp, so the
   * new one is at least one second later.
   * @returns The log as stored (possibly trimmed to fit) and its version stamp.
   */
  async save(keys: ShiftLogKeys, log: ShiftLog, after: number | null): Promise<{ log: ShiftLog; storedAt: number }> {
    const owner = keys.storage.address
    const fitted = fitLog(log, MAX_LOG_BYTES)
    const sealed = await sealLog(keys.encryption, encodeLog(fitted))
    const issuedAt = Math.max(this.now(), (after ?? 0) + 1)
    const signature = await keys.storage.signTypedData(
      blobWriteTypedData(this.chainId, {
        owner,
        name: SHIFT_LOG_BLOB,
        contentHash: keccak256(sealed),
        issuedAt: BigInt(issuedAt),
      }),
    )
    await this.transport.putBlob(owner, SHIFT_LOG_BLOB, sealed, { signature, issuedAt })
    return { log: fitted, storedAt: issuedAt }
  }
}
