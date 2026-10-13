import type { Address, Hex, LocalAccount } from 'viem'
import type { Clock } from '../types'
import type { Allowlist, RelayedFunction } from './allowlist'
import { BroadcastRejected, RelayRefused, RelayerUnavailable } from './errors'
import { MAX_RELAY_GAS } from './gas'
import type { NonceStore } from './nonces'
import type { RelayReceipt, RelayerRpc } from './rpc'

export interface RelayCall {
  to: Address
  data: Hex
  /** Gas limit, chosen by the service for the function being called. */
  gas: bigint
}

export interface RelayResult extends RelayReceipt {
  function: RelayedFunction
}

export interface RelayerOptions {
  chainId: number
  account: LocalAccount
  rpc: RelayerRpc
  nonces: NonceStore
  allowlist: Allowlist
  maxFeePerGas: bigint
  maxPriorityFeePerGas: bigint
  /** Below this native balance the relayer stops sending. */
  minBalance: bigint
  now: Clock
}

const BALANCE_TTL_SECONDS = 30
const BASE_FEE_TTL_SECONDS = 3

interface Cached<T> {
  value: T
  at: number
}

/**
 * Sends transactions from the service's hot key. Every call goes through the same gate:
 *
 * 1. the target and selector must be on the allow-list, and the gas limit within bounds;
 * 2. the relayer must be on the configured chain, funded, and the base fee under its cap;
 * 3. the call is simulated against the latest state while holding the nonce, immediately before signing;
 * 4. only a call that simulated cleanly is signed, with an explicit nonce, gas limit and fees, and no value.
 *
 * Holding the nonce from simulation to receipt means two relays never race: the second one is simulated
 * against the state the first one left behind.
 */
export class Relayer {
  readonly address: Address
  private readonly options: RelayerOptions
  private chainVerified = false
  private balance: Cached<bigint> | undefined
  private baseFee: Cached<bigint> | undefined

  constructor(options: RelayerOptions) {
    this.options = options
    this.address = options.account.address
  }

  async execute(call: RelayCall): Promise<RelayResult> {
    const { rpc, nonces, allowlist, account, chainId, maxFeePerGas, maxPriorityFeePerGas } = this.options

    const allowed = allowlist.check(call.to, call.data)
    if (call.gas <= 0n || call.gas > MAX_RELAY_GAS) throw new RelayRefused('gas_out_of_bounds')

    await this.assertReady()

    const signer = { chainId, address: this.address }
    const receipt = await nonces.withNonce(
      signer,
      () => rpc.transactionCount(this.address),
      async (lease) => {
        await rpc.simulate({ from: this.address, to: call.to, data: call.data, gas: call.gas })

        for (let attempt = 0; ; attempt++) {
          const serialized = await account.signTransaction({
            chainId,
            type: 'eip1559',
            to: call.to,
            data: call.data,
            gas: call.gas,
            nonce: lease.nonce,
            maxFeePerGas,
            maxPriorityFeePerGas,
            value: 0n,
          })
          try {
            const sent = await rpc.send(serialized)
            lease.consume()
            return sent
          } catch (error) {
            if (error instanceof BroadcastRejected && error.nonceTooLow && attempt === 0) {
              await lease.refresh()
              continue
            }
            lease.invalidate()
            throw error
          }
        }
      },
    )

    this.balance = undefined
    return { ...receipt, function: allowed.name }
  }

  private async assertReady(): Promise<void> {
    const { rpc, chainId, minBalance, maxFeePerGas, maxPriorityFeePerGas, now } = this.options

    if (!this.chainVerified) {
      if ((await rpc.chainId()) !== chainId) throw new RelayerUnavailable('chain_mismatch')
      this.chainVerified = true
    }

    const time = now()
    if (!this.balance || time - this.balance.at >= BALANCE_TTL_SECONDS) {
      this.balance = { value: await rpc.balance(this.address), at: time }
    }
    if (this.balance.value < minBalance) throw new RelayerUnavailable('unfunded')

    if (!this.baseFee || time - this.baseFee.at >= BASE_FEE_TTL_SECONDS) {
      this.baseFee = { value: await rpc.baseFee(), at: time }
    }
    if (this.baseFee.value + maxPriorityFeePerGas > maxFeePerGas) throw new RelayerUnavailable('gas_price_too_high')
  }
}
