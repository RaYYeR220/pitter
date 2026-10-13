import { describe, expect, it } from 'vitest'
import { HOUR_MS, ScopeError, ScopeLedger, type SessionScope } from '@/lib/account'

const START = 1_800_000_000_000
const MINUTE = 60_000

const scope = (overrides: Partial<SessionScope> = {}): SessionScope => ({
  actions: ['cover.buy'],
  maxSpendPerHour: 5_000_000n,
  expiresAt: START + 4 * HOUR_MS,
  idleTimeoutMs: 20 * MINUTE,
  ...overrides,
})

describe('ScopeLedger', () => {
  it('allows a cover purchase inside every limit', () => {
    const ledger = new ScopeLedger(scope(), START)
    expect(ledger.check('cover.buy', 1_000_000n, START)).toEqual({ allowed: true })
  })

  it('refuses every action other than a cover purchase', () => {
    const ledger = new ScopeLedger(scope(), START)
    for (const action of ['cash_out', 'pool.deposit', 'pool.leave', 'token.transfer', '']) {
      expect(ledger.check(action, 1n, START)).toEqual({ allowed: false, reason: 'action' })
      expect(() => ledger.reserve(action, 1n, START)).toThrow(ScopeError)
    }
  })

  it('refuses amounts that are not a spend', () => {
    const ledger = new ScopeLedger(scope(), START)
    expect(ledger.check('cover.buy', 0n, START)).toEqual({ allowed: false, reason: 'amount' })
    expect(ledger.check('cover.buy', -5n, START)).toEqual({ allowed: false, reason: 'amount' })
  })

  it('books each spend and refuses the one that would pass the hourly limit', () => {
    const ledger = new ScopeLedger(scope(), START)
    ledger.reserve('cover.buy', 2_000_000n, START)
    ledger.reserve('cover.buy', 2_500_000n, START + MINUTE)
    expect(ledger.spentInLastHour(START + MINUTE)).toBe(4_500_000n)
    expect(ledger.remaining(START + MINUTE)).toBe(500_000n)

    const decision = ledger.check('cover.buy', 500_001n, START + 2 * MINUTE)
    expect(decision).toEqual({
      allowed: false,
      reason: 'spend_limit',
      remaining: 500_000n,
      availableAt: START + HOUR_MS,
    })
    expect(() => ledger.reserve('cover.buy', 500_001n, START + 2 * MINUTE)).toThrow(ScopeError)
    expect(ledger.spentInLastHour(START + 2 * MINUTE)).toBe(4_500_000n)

    expect(ledger.check('cover.buy', 500_000n, START + 2 * MINUTE)).toEqual({ allowed: true })
  })

  it('lets a spend drop out of the limit an hour after it was made', () => {
    const ledger = new ScopeLedger(scope({ idleTimeoutMs: 3 * HOUR_MS }), START)
    ledger.reserve('cover.buy', 5_000_000n, START)
    expect(ledger.check('cover.buy', 1n, START + HOUR_MS - 1).allowed).toBe(false)
    expect(ledger.check('cover.buy', 5_000_000n, START + HOUR_MS)).toEqual({ allowed: true })
  })

  it('gives back a spend whose payment never happened', () => {
    const ledger = new ScopeLedger(scope(), START)
    const reservation = ledger.reserve('cover.buy', 5_000_000n, START)
    expect(ledger.remaining(START)).toBe(0n)
    ledger.release(reservation)
    expect(ledger.remaining(START)).toBe(5_000_000n)
  })

  it('cannot be raced past the limit by two purchases at once', () => {
    const ledger = new ScopeLedger(scope({ maxSpendPerHour: 1_000_000n }), START)
    const attempts = [600_000n, 600_000n].map((amount) => {
      try {
        ledger.reserve('cover.buy', amount, START)
        return true
      } catch {
        return false
      }
    })
    expect(attempts).toEqual([true, false])
  })

  it('ends at its expiry whatever else is going on', () => {
    const ledger = new ScopeLedger(scope(), START)
    ledger.keepAwake(true, START)
    const end = START + 4 * HOUR_MS
    expect(ledger.expiredBy(end - 1)).toBeNull()
    expect(ledger.expiredBy(end)).toBe('expired')
    expect(ledger.check('cover.buy', 1n, end)).toEqual({ allowed: false, reason: 'expired' })
  })

  it('ends after sitting idle, and activity restarts the wait', () => {
    const ledger = new ScopeLedger(scope(), START)
    expect(ledger.expiredBy(START + 20 * MINUTE - 1)).toBeNull()
    expect(ledger.expiredBy(START + 20 * MINUTE)).toBe('idle')

    ledger.touch(START + 15 * MINUTE)
    expect(ledger.expiredBy(START + 20 * MINUTE)).toBeNull()
    expect(ledger.idleDeadline()).toBe(START + 35 * MINUTE)
    expect(ledger.check('cover.buy', 1n, START + 35 * MINUTE)).toEqual({ allowed: false, reason: 'idle' })
  })

  it('does not idle out while cover keeps it awake, and starts the wait again once cover is off', () => {
    const ledger = new ScopeLedger(scope(), START)
    ledger.keepAwake(true, START)
    expect(ledger.idleDeadline()).toBeNull()
    expect(ledger.expiredBy(START + 3 * HOUR_MS)).toBeNull()

    ledger.keepAwake(false, START + 3 * HOUR_MS)
    expect(ledger.idleDeadline()).toBe(START + 3 * HOUR_MS + 20 * MINUTE)
    expect(ledger.expiredBy(START + 3 * HOUR_MS + 20 * MINUTE)).toBe('idle')
  })

  it('refuses everything once closed, and keeps the first reason', () => {
    const ledger = new ScopeLedger(scope(), START)
    ledger.close('ended')
    ledger.close('expired')
    expect(ledger.closedBy).toBe('ended')
    expect(ledger.check('cover.buy', 1n, START)).toEqual({ allowed: false, reason: 'ended' })
    expect(() => ledger.reserve('cover.buy', 1n, START)).toThrow(ScopeError)
  })
})
