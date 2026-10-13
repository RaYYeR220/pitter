import {
  BaseError,
  MethodNotFoundRpcError,
  MethodNotSupportedRpcError,
  NonceTooLowError,
  RpcRequestError,
  isHex,
  keccak256,
  type Address,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
} from 'viem'
import { sendRawTransactionSync } from 'viem/actions'
import { BroadcastRejected, InclusionUnknown, SimulationReverted } from './errors'

export interface RelayLog {
  address: Address
  topics: readonly Hex[]
  data: Hex
}

export interface RelayReceipt {
  transactionHash: Hex
  blockNumber: bigint
  status: 'success' | 'reverted'
  gasUsed: bigint
  logs: readonly RelayLog[]
}

export interface SimulatedCall {
  from: Address
  to: Address
  data: Hex
  gas: bigint
}

/** The node access the relayer needs. */
export interface RelayerRpc {
  chainId(): Promise<number>
  /** Number of transactions of `address` in the latest block state. */
  transactionCount(address: Address): Promise<number>
  balance(address: Address): Promise<bigint>
  baseFee(): Promise<bigint>
  /** Executes the call against the latest state without sending it. Throws `SimulationReverted` if it fails. */
  simulate(call: SimulatedCall): Promise<void>
  /**
   * Broadcasts a signed transaction and waits for its receipt. Throws `BroadcastRejected` when the node
   * refuses it and `InclusionUnknown` when it was handed over but no receipt arrived in time.
   */
  send(serialized: Hex): Promise<RelayReceipt>
}

const METHOD_NOT_FOUND = -32601
const METHOD_NOT_SUPPORTED = -32004
const INFRASTRUCTURE_CODES = new Set([-32700, -32600, METHOD_NOT_FOUND, METHOD_NOT_SUPPORTED, -32005])

/** Codes with which a node says a synchronously sent transaction was accepted but is not in a block yet. */
const SYNC_PENDING_CODES = new Set([4, 5])

function nodeErrorOf(error: unknown): RpcRequestError | null {
  if (!(error instanceof BaseError)) return null
  const found = error.walk((cause) => cause instanceof RpcRequestError)
  return found instanceof RpcRequestError ? found : null
}

function revertDataOf(error: unknown): Hex | undefined {
  if (!(error instanceof BaseError)) return undefined
  const innermost = error.walk() as { data?: unknown }
  const data =
    typeof innermost.data === 'object' && innermost.data !== null
      ? (innermost.data as { data?: unknown }).data
      : innermost.data
  return isHex(data, { strict: true }) ? data : undefined
}

function methodMissing(error: unknown): boolean {
  if (!(error instanceof BaseError)) return false
  if (error.walk((cause) => cause instanceof MethodNotFoundRpcError || cause instanceof MethodNotSupportedRpcError)) {
    return true
  }
  const code = nodeErrorOf(error)?.code
  return code === METHOD_NOT_FOUND || code === METHOD_NOT_SUPPORTED
}

function nonceTooLow(error: unknown): boolean {
  if (!(error instanceof BaseError)) return false
  if (error.walk((cause) => cause instanceof NonceTooLowError)) return true
  const node = nodeErrorOf(error)
  return node !== null && /nonce (is )?too low|old nonce/i.test(`${node.shortMessage} ${node.details}`)
}

function toReceipt(receipt: TransactionReceipt): RelayReceipt {
  return {
    transactionHash: receipt.transactionHash,
    blockNumber: receipt.blockNumber,
    status: receipt.status,
    gasUsed: receipt.gasUsed,
    logs: receipt.logs.map((log) => ({ address: log.address, topics: log.topics, data: log.data })),
  }
}

/** `RelayerRpc` over a viem client. Uses `eth_sendRawTransactionSync` when the node has it. */
export function viemRelayerRpc(client: PublicClient, options: { receiptTimeoutMs: number }): RelayerRpc {
  let syncSupported: boolean | undefined

  async function awaitReceipt(hash: Hex): Promise<RelayReceipt> {
    try {
      const receipt = await client.waitForTransactionReceipt({
        hash,
        timeout: options.receiptTimeoutMs,
        pollingInterval: 250,
      })
      return toReceipt(receipt)
    } catch {
      throw new InclusionUnknown(hash)
    }
  }

  return {
    chainId: () => client.getChainId(),

    transactionCount: (address) => client.getTransactionCount({ address, blockTag: 'latest' }),

    balance: (address) => client.getBalance({ address }),

    async baseFee() {
      const block = await client.getBlock({ blockTag: 'latest' })
      return block.baseFeePerGas ?? 0n
    },

    async simulate({ from, to, data, gas }) {
      try {
        await client.call({ account: from, to, data, gas })
      } catch (error) {
        const node = nodeErrorOf(error)
        if (node && !INFRASTRUCTURE_CODES.has(node.code)) throw new SimulationReverted(revertDataOf(error))
        throw error
      }
    },

    async send(serialized) {
      const hash = keccak256(serialized)

      if (syncSupported !== false) {
        try {
          const receipt = await sendRawTransactionSync(client, {
            serializedTransaction: serialized,
            throwOnReceiptRevert: false,
            timeout: options.receiptTimeoutMs,
          })
          syncSupported = true
          return toReceipt(receipt)
        } catch (error) {
          if (methodMissing(error)) {
            syncSupported = false
          } else {
            const node = nodeErrorOf(error)
            if (node && !SYNC_PENDING_CODES.has(node.code)) throw new BroadcastRejected(nonceTooLow(error))
            return awaitReceipt(hash)
          }
        }
      }

      try {
        await client.sendRawTransaction({ serializedTransaction: serialized })
      } catch (error) {
        if (nodeErrorOf(error)) throw new BroadcastRejected(nonceTooLow(error))
      }
      return awaitReceipt(hash)
    },
  }
}
