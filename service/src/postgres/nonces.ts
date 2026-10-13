import { RelayerUnavailable } from '../relayer/errors'
import { runLease, type NonceLease, type NonceStore, type SignerId } from '../relayer/nonces'
import type { Database } from './database'

const LOCK_NOT_AVAILABLE = '55P03'

export interface PostgresNonceOptions {
  /** How long a relay waits for the relays ahead of it before giving up. */
  lockTimeoutMs?: number
  /** After this long without a statement the database ends the transaction and frees the lock. */
  idleTimeoutMs?: number
}

/**
 * Serialises the relayer's nonces across every instance of the service with one row per signer.
 *
 * A lease is a transaction that takes the signer's row `FOR UPDATE` and keeps it until the transaction it
 * signed has a receipt. Any other instance blocks on the same row, so there is exactly one in-flight
 * transaction per signer no matter how many functions are running. A row lock inside a transaction also
 * works through a transaction-mode connection pooler, where session-level advisory locks do not.
 *
 * If an instance dies mid-lease its connection drops, the transaction rolls back and the lock is freed with
 * the stored nonce unchanged. Should the dead instance's transaction have been broadcast, the next lease
 * hits "nonce too low", re-reads the chain and carries on.
 */
export class PostgresNonceStore implements NonceStore {
  private readonly db: Database
  private readonly lockTimeoutMs: number
  private readonly idleTimeoutMs: number

  constructor(db: Database, options: PostgresNonceOptions = {}) {
    this.db = db
    this.lockTimeoutMs = Math.trunc(options.lockTimeoutMs ?? 20_000)
    this.idleTimeoutMs = Math.trunc(options.idleTimeoutMs ?? 60_000)
  }

  async withNonce<T>(
    signer: SignerId,
    readChainNonce: () => Promise<number>,
    task: (lease: NonceLease) => Promise<T>,
  ): Promise<T> {
    const id = [signer.chainId, signer.address.toLowerCase()]

    let outcome
    try {
      outcome = await this.db.transaction(async (tx) => {
        await tx.query(`SET LOCAL lock_timeout = '${this.lockTimeoutMs}ms'`)
        await tx.query(`SET LOCAL idle_in_transaction_session_timeout = '${this.idleTimeoutMs}ms'`)
        await tx.query(
          'INSERT INTO cover_relayer_nonces (chain_id, address) VALUES ($1, $2) ON CONFLICT DO NOTHING',
          id,
        )
        const { rows } = await tx.query<{ next_nonce: string | number | bigint | null }>(
          'SELECT next_nonce FROM cover_relayer_nonces WHERE chain_id = $1 AND address = $2 FOR UPDATE',
          id,
        )
        const stored = rows[0]?.next_nonce
        const leased = await runLease(
          stored === null || stored === undefined ? null : Number(stored),
          readChainNonce,
          task,
        )
        await tx.query(
          'UPDATE cover_relayer_nonces SET next_nonce = $3, updated_at = now() WHERE chain_id = $1 AND address = $2',
          [...id, leased.next],
        )
        return leased
      })
    } catch (error) {
      if ((error as { code?: unknown }).code === LOCK_NOT_AVAILABLE) throw new RelayerUnavailable('busy')
      throw error
    }

    if (!outcome.result.ok) throw outcome.result.error
    return outcome.result.value
  }
}
