import type { Address } from 'viem'

export interface SignerId {
  chainId: number
  address: Address
}

/** The nonce a transaction may be signed with, held exclusively until the task returns. */
export interface NonceLease {
  readonly nonce: number
  /** The transaction with this nonce was included; the next lease starts one higher. */
  consume(): void
  /** The fate of this nonce is unknown; the next lease reads the nonce from the chain. */
  invalidate(): void
  /** Re-reads the nonce from the chain and continues with that value. */
  refresh(): Promise<number>
}

/**
 * Hands out the relayer's nonces one at a time. While a task runs no other task for the same signer runs, in
 * this process or, for shared implementations, in any other.
 *
 * The stored nonce only advances for transactions known to be included, so it can fall behind the chain but
 * never run ahead of it: a nonce gap, which would stall every later transaction, cannot be created.
 */
export interface NonceStore {
  withNonce<T>(
    signer: SignerId,
    readChainNonce: () => Promise<number>,
    task: (lease: NonceLease) => Promise<T>,
  ): Promise<T>
}

export type LeaseResult<T> = { ok: true; value: T } | { ok: false; error: unknown }

export interface LeaseOutcome<T> {
  /** Nonce to store for the next lease; null means "read it from the chain". */
  next: number | null
  result: LeaseResult<T>
}

/**
 * Runs `task` with a lease starting from `stored`, or from the chain when nothing is stored. Shared by the
 * store implementations, which only differ in how they lock and persist.
 */
export async function runLease<T>(
  stored: number | null,
  readChainNonce: () => Promise<number>,
  task: (lease: NonceLease) => Promise<T>,
): Promise<LeaseOutcome<T>> {
  let nonce = stored ?? (await readChainNonce())
  let next: number | null = nonce

  const lease: NonceLease = {
    get nonce() {
      return nonce
    },
    consume() {
      next = nonce + 1
    },
    invalidate() {
      next = null
    },
    async refresh() {
      nonce = await readChainNonce()
      next = nonce
      return nonce
    },
  }

  let result: LeaseResult<T>
  try {
    result = { ok: true, value: await task(lease) }
  } catch (error) {
    result = { ok: false, error }
  }
  return { next, result }
}

export const signerKey = (signer: SignerId) => `${signer.chainId}:${signer.address.toLowerCase()}`

/**
 * Serialises leases inside one process. Suitable for a single long-running server and for tests; several
 * serverless instances need the shared Postgres implementation.
 */
export class MemoryNonceStore implements NonceStore {
  private readonly tails = new Map<string, Promise<void>>()
  private readonly stored = new Map<string, number | null>()

  async withNonce<T>(
    signer: SignerId,
    readChainNonce: () => Promise<number>,
    task: (lease: NonceLease) => Promise<T>,
  ): Promise<T> {
    const key = signerKey(signer)
    const previous = this.tails.get(key) ?? Promise.resolve()
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const tail = previous.then(() => held)
    this.tails.set(key, tail)

    await previous
    try {
      const outcome = await runLease(this.stored.get(key) ?? null, readChainNonce, task)
      this.stored.set(key, outcome.next)
      if (!outcome.result.ok) throw outcome.result.error
      return outcome.result.value
    } finally {
      release()
      if (this.tails.get(key) === tail) this.tails.delete(key)
    }
  }
}
