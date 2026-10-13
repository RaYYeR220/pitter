import type { Address } from 'viem'

export interface StoredBlob {
  /** Opaque bytes exactly as the owner sent them. The service never looks inside. */
  bytes: Uint8Array
  /** Timestamp the owner signed the write with. Writes only ever move it forward. */
  issuedAt: number
}

export type BlobWriteResult = 'stored' | 'stale' | 'quota'

/** Keeps opaque blobs per owner. `owner` is always a checksummed address. */
export interface BlobStore {
  get(owner: Address, name: string): Promise<StoredBlob | null>
  /**
   * Stores the blob unless a version with the same or a later `issuedAt` exists (`stale`) or it would be a
   * new name beyond `maxPerOwner` (`quota`). The check and the write are one atomic step.
   */
  put(owner: Address, name: string, blob: StoredBlob, maxPerOwner: number): Promise<BlobWriteResult>
}

/** Process-local blob store for development and tests. */
export class MemoryBlobStore implements BlobStore {
  private readonly owners = new Map<Address, Map<string, StoredBlob>>()

  async get(owner: Address, name: string): Promise<StoredBlob | null> {
    const blob = this.owners.get(owner)?.get(name)
    return blob ? { bytes: blob.bytes.slice(), issuedAt: blob.issuedAt } : null
  }

  async put(owner: Address, name: string, blob: StoredBlob, maxPerOwner: number): Promise<BlobWriteResult> {
    const blobs = this.owners.get(owner) ?? new Map<string, StoredBlob>()
    const existing = blobs.get(name)
    if (existing && existing.issuedAt >= blob.issuedAt) return 'stale'
    if (!existing && blobs.size >= maxPerOwner) return 'quota'
    blobs.set(name, { bytes: blob.bytes.slice(), issuedAt: blob.issuedAt })
    this.owners.set(owner, blobs)
    return 'stored'
  }
}
