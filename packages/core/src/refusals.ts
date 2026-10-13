import type { ContractErrorName } from 'viem'
import type { coverBookAbi } from './abi/CoverBook'
import type { coverPoolAbi } from './abi/CoverPool'

/** A custom error the book or the pool can refuse a sale, a request or a claim with. */
export type CoverErrorName = ContractErrorName<typeof coverBookAbi> | ContractErrorName<typeof coverPoolAbi>

/**
 * Codes for the refusals a person can act on, shared by the service's error answers and the app. The names
 * follow the service's existing error codes (`window_too_far`, `oracle_stale`, ...).
 */
export type RefusalCode =
  | 'quote_expired'
  | 'quote_signature_invalid'
  | 'quote_used'
  | 'window_invalid'
  | 'window_too_far'
  | 'window_too_soon'
  | 'policy_too_large'
  | 'premium_too_small'
  | 'area_not_served'
  | 'oracle_stale'
  | 'too_many_cells'
  | 'capacity_exhausted'
  | 'notice_not_over'
  | 'cover_still_open'
  | 'exposure_locked'
  | 'no_redeem_request'

export interface ContractRefusal {
  code: RefusalCode
  /** What the refusal is about: buying cover, or a provider's request to leave the pool and its claim. */
  stage: 'purchase' | 'exit'
}

/**
 * What each refusal of the contracts means, keyed by the custom error. The purchase errors are listed in the
 * order the book checks them (`AreaNotServed` after `PremiumTooSmall`, before `OracleStale`), then the pool's
 * caps; the exit errors in the order a claim meets them. Errors that only the owner, the book or a malformed
 * call can meet are not listed.
 */
export const CONTRACT_REFUSALS = {
  QuoteExpired: { code: 'quote_expired', stage: 'purchase' },
  BadQuoteSignature: { code: 'quote_signature_invalid', stage: 'purchase' },
  QuoteUsed: { code: 'quote_used', stage: 'purchase' },
  WindowInvalid: { code: 'window_invalid', stage: 'purchase' },
  WindowTooFar: { code: 'window_too_far', stage: 'purchase' },
  LeadTooShort: { code: 'window_too_soon', stage: 'purchase' },
  PolicyTooLarge: { code: 'policy_too_large', stage: 'purchase' },
  PremiumTooSmall: { code: 'premium_too_small', stage: 'purchase' },
  AreaNotServed: { code: 'area_not_served', stage: 'purchase' },
  OracleStale: { code: 'oracle_stale', stage: 'purchase' },
  TooManyCells: { code: 'too_many_cells', stage: 'purchase' },
  GlobalCapExceeded: { code: 'capacity_exhausted', stage: 'purchase' },
  CellCapExceeded: { code: 'capacity_exhausted', stage: 'purchase' },
  NoticeNotOver: { code: 'notice_not_over', stage: 'exit' },
  CoverStillOpen: { code: 'cover_still_open', stage: 'exit' },
  ExposureLocked: { code: 'exposure_locked', stage: 'exit' },
  NoRedeemRequest: { code: 'no_redeem_request', stage: 'exit' },
} as const satisfies Partial<Record<CoverErrorName, ContractRefusal>>

export type RefusedErrorName = keyof typeof CONTRACT_REFUSALS

/** The refusal behind a contract error name, or `undefined` for an error a person cannot act on. */
export function contractRefusal(errorName: string): ContractRefusal | undefined {
  return Object.prototype.hasOwnProperty.call(CONTRACT_REFUSALS, errorName)
    ? CONTRACT_REFUSALS[errorName as RefusedErrorName]
    : undefined
}
