import { createPublicClient, defineChain, http, type PublicClient } from 'viem'
import type { AppConfig } from '../config'

/** Calldata bytes one batched read may carry. Large enough that a page of reads is a single request. */
export const MULTICALL_BATCH_BYTES = 48_000

/**
 * A read-only client for the browser. Reads issued together are folded into one multicall, because the public
 * nodes limit requests per second and a page that asks for twenty values at once should cost one of them.
 */
export function createChainClient(
  config: Pick<AppConfig, 'chainId' | 'rpcUrl' | 'multicall3' | 'explorerUrl'>,
  options: { fetch?: typeof fetch } = {},
): PublicClient {
  const chain = defineChain({
    id: config.chainId,
    name: `chain ${config.chainId}`,
    nativeCurrency: { name: 'Monad', symbol: 'MON', decimals: 18 },
    rpcUrls: { default: { http: [config.rpcUrl] } },
    blockExplorers: { default: { name: 'Explorer', url: config.explorerUrl } },
    contracts: { multicall3: { address: config.multicall3 } },
  })
  return createPublicClient({
    chain,
    transport: http(config.rpcUrl, {
      ...(options.fetch ? { fetchFn: options.fetch } : {}),
      timeout: 12_000,
      retryCount: 2,
      retryDelay: 600,
    }),
    batch: { multicall: { wait: 16, batchSize: MULTICALL_BATCH_BYTES } },
  }) as PublicClient
}
