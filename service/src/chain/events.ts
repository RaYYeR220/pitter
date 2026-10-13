import { decodeEventLog, isAddressEqual, type Abi, type Address } from 'viem'
import type { RelayLog } from '../relayer/rpc'

/** Arguments of every `eventName` event that `emitter` logged, in order. */
export function eventsOf(
  abi: Abi,
  emitter: Address,
  logs: readonly RelayLog[],
  eventName: string,
): Array<Record<string, unknown>> {
  const found: Array<Record<string, unknown>> = []
  for (const log of logs) {
    if (!isAddressEqual(log.address, emitter)) continue
    try {
      const decoded = decodeEventLog({ abi, data: log.data, topics: log.topics as [`0x${string}`, ...`0x${string}`[]] })
      if (decoded.eventName === eventName) found.push(decoded.args as unknown as Record<string, unknown>)
    } catch {
      continue
    }
  }
  return found
}
