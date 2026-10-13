export type Json = string | number | boolean | null | Json[] | { [key: string]: Json }

/**
 * Where a unit of work stands:
 * - `processing` — someone holds it; nobody else may start it;
 * - `settled`    — money has moved but the work is unfinished; it may be resumed, never restarted;
 * - `done`       — finished; `data` is the result to hand back to anyone who asks again.
 */
export type LedgerStatus = 'processing' | 'settled' | 'done'

export interface LedgerEntry {
  status: LedgerStatus
  data: Json | null
  updatedAt: number
}

export type Claim =
  /** `resumed` is what an earlier attempt recorded when it left the work `settled`; null for fresh work. */
  { claimed: true; resumed: Json | null } | { claimed: false; entry: LedgerEntry }

/**
 * Makes a unit of work happen once. `claim` is atomic: of any number of concurrent callers with the same key
 * exactly one gets `claimed: true`.
 */
export interface Ledger {
  claim(key: string, now: number): Promise<Claim>
  /** Records progress for a claimed key and gives up the claim. */
  save(key: string, status: 'settled' | 'done', data: Json, now: number): Promise<void>
  /** Forgets a claimed key on which nothing irreversible happened, so it can be attempted again. */
  release(key: string): Promise<void>
}

/** Process-local ledger for development and tests. Finished entries beyond `capacity` are forgotten, oldest first. */
export class MemoryLedger implements Ledger {
  private readonly entries = new Map<string, LedgerEntry>()
  private readonly capacity: number

  constructor(capacity = 20_000) {
    this.capacity = capacity
  }

  async claim(key: string, now: number): Promise<Claim> {
    const entry = this.entries.get(key)
    if (!entry) {
      this.entries.set(key, { status: 'processing', data: null, updatedAt: now })
      return { claimed: true, resumed: null }
    }
    if (entry.status === 'settled' && entry.data !== null) {
      this.entries.set(key, { status: 'processing', data: entry.data, updatedAt: now })
      return { claimed: true, resumed: entry.data }
    }
    return { claimed: false, entry: { ...entry } }
  }

  async save(key: string, status: 'settled' | 'done', data: Json, now: number): Promise<void> {
    this.entries.delete(key)
    this.entries.set(key, { status, data, updatedAt: now })
    if (this.entries.size <= this.capacity) return
    for (const [candidate, entry] of this.entries) {
      if (entry.status === 'done') this.entries.delete(candidate)
      if (this.entries.size <= this.capacity) break
    }
  }

  async release(key: string): Promise<void> {
    const entry = this.entries.get(key)
    if (entry?.status === 'processing') this.entries.delete(key)
  }
}
