import type { Indexed, IndexProgress } from './queries'

/**
 * Where a value on screen was read from: the indexer; the chain, because no indexer is configured; or the chain
 * because the indexer failed or fell behind.
 */
export type DataOrigin = 'indexer' | 'chain' | 'fallback'

/** Monad makes a block about every 0.4 seconds, on the main and the test network alike. */
export const BLOCK_SECONDS = 0.4
/** An index further behind the chain than this is not shown; the chain is read instead. */
export const MAX_LAG_SECONDS = 120
/** After a failed or stale read the indexer is left alone this long, so a broken endpoint costs one wait. */
export const COOLDOWN_MS = 60_000

/** Seconds the index is behind the chain head; null when the head is unknown. */
export function indexLagSeconds(
  progress: IndexProgress,
  head: bigint | null,
  blockSeconds = BLOCK_SECONDS,
): number | null {
  if (head === null) return null
  const blocks = head - progress.progressBlock
  return blocks > 0n ? Number(blocks) * blockSeconds : 0
}

export type GateVerdict = 'fresh' | 'failed' | 'behind' | 'not_indexed' | 'cooling_down'

export interface IndexerGateOptions {
  /** The chain's newest block number, read from the node. */
  head: () => Promise<bigint>
  now?: () => number
  maxLagSeconds?: number
  blockSeconds?: number
  cooldownMs?: number
}

/**
 * Decides, read by read, whether what the indexer returns may be shown. A read is used only when the query
 * succeeded and the index is ready and within `maxLagSeconds` of the chain; otherwise the caller reads the chain.
 * One gate is shared by every screen, so a failure seen by one sends all of them to the chain for a while.
 */
export class IndexerGate {
  private readonly head: () => Promise<bigint>
  private readonly now: () => number
  private readonly maxLagSeconds: number
  private readonly blockSeconds: number
  private readonly cooldownMs: number
  private skipUntil = 0
  /** What the latest read decided, and how far behind the index was when that was known. */
  last: { verdict: GateVerdict; lagSeconds: number | null } | null = null

  constructor(options: IndexerGateOptions) {
    this.head = options.head
    this.now = options.now ?? Date.now
    this.maxLagSeconds = options.maxLagSeconds ?? MAX_LAG_SECONDS
    this.blockSeconds = options.blockSeconds ?? BLOCK_SECONDS
    this.cooldownMs = options.cooldownMs ?? COOLDOWN_MS
  }

  /**
   * Runs an indexer query. Resolves to its value, or to null when the chain should be read instead; never
   * rejects. The chain head is read alongside the query; when the node cannot say where the head is, the index
   * is taken at its word, since the chain would not answer the fallback either.
   */
  async read<T>(query: () => Promise<Indexed<T>>): Promise<T | null> {
    if (this.now() < this.skipUntil) return this.decide('cooling_down', null, false)
    let result: Indexed<T>
    let head: bigint | null
    try {
      ;[result, head] = await Promise.all([query(), this.head().catch(() => null)])
    } catch {
      return this.decide('failed', null)
    }
    if (!result.progress) return this.decide('not_indexed', null)
    if (!result.progress.isReady) return this.decide('behind', null)
    const lag = indexLagSeconds(result.progress, head, this.blockSeconds)
    if (lag !== null && lag > this.maxLagSeconds) return this.decide('behind', lag)
    this.last = { verdict: 'fresh', lagSeconds: lag }
    return result.value
  }

  private decide(verdict: GateVerdict, lagSeconds: number | null, skip = true): null {
    if (skip) this.skipUntil = this.now() + this.cooldownMs
    this.last = { verdict, lagSeconds }
    return null
  }
}

/**
 * Wraps a read so that calls within `ttlMs` of the last one share its result. Two feeds on one screen then cost
 * one query between them. A failed read is not kept.
 */
export function reuseFor<T>(ttlMs: number, load: () => Promise<T>, now: () => number = Date.now): () => Promise<T> {
  let last: { at: number; value: Promise<T> } | null = null
  return () => {
    const at = now()
    if (last && at - last.at < ttlMs) return last.value
    const value = load()
    const entry = { at, value }
    last = entry
    value.catch(() => {
      if (last === entry) last = null
    })
    return value
  }
}
