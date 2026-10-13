import type { Address } from 'viem'
import type { BlobStore, BlobWriteResult, StoredBlob } from '../stores/blobs'
import type { Claim, Json, Ledger, LedgerStatus } from '../stores/ledger'
import { decide, windowStart, type RateDecision, type RateLimiter, type RateRule } from '../stores/rateLimiter'
import type { StateStore } from '../stores/state'
import type { Database, Sql } from './database'

const PRUNE_EVERY_SECONDS = 300
const KEEP_WINDOWS_FOR_SECONDS = 3_600
const KEEP_FINISHED_FOR_SECONDS = 7 * 86_400

/** Rate limiter shared by every instance: one atomic upsert per request. */
export class PostgresRateLimiter implements RateLimiter {
  private readonly db: Sql
  private prunedAt = 0

  constructor(db: Sql) {
    this.db = db
  }

  async hit(bucket: string, rule: RateRule, now: number): Promise<RateDecision> {
    const { rows } = await this.db.query<{ count: number | string }>(
      `INSERT INTO cover_rate_limits (bucket, window_start, count) VALUES ($1, $2, 1)
       ON CONFLICT (bucket, window_start) DO UPDATE SET count = cover_rate_limits.count + 1
       RETURNING count`,
      [bucket, windowStart(now, rule.windowSeconds)],
    )
    if (now - this.prunedAt >= PRUNE_EVERY_SECONDS) {
      this.prunedAt = now
      await this.db.query('DELETE FROM cover_rate_limits WHERE window_start < $1', [now - KEEP_WINDOWS_FOR_SECONDS])
    }
    return decide(Number(rows[0]?.count ?? 1), rule, now)
  }
}

/**
 * Ledger shared by every instance. A claim is a single statement, so two instances cannot both win it.
 *
 * Finished entries are dropped after a week. By then the signature behind each of them has expired or been
 * used on chain, which is what actually stops a repeat; unfinished entries are never dropped.
 */
export class PostgresLedger implements Ledger {
  private readonly db: Sql
  private prunedAt = 0

  constructor(db: Sql) {
    this.db = db
  }

  async claim(key: string, now: number): Promise<Claim> {
    const claimed = await this.db.query<{ data: Json | null }>(
      `INSERT INTO cover_ledger (key, status, data, updated_at) VALUES ($1, 'processing', NULL, $2)
       ON CONFLICT (key) DO UPDATE SET status = 'processing', updated_at = EXCLUDED.updated_at
         WHERE cover_ledger.status = 'settled' AND cover_ledger.data IS NOT NULL
       RETURNING data`,
      [key, now],
    )
    if (now - this.prunedAt >= PRUNE_EVERY_SECONDS) {
      this.prunedAt = now
      await this.db.query(`DELETE FROM cover_ledger WHERE status = 'done' AND updated_at < $1`, [
        now - KEEP_FINISHED_FOR_SECONDS,
      ])
    }
    if (claimed.rows.length > 0) return { claimed: true, resumed: claimed.rows[0]!.data ?? null }

    const existing = await this.db.query<{ status: LedgerStatus; data: Json | null; updated_at: number | string }>(
      'SELECT status, data, updated_at FROM cover_ledger WHERE key = $1',
      [key],
    )
    const row = existing.rows[0]
    if (!row) return { claimed: false, entry: { status: 'processing', data: null, updatedAt: now } }
    return { claimed: false, entry: { status: row.status, data: row.data ?? null, updatedAt: Number(row.updated_at) } }
  }

  async checkpoint(key: string, data: Json, now: number): Promise<void> {
    await this.db.query(
      `UPDATE cover_ledger SET data = $2::jsonb, updated_at = $3 WHERE key = $1 AND status = 'processing'`,
      [key, JSON.stringify(data), now],
    )
  }

  async save(key: string, status: 'settled' | 'done', data: Json, now: number): Promise<void> {
    await this.db.query(
      `INSERT INTO cover_ledger (key, status, data, updated_at) VALUES ($1, $2, $3::jsonb, $4)
       ON CONFLICT (key) DO UPDATE SET status = EXCLUDED.status, data = EXCLUDED.data, updated_at = EXCLUDED.updated_at`,
      [key, status, JSON.stringify(data), now],
    )
  }

  async release(key: string): Promise<void> {
    await this.db.query(`DELETE FROM cover_ledger WHERE key = $1 AND status = 'processing' AND data IS NULL`, [key])
    await this.db.query(
      `UPDATE cover_ledger SET status = 'settled' WHERE key = $1 AND status = 'processing' AND data IS NOT NULL`,
      [key],
    )
  }
}

export class PostgresStateStore implements StateStore {
  private readonly db: Sql

  constructor(db: Sql) {
    this.db = db
  }

  async get(key: string): Promise<Json | null> {
    const { rows } = await this.db.query<{ value: Json }>('SELECT value FROM cover_state WHERE key = $1', [key])
    return rows[0]?.value ?? null
  }

  async set(key: string, value: Json): Promise<void> {
    await this.db.query(
      `INSERT INTO cover_state (key, value) VALUES ($1, $2::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [key, JSON.stringify(value)],
    )
  }
}

/** Blob store shared by every instance. Rows hold only the bytes the owner sent. */
export class PostgresBlobStore implements BlobStore {
  private readonly db: Database

  constructor(db: Database) {
    this.db = db
  }

  async get(owner: Address, name: string): Promise<StoredBlob | null> {
    const { rows } = await this.db.query<{ bytes: Uint8Array; issued_at: number | string }>(
      'SELECT bytes, issued_at FROM cover_blobs WHERE owner = $1 AND name = $2',
      [owner.toLowerCase(), name],
    )
    const row = rows[0]
    return row ? { bytes: new Uint8Array(row.bytes), issuedAt: Number(row.issued_at) } : null
  }

  async put(owner: Address, name: string, blob: StoredBlob, maxPerOwner: number): Promise<BlobWriteResult> {
    const id = owner.toLowerCase()
    return this.db.transaction(async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [id])

      const existing = await tx.query<{ issued_at: number | string }>(
        'SELECT issued_at FROM cover_blobs WHERE owner = $1 AND name = $2',
        [id, name],
      )
      const current = existing.rows[0]
      if (current) {
        if (Number(current.issued_at) >= blob.issuedAt) return 'stale'
        await tx.query('UPDATE cover_blobs SET bytes = $3, issued_at = $4 WHERE owner = $1 AND name = $2', [
          id,
          name,
          blob.bytes,
          blob.issuedAt,
        ])
        return 'stored'
      }

      const count = await tx.query<{ count: number | string }>(
        'SELECT count(*) AS count FROM cover_blobs WHERE owner = $1',
        [id],
      )
      if (Number(count.rows[0]?.count ?? 0) >= maxPerOwner) return 'quota'
      await tx.query('INSERT INTO cover_blobs (owner, name, bytes, issued_at) VALUES ($1, $2, $3, $4)', [
        id,
        name,
        blob.bytes,
        blob.issuedAt,
      ])
      return 'stored'
    })
  }
}
