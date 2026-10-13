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
    const reason = describeRevert(error.data, abis)
    return conflict('would_revert', `The transaction would fail: ${reason}`, { reason })
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
