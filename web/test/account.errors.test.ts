import { MeraError, type MeraErrorCode } from '@category-labs/mera'
import { describe, expect, it } from 'vitest'
import {
  ScopeError,
  SignedOutError,
  WrongAccountError,
  classifyAccountError,
  describeAccountError,
  type AccountProblemCode,
  type Platform,
} from '@/lib/account'

const capable: Platform = { secureContext: true, webAuthn: true }

const domException = (name: string) => Object.assign(new Error(name), { name })

describe('classifyAccountError', () => {
  it('maps every Mera error code', () => {
    const expected: Record<MeraErrorCode, AccountProblemCode> = {
      PRF_UNAVAILABLE: 'prf_unavailable',
      PASSKEY_OPERATION_FAILED: 'cancelled',
      CRYPTO_UNAVAILABLE: 'unsupported',
      SESSION_ENDED: 'ended',
      INPUT_INVALID: 'unknown',
      DECRYPT_FAILED: 'unknown',
      VAULT_FORMAT_INVALID: 'unknown',
    }
    for (const [code, problem] of Object.entries(expected)) {
      expect(classifyAccountError(new MeraError(code as MeraErrorCode, 'x'), capable), code).toBe(problem)
    }
  })

  it('tells a closed prompt from a browser that cannot run one', () => {
    const failed = (cause?: unknown) => new MeraError('PASSKEY_OPERATION_FAILED', 'x', { cause })
    expect(classifyAccountError(failed(domException('NotAllowedError')), capable)).toBe('cancelled')
    expect(classifyAccountError(failed(domException('AbortError')), capable)).toBe('cancelled')
    expect(classifyAccountError(failed(domException('SecurityError')), capable)).toBe('insecure')
    expect(classifyAccountError(failed(domException('NotSupportedError')), capable)).toBe('unsupported')
    expect(classifyAccountError(failed(), { secureContext: true, webAuthn: false })).toBe('unsupported')
    expect(classifyAccountError(failed(), { secureContext: false, webAuthn: false })).toBe('insecure')
  })

  it('blames an insecure page, not the device, when crypto is missing there', () => {
    const error = new MeraError('CRYPTO_UNAVAILABLE', 'x')
    expect(classifyAccountError(error, { secureContext: false, webAuthn: true })).toBe('insecure')
  })

  it('maps the account layer’s own errors', () => {
    expect(classifyAccountError(new WrongAccountError(), capable)).toBe('wrong_account')
    expect(classifyAccountError(new SignedOutError(), capable)).toBe('ended')
    expect(classifyAccountError(new ScopeError({ allowed: false, reason: 'expired' }), capable)).toBe('ended')
    expect(classifyAccountError(new Error('anything'), capable)).toBe('unknown')
    expect(classifyAccountError('a string', capable)).toBe('unknown')
  })
})

describe('describeAccountError', () => {
  it('sends a device without PRF to a supported one and does not offer a pointless retry', () => {
    const problem = describeAccountError(new MeraError('PRF_UNAVAILABLE', 'x'), capable)
    expect(problem.code).toBe('prf_unavailable')
    expect(problem.retry).toBe(false)
    expect(problem.suggestPhone).toBe(true)
    const text = problem.guidance.join(' ')
    for (const device of ['iCloud Keychain', 'Google Password Manager', '1Password', 'Windows 11', 'YubiKey']) {
      expect(text).toContain(device)
    }
    for (const unsupported of ['Chrome profile', 'Bitwarden', 'Dashlane']) expect(text).toContain(unsupported)
    expect(text).toContain('open this page on your phone')
  })

  it('offers a retry after a closed prompt', () => {
    const problem = describeAccountError(new MeraError('PASSKEY_OPERATION_FAILED', 'x'), capable)
    expect(problem).toMatchObject({ code: 'cancelled', retry: true, suggestPhone: false })
    expect(problem.guidance.length).toBeGreaterThan(0)
  })

  it('has a title and guidance for every problem', () => {
    const codes: AccountProblemCode[] = [
      'prf_unavailable',
      'cancelled',
      'unsupported',
      'insecure',
      'wrong_account',
      'ended',
      'unknown',
    ]
    const errors: Record<AccountProblemCode, unknown> = {
      prf_unavailable: new MeraError('PRF_UNAVAILABLE', 'x'),
      cancelled: new MeraError('PASSKEY_OPERATION_FAILED', 'x'),
      unsupported: new MeraError('CRYPTO_UNAVAILABLE', 'x'),
      insecure: new MeraError('PASSKEY_OPERATION_FAILED', 'x', { cause: domException('SecurityError') }),
      wrong_account: new WrongAccountError(),
      ended: new MeraError('SESSION_ENDED', 'x'),
      unknown: new Error('x'),
    }
    for (const code of codes) {
      const problem = describeAccountError(errors[code], capable)
      expect(problem.code).toBe(code)
      expect(problem.title.length).toBeGreaterThan(3)
      expect(problem.guidance.every((line) => line.length > 10)).toBe(true)
    }
  })
})
