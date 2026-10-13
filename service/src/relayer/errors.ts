import type { Hex } from 'viem'

export type RefusalReason =
  'target_not_allowed' | 'selector_not_allowed' | 'arguments_not_allowed' | 'gas_out_of_bounds'

/** The relayer will not pay for this call. Nothing was simulated or sent. */
export class RelayRefused extends Error {
  readonly reason: RefusalReason

  constructor(reason: RefusalReason) {
    super(`relay refused: ${reason}`)
    this.name = 'RelayRefused'
    this.reason = reason
  }
}

/** The call would fail on chain. Nothing was sent and no gas was spent. */
export class SimulationReverted extends Error {
  /** Raw revert data, when the node returned any. */
  readonly data: Hex | undefined

  constructor(data: Hex | undefined) {
    super('the call would revert')
    this.name = 'SimulationReverted'
    this.data = data
  }
}

/** The node refused the signed transaction. It was never accepted, so no gas was spent. */
export class BroadcastRejected extends Error {
  readonly nonceTooLow: boolean

  constructor(nonceTooLow: boolean) {
    super('the node rejected the transaction')
    this.name = 'BroadcastRejected'
    this.nonceTooLow = nonceTooLow
  }
}

/** The transaction was handed to the node but no receipt arrived in time. It may still be included. */
export class InclusionUnknown extends Error {
  readonly transactionHash: Hex

  constructor(transactionHash: Hex) {
    super('the transaction was sent but its outcome is not known yet')
    this.name = 'InclusionUnknown'
    this.transactionHash = transactionHash
  }
}

export type UnavailableReason = 'chain_mismatch' | 'unfunded' | 'gas_price_too_high' | 'busy'

/** The relayer cannot send anything right now. */
export class RelayerUnavailable extends Error {
  readonly reason: UnavailableReason

  constructor(reason: UnavailableReason) {
    super(`relayer unavailable: ${reason}`)
    this.name = 'RelayerUnavailable'
    this.reason = reason
  }
}
