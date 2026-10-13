import { describe, expect, it } from 'vitest'
import { coverBookAbi, coverPoolAbi } from '../src/abi'
import { CONTRACT_REFUSALS, contractRefusal } from '../src/refusals'

const errorsOf = (abi: readonly { type: string; name?: string }[]) =>
  abi.filter((entry) => entry.type === 'error').map((entry) => entry.name)

describe('contract refusals', () => {
  it('names only errors the book or the pool can revert with', () => {
    const known = new Set([...errorsOf(coverBookAbi), ...errorsOf(coverPoolAbi)])
    for (const name of Object.keys(CONTRACT_REFUSALS)) expect(known.has(name), name).toBe(true)
  })

  it('gives the served-area, exit and floor refusals codes of their own', () => {
    expect(contractRefusal('AreaNotServed')).toEqual({ code: 'area_not_served', stage: 'purchase' })
    expect(contractRefusal('CoverStillOpen')).toEqual({ code: 'cover_still_open', stage: 'exit' })
    expect(contractRefusal('PremiumTooSmall')).toEqual({ code: 'premium_too_small', stage: 'purchase' })
    expect(contractRefusal('WindowTooFar')).toEqual({ code: 'window_too_far', stage: 'purchase' })
    expect(contractRefusal('LeadTooShort')?.code).toBe('window_too_soon')
  })

  it('lists the purchase refusals in the order the book checks them', () => {
    const purchase = Object.entries(CONTRACT_REFUSALS)
      .filter(([, refusal]) => refusal.stage === 'purchase')
      .map(([name]) => name)
    expect(purchase.indexOf('PremiumTooSmall')).toBeLessThan(purchase.indexOf('AreaNotServed'))
    expect(purchase.indexOf('AreaNotServed')).toBeLessThan(purchase.indexOf('OracleStale'))
  })

  it('knows nothing of errors a person cannot act on, nor of inherited object keys', () => {
    expect(contractRefusal('ReentrancyGuardReentrantCall')).toBeUndefined()
    expect(contractRefusal('toString')).toBeUndefined()
    expect(contractRefusal('')).toBeUndefined()
  })

  it('covers every error a buyer can meet at purchase', () => {
    for (const name of ['AreaNotServed', 'PremiumTooSmall', 'WindowTooFar', 'OracleStale', 'TooManyCells']) {
      expect(contractRefusal(name)?.stage, name).toBe('purchase')
    }
  })
})
