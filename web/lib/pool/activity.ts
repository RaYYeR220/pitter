import type { Hex } from 'viem'
import type { RecentActivity } from '../chain/reader'
import type { DataOrigin } from '../indexer/gate'

/** One line of the pool's latest activity. */
export type ActivityLine =
  | {
      kind: 'bought' | 'settled'
      /** The cover's number. */
      id: bigint
      /** Premium of a sale or amount of a payout. */
      amount: bigint
      /** Block time, unix seconds; null when read from chain logs, which carry only the block number. */
      at: number | null
      transactionHash: Hex
    }
  | {
      kind: 'weather'
      /** The area's index key. */
      key: bigint
      /** Seconds of heavy rain in the reported interval. */
      wetSeconds: number
      /** End of the reported interval, unix seconds. */
      to: number
      at: number
      transactionHash: Hex
    }

export interface LatestActivity {
  /** Blocks of the public record searched; null when the lines come from the indexer's whole record. */
  blocks: number | null
  /** Newest first. */
  lines: ActivityLine[]
  origin: DataOrigin
}

/** The latest activity as found in the most recent blocks of the chain. */
export function activityFromChain(activity: RecentActivity, origin: DataOrigin): LatestActivity {
  return {
    blocks: Number(activity.toBlock - activity.fromBlock) + 1,
    lines: activity.events.map((event) => ({
      kind: event.kind,
      id: event.id,
      amount: event.amount,
      at: null,
      transactionHash: event.transactionHash,
    })),
    origin,
  }
}
