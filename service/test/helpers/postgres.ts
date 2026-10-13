import { PGlite } from '@electric-sql/pglite'
import pg from 'pg'
import { migrate, pgDatabase, type Database, type Sql } from '../../src/postgres/database'

export interface TestDatabase {
  db: Database
  /** Whether several connections can hold transactions at the same time. */
  concurrent: boolean
  close(): Promise<void>
}

const TABLES = ['cover_relayer_nonces', 'cover_rate_limits', 'cover_ledger', 'cover_state', 'cover_blobs']

/**
 * A migrated, empty database. Uses the server at `TEST_DATABASE_URL` when set, which exercises real
 * multi-connection locking; otherwise an embedded Postgres with a single connection.
 */
export async function testDatabase(): Promise<TestDatabase> {
  const url = process.env.TEST_DATABASE_URL
  if (url) {
    const pool = new pg.Pool({ connectionString: url, max: 12 })
    const db = pgDatabase(pool)
    await migrate(db)
    await db.query(`TRUNCATE ${TABLES.join(', ')}`)
    return { db, concurrent: true, close: () => pool.end() }
  }

  const embedded = new PGlite()
  const run = (target: { query: PGlite['query'] }): Sql => ({
    async query<Row>(text: string, params: readonly unknown[] = []) {
      const result = await target.query<Row>(text, [...params])
      return { rows: result.rows }
    },
  })
  const db: Database = {
    ...run(embedded),
    transaction: (work) => embedded.transaction((tx) => work(run(tx as unknown as { query: PGlite['query'] }))),
  }
  await migrate(db)
  return { db, concurrent: false, close: () => embedded.close() }
}
