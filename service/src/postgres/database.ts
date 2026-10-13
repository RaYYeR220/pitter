export interface QueryResult<Row> {
  rows: Row[]
}

/** The one thing the stores need from a Postgres driver. */
export interface Sql {
  query<Row = Record<string, unknown>>(text: string, params?: readonly unknown[]): Promise<QueryResult<Row>>
}

export interface Database extends Sql {
  /** Runs `work` in one transaction on one connection; commits when it resolves, rolls back when it throws. */
  transaction<T>(work: (tx: Sql) => Promise<T>): Promise<T>
}

/** The parts of a `pg` pool this module uses. */
export interface PgPoolLike {
  query(text: string, params?: unknown[]): Promise<{ rows: unknown[] }>
  connect(): Promise<{
    query(text: string, params?: unknown[]): Promise<{ rows: unknown[] }>
    release(error?: Error | boolean): void
  }>
}

/** `Database` over a `pg` connection pool. */
export function pgDatabase(pool: PgPoolLike): Database {
  return {
    async query<Row>(text: string, params: readonly unknown[] = []) {
      return (await pool.query(text, [...params])) as QueryResult<Row>
    },

    async transaction(work) {
      const client = await pool.connect()
      let broken = false
      try {
        await client.query('BEGIN')
        const value = await work({
          async query<Row>(text: string, params: readonly unknown[] = []) {
            return (await client.query(text, [...params])) as QueryResult<Row>
          },
        })
        await client.query('COMMIT')
        return value
      } catch (error) {
        try {
          await client.query('ROLLBACK')
        } catch {
          broken = true
        }
        throw error
      } finally {
        client.release(broken)
      }
    },
  }
}

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS cover_relayer_nonces (
  chain_id   bigint      NOT NULL,
  address    text        NOT NULL,
  next_nonce bigint,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chain_id, address)
);

CREATE TABLE IF NOT EXISTS cover_rate_limits (
  bucket       text    NOT NULL,
  window_start bigint  NOT NULL,
  count        integer NOT NULL,
  PRIMARY KEY (bucket, window_start)
);

CREATE TABLE IF NOT EXISTS cover_ledger (
  key        text   PRIMARY KEY,
  status     text   NOT NULL CHECK (status IN ('processing', 'settled', 'done')),
  data       jsonb,
  updated_at bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS cover_state (
  key   text  PRIMARY KEY,
  value jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS cover_blobs (
  owner     text   NOT NULL,
  name      text   NOT NULL,
  bytes     bytea  NOT NULL,
  issued_at bigint NOT NULL,
  PRIMARY KEY (owner, name)
);
`

/** Creates the service's tables if they are missing. Safe to run on every start. */
export async function migrate(db: Sql): Promise<void> {
  for (const statement of SCHEMA.split(';')) {
    if (statement.trim().length > 0) await db.query(statement)
  }
}
