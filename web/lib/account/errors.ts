import { isMeraError } from '@category-labs/mera'
import { copy } from '../copy'
import { ScopeError } from './scope'

export type AccountProblemCode =
  | 'prf_unavailable'
  | 'cancelled'
  | 'unsupported'
  | 'insecure'
  | 'wrong_account'
  | 'ended'
  | 'unknown'

/** A failed passkey ceremony, in words a person can act on. */
export interface AccountProblem {
  code: AccountProblemCode
  title: string
  guidance: readonly string[]
  /** Whether doing the same thing again can work. */
  retry: boolean
  /** Whether to point the person at another device. */
  suggestPhone: boolean
}

/** Raised when a fresh passkey prompt was answered with a passkey of another account. */
export class WrongAccountError extends Error {
  constructor() {
    super('the passkey belongs to a different account')
    this.name = 'WrongAccountError'
  }
}

/** Raised when something needs a signed-in account and there is none. */
export class SignedOutError extends Error {
  constructor() {
    super('not signed in')
    this.name = 'SignedOutError'
  }
}

const RETRY: Record<AccountProblemCode, boolean> = {
  prf_unavailable: false,
  cancelled: true,
  unsupported: false,
  insecure: false,
  wrong_account: true,
  ended: true,
  unknown: true,
}

const SUGGEST_PHONE: Record<AccountProblemCode, boolean> = {
  prf_unavailable: true,
  cancelled: false,
  unsupported: true,
  insecure: false,
  wrong_account: false,
  ended: false,
  unknown: true,
}

export function accountProblem(code: AccountProblemCode): AccountProblem {
  const { title, guidance } = copy.account.problems[code]
  return { code, title, guidance, retry: RETRY[code], suggestPhone: SUGGEST_PHONE[code] }
}

export interface Platform {
  /** Whether the page runs in a secure context (https or localhost). */
  secureContext: boolean
  /** Whether the browser exposes WebAuthn at all. */
  webAuthn: boolean
}

export function currentPlatform(): Platform {
  return {
    secureContext: globalThis.isSecureContext !== false,
    webAuthn: typeof globalThis.PublicKeyCredential === 'function' && !!globalThis.navigator?.credentials,
  }
}

const causeName = (error: unknown): string | null => {
  const cause = (error as { cause?: unknown }).cause
  return cause && typeof cause === 'object' && typeof (cause as { name?: unknown }).name === 'string'
    ? (cause as { name: string }).name
    : null
}

/**
 * Sorts whatever a passkey ceremony threw into the handful of situations a person can do something about.
 *
 * Mera reports a cancelled prompt and a missing WebAuthn under one code, so the platform decides between
 * them: a browser without WebAuthn, or a page outside a secure context, can never succeed by retrying.
 */
export function classifyAccountError(error: unknown, platform: Platform = currentPlatform()): AccountProblemCode {
  if (error instanceof WrongAccountError) return 'wrong_account'
  if (error instanceof SignedOutError) return 'ended'
  if (error instanceof ScopeError) return 'ended'
  if (!isMeraError(error)) return 'unknown'

  switch (error.code) {
    case 'PRF_UNAVAILABLE':
      return 'prf_unavailable'
    case 'CRYPTO_UNAVAILABLE':
      return platform.secureContext ? 'unsupported' : 'insecure'
    case 'SESSION_ENDED':
      return 'ended'
    case 'PASSKEY_OPERATION_FAILED': {
      if (!platform.secureContext) return 'insecure'
      if (!platform.webAuthn) return 'unsupported'
      const name = causeName(error)
      if (name === 'SecurityError') return 'insecure'
      if (name === 'NotSupportedError') return 'unsupported'
      return 'cancelled'
    }
    case 'INPUT_INVALID':
    case 'DECRYPT_FAILED':
    case 'VAULT_FORMAT_INVALID':
      return 'unknown'
    default:
      return 'unknown'
  }
}

export function describeAccountError(error: unknown, platform?: Platform): AccountProblem {
  return accountProblem(classifyAccountError(error, platform))
}
