import type { IndexerClient } from './client'
import { reuseFor, type IndexerGate } from './gate'
import { POOL_SCREEN, parsePoolScreen, poolScreenVariables, type PoolIndex } from './queries'

/** Reads within this long of each other share one query: the pool totals and the activity feed refresh together. */
export const POOL_REUSE_MS = 10_000

/**
 * The pool screen's indexer read: totals, the daily series, the areas with open cover and the latest activity,
 * in one query. Resolves to null when the gate sends the screen to the chain.
 */
export function poolIndexReader(
  client: IndexerClient,
  chainId: number,
  gate: IndexerGate,
  options: { reuseMs?: number; now?: () => number } = {},
): () => Promise<PoolIndex | null> {
  return reuseFor(
    options.reuseMs ?? POOL_REUSE_MS,
    () => gate.read(() => client.query(POOL_SCREEN, poolScreenVariables(chainId), (data) => parsePoolScreen(data))),
    options.now,
  )
}
