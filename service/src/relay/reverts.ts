import { BaseError, decodeErrorResult, type Abi, type Hex } from 'viem'
import { ServiceError, conflict, forbidden, unavailable } from '../http/errors'
import type { ContractAbis } from '../ports'
import {
  BroadcastRejected,
  InclusionUnknown,
  RelayRefused,
  RelayerUnavailable,
  SimulationReverted,
} from '../relayer/errors'

const UNKNOWN = 'unknown'

/** Turns revert data into a name a client can act on: a custom error name or the revert string. */
export function describeRevert(data: Hex | undefined, abis: ContractAbis): string {
  if (!data || data === '0x') return UNKNOWN
  const errors = [...abis.coverBook, ...abis.coverPool, ...abis.weatherIndex, ...abis.token].filter(
    (item) => item.type === 'error',
  ) as Abi
  try {
    const decoded = decodeErrorResult({ abi: errors, data })
    if (decoded.errorName === 'Error') return sanitize(String(decoded.args?.[0] ?? '')) || UNKNOWN
    if (decoded.errorName === 'Panic') return 'Panic'
    return decoded.errorName
  } catch {
    return UNKNOWN
  }
}

function sanitize(reason: string): string {
  return reason.replace(/[^A-Za-z0-9 :._-]/g, '').slice(0, 96)
}

/**
 * Contract errors a client can act on, answered under a code of their own instead of `would_revert`; the
 * contract's error stays in `details.reason`. The codes are the ones `@cover/core/refusals` gives them.
 */
const REVERT_REFUSALS: Record<string, [status: number, code: string, message: string]> = {
  AreaNotServed: [422, 'area_not_served', 'Cover is not sold in this area yet'],
  PremiumTooSmall: [422, 'premium_too_small', 'The premium is below the smallest the book accepts'],
  WindowTooFar: [422, 'window_too_far', 'The window ends further ahead than cover is sold for'],
  CoverStillOpen: [409, 'cover_still_open', 'The request can be collected once the cover sold before it has ended'],
}

/** The answer for a call that would revert with `reason`: its own code when it has one, else `would_revert`. */
export function revertRefusal(reason: string, message = 'The transaction would fail'): ServiceError {
  const known = Object.prototype.hasOwnProperty.call(REVERT_REFUSALS, reason) ? REVERT_REFUSALS[reason] : undefined
  if (known) return new ServiceError(known[0], known[1], known[2], { details: { reason } })
  return conflict('would_revert', `${message}: ${reason}`, { reason })
}

const UNAVAILABLE: Record<RelayerUnavailable['reason'], [code: string, message: string]> = {
  chain_mismatch: ['relayer_misconfigured', 'The relayer is not available'],
  unfunded: ['relayer_unfunded', 'The relayer is out of funds; transactions can still be sent directly'],
  gas_price_too_high: ['gas_price_too_high', 'Network fees are above what the relayer pays; try again shortly'],
  busy: ['relayer_busy', 'The relayer is busy; try again shortly'],
}

/**
 * Maps a relayer failure to what the client is told. Node and transport errors are reduced to a generic
 * message: their text can carry RPC URLs and keys.
 */
export function relayFailure(error: unknown, abis: ContractAbis): unknown {
  if (error instanceof ServiceError) return error
  if (error instanceof SimulationReverted) {
    return revertRefusal(describeRevert(error.data, abis))
  }
  if (error instanceof RelayRefused) return forbidden('relay_refused', 'The relayer does not pay for this call')
  if (error instanceof RelayerUnavailable) {
    const [code, message] = UNAVAILABLE[error.reason]
    return unavailable(code, message)
  }
  if (error instanceof BroadcastRejected) {
    return new ServiceError(502, 'broadcast_failed', 'The network did not accept the transaction; try again')
  }
  if (error instanceof InclusionUnknown) {
    return new ServiceError(504, 'relay_pending', 'The transaction was sent but is not confirmed yet', {
      details: { transactionHash: error.transactionHash },
    })
  }
  if (error instanceof BaseError)
    return new ServiceError(502, 'rpc_unavailable', 'The network is not reachable right now')
  return error
}
