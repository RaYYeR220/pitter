import type { Json } from './ledger'

/** Small keyed values the service keeps between requests: the keeper's scan cursor, the sandbox switch. */
export interface StateStore {
  get(key: string): Promise<Json | null>
  set(key: string, value: Json): Promise<void>
}

export class MemoryStateStore implements StateStore {
  private readonly values = new Map<string, Json>()

  async get(key: string): Promise<Json | null> {
    return this.values.get(key) ?? null
  }

  async set(key: string, value: Json): Promise<void> {
    this.values.set(key, value)
  }
}
