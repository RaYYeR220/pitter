import type { Address, Hex } from 'viem'
import type { ChainReader } from '../chain/reader'
import { withLiveReads, type CoverHistorySource, type CoverRecord, type CoverSnapshot } from '../cover/history'
import type { IndexerClient } from './client'
import { MAX_LAG_SECONDS, type IndexerGate } from './gate'
import { HOLDER_COVER, holderCoverVariables, parseHolderCover, type HolderCover } from './queries'

/** A holder's indexed policies as cover records. `confirmed` is left at zero for the chain to fill in. */
export function recordsFromIndex(cover: HolderCover): CoverRecord[] {
  return cover.policies.map((policy) => {
    const paying = policy.settlements.filter((settlement) => settlement.amount > 0n)
    return {
      id: policy.id,
      key: policy.key,
      start: policy.start,
      end: policy.end,
      ratePerSecond: policy.ratePerSecond,
      premium: policy.premium,
      maxPayout: policy.maxPayout,
      paid: policy.paid,
      confirmed: 0n,
      settledUntil: policy.settledUntil,
      closed: policy.status !== 'OPEN',
      purchase: policy.purchase,
      lastPayout: paying.at(-1)?.transactionHash ?? null,
    }
  })
}

export interface IndexerCoverHistoryDeps {
  client: IndexerClient
  chainId: number
  gate: IndexerGate
  /** Live values the index cannot hold: confirmed payouts, the last weather check and the chain's clock. */
  reader: Pick<ChainReader, 'claimable' | 'weather' | 'balances'>
  /** Read instead whenever the gate turns the indexer down. */
  fallback: CoverHistorySource
  now?: () => number
}

/**
 * `CoverHistorySource` that lists a holder's cover from the indexer, one query per refresh, instead of reading
 * the whole cover book from the chain. Open cover is still completed from the chain, and the chain is read in
 * full whenever the indexer fails or falls behind, or has not yet caught up with a purchase made in this tab.
 */
export class IndexerCoverHistorySource implements CoverHistorySource {
  private readonly deps: IndexerCoverHistoryDeps
  private readonly now: () => number
  /** Purchases made in this tab, by policy id, with when they were made, until the index lists them. */
  private readonly unseen = new Map<bigint, number>()

  constructor(deps: IndexerCoverHistoryDeps) {
    this.deps = deps
    this.now = deps.now ?? Date.now
  }

  remember(id: bigint, purchase: Hex): void {
    this.unseen.set(id, this.now())
    this.deps.fallback.remember?.(id, purchase)
  }

  async snapshot(holder: Address): Promise<CoverSnapshot> {
    const { client, chainId, gate, reader, fallback } = this.deps
    const cover = await gate.read(() =>
      client.query(HOLDER_COVER, holderCoverVariables(chainId, holder), parseHolderCover),
    )
    if (cover === null || this.missesPurchase(cover)) {
      return { ...(await fallback.snapshot(holder)), origin: 'fallback' }
    }

    const snapshot = await withLiveReads(reader, holder, recordsFromIndex(cover))
    return {
      ...snapshot,
      origin: 'indexer',
      totals: cover.totals ? { cost: cover.totals.premiums, paid: cover.totals.paid } : { cost: 0n, paid: 0n },
    }
  }

  /** Whether a purchase made here moments ago is not in the index yet, so the chain has the fuller story. */
  private missesPurchase(cover: HolderCover): boolean {
    const listed = new Set(cover.policies.map((policy) => policy.id))
    let missing = false
    for (const [id, at] of this.unseen) {
      if (listed.has(id) || this.now() - at > MAX_LAG_SECONDS * 1000) this.unseen.delete(id)
      else missing = true
    }
    return missing
  }
}
