import type { Hex } from 'viem'
import { ScopeError } from '../account/scope'
import { copy } from '../copy'
import { parseCapacity, type Capacity } from '../service/client'
import { BAD_RESPONSE, NETWORK, TIMEOUT, isServiceFailure, outcomeUnknown, type ServiceFailure } from '../service/errors'

/** Every way a request for cover, or for moving money, can be turned down. */
export type RefusalKind =
  /** The area is at its limit: sold out for now. */
  | 'area_full'
  /** The pool as a whole is at its limit. */
  | 'pool_full'
  /** No further areas can be opened. */
  | 'no_more_areas'
  /** The weather sources have gone quiet, so sales are paused. */
  | 'weather_silent'
  | 'quote_expired'
  | 'too_small'
  | 'too_far'
  | 'too_soon'
  | 'too_long'
  | 'too_large'
  | 'rate_too_high'
  | 'insufficient_balance'
  /** These minutes are already covered by this very quote. */
  | 'already_bought'
  | 'price_unavailable'
  | 'busy'
  | 'service_unavailable'
  | 'network'
  /** Sent, and not known to have landed yet. */
  | 'pending'
  | 'failed'
  | 'invalid'
  | 'unknown'

/**
 * What to do about a refusal: ask again straight away with fresh terms, wait and try again, or stop.
 */
export type RetryAdvice = 'now' | 'later' | 'never'

export interface Refusal {
  kind: RefusalKind
  /** A sentence for the person, in the app's own words. */
  message: string
  retry: RetryAdvice
  /** Seconds the service asked to wait before the next request. */
  retryAfterSeconds?: number
  /** Room left in the pool, when the service said. */
  capacity?: Capacity
  /** Hash of a transaction that was sent but is not confirmed. */
  transactionHash?: Hex
  /** Whether a transaction may have been sent although the request failed. */
  outcomeUnknown: boolean
  /** The service's error code or the contract's error name, for logs and support. */
  cause: string
}

const RETRY: Record<RefusalKind, RetryAdvice> = {
  area_full: 'never',
  pool_full: 'never',
  no_more_areas: 'never',
  weather_silent: 'never',
  quote_expired: 'now',
  too_small: 'never',
  too_far: 'never',
  too_soon: 'now',
  too_long: 'never',
  too_large: 'never',
  rate_too_high: 'never',
  insufficient_balance: 'never',
  already_bought: 'never',
  price_unavailable: 'later',
  busy: 'later',
  service_unavailable: 'later',
  network: 'later',
  pending: 'later',
  failed: 'never',
  invalid: 'never',
  unknown: 'never',
}

/** What each contract error means for the person asking. */
const REVERTS: Record<string, RefusalKind> = {
  CellCapExceeded: 'area_full',
  GlobalCapExceeded: 'pool_full',
  TooManyCells: 'no_more_areas',
  OracleStale: 'weather_silent',
  QuoteExpired: 'quote_expired',
  AuthorizationExpired: 'quote_expired',
  QuoteUsed: 'already_bought',
  AuthorizationAlreadyUsed: 'already_bought',
  PremiumTooSmall: 'too_small',
  WindowInvalid: 'too_small',
  WindowTooFar: 'too_far',
  LeadTooShort: 'too_soon',
  PolicyTooLarge: 'too_large',
  ERC20InsufficientBalance: 'insufficient_balance',
  PremiumNotReceived: 'insufficient_balance',
  DepositNotReceived: 'insufficient_balance',
  BadQuoteSignature: 'invalid',
  InvalidAuthorizationSignature: 'invalid',
  CallerMustBePayee: 'invalid',
  AuthorizationNotYetValid: 'invalid',
}

/** What each service error code means for the person asking. */
const CODES: Record<string, RefusalKind> = {
  capacity_exhausted: 'pool_full',
  too_many_cells: 'no_more_areas',
  oracle_stale: 'weather_silent',
  quote_expired: 'quote_expired',
  authorization_expired: 'quote_expired',
  window_too_soon: 'too_soon',
  window_too_far: 'too_far',
  window_too_long: 'too_long',
  window_invalid: 'too_small',
  policy_too_large: 'too_large',
  rate_too_high: 'rate_too_high',
  pricing_unavailable: 'price_unavailable',
  rate_limited: 'busy',
  relayer_busy: 'busy',
  relayer_unfunded: 'service_unavailable',
  relayer_misconfigured: 'service_unavailable',
  gas_price_too_high: 'service_unavailable',
  rpc_unavailable: 'service_unavailable',
  broadcast_failed: 'service_unavailable',
  not_configured: 'service_unavailable',
  relay_refused: 'service_unavailable',
  relay_pending: 'pending',
  in_progress: 'pending',
  reverted: 'failed',
  invalid_request: 'invalid',
  invalid_json: 'invalid',
  authorization_invalid: 'invalid',
  authorization_not_yet_valid: 'invalid',
  quote_signature_invalid: 'invalid',
  [NETWORK]: 'network',
  [TIMEOUT]: 'network',
  [BAD_RESPONSE]: 'unknown',
}

export function refusal(kind: RefusalKind, cause: string = kind, extra: Partial<Refusal> = {}): Refusal {
  return { kind, message: copy.refusals[kind], retry: RETRY[kind], outcomeUnknown: false, cause, ...extra }
}

function kindOf(failure: ServiceFailure): { kind: RefusalKind; cause: string } {
  if (failure.code === 'would_revert') {
    const reason = typeof failure.details.reason === 'string' ? failure.details.reason : 'unknown'
    return { kind: REVERTS[reason] ?? (/insufficient|exceeds balance/i.test(reason) ? 'insufficient_balance' : 'failed'), cause: reason }
  }
  if (failure.code === 'capacity_exhausted') {
    return { kind: failure.details.scope === 'cell' ? 'area_full' : 'pool_full', cause: failure.code }
  }
  const known = CODES[failure.code]
  if (known) return { kind: known, cause: failure.code }
  if (failure.status === 429) return { kind: 'busy', cause: failure.code }
  if (failure.status === 503 || failure.status === 502) return { kind: 'service_unavailable', cause: failure.code }
  if (failure.status >= 400 && failure.status < 500) return { kind: 'invalid', cause: failure.code }
  return { kind: 'unknown', cause: failure.code }
}

const HASH = /^0x[0-9a-fA-F]{64}$/

/**
 * Turns anything a request for cover can throw into a refusal with a plain sentence and a next step. It never
 * throws, and never shows the service's own wording to the person.
 */
export function refusalFrom(error: unknown): Refusal {
  if (error instanceof ScopeError) {
    return refusal('invalid', `scope:${error.reason}`)
  }
  if (!isServiceFailure(error)) {
    return refusal('unknown', error instanceof Error ? error.name : 'unknown')
  }

  const { kind, cause } = kindOf(error)
  const retryAfter = Number(error.details.retryAfterSeconds)
  const capacity = parseCapacity(error.details.capacity)
  const hash = error.details.transactionHash
  return refusal(kind, cause, {
    outcomeUnknown: outcomeUnknown(error),
    ...(Number.isFinite(retryAfter) && retryAfter > 0 ? { retryAfterSeconds: retryAfter } : {}),
    ...(capacity ? { capacity } : {}),
    ...(typeof hash === 'string' && HASH.test(hash) ? { transactionHash: hash as Hex } : {}),
  })
}
