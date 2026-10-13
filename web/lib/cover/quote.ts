import { hashQuote, quoteDomain } from '@cover/core/eip712'
import { isAddressEqual, type Address, type Hex } from 'viem'
import type { PriceSlot, QuoteRequest, SignedQuote } from '../service/client'

export const MINUTE = 60

/**
 * Seconds allowed between working out a start time and the purchase landing on the chain: the quote, the
 * signature, the relay and a block or two.
 */
export const PURCHASE_ALLOWANCE_SECONDS = 20

/** The first minute cover can still start at: after the lead time, with room for the purchase to land. */
export function earliestStart(now: number, minLead: number, allowance = PURCHASE_ALLOWANCE_SECONDS): number {
  return Math.ceil((now + minLead + allowance) / MINUTE) * MINUTE
}

export interface CoverWindow {
  start: number
  end: number
  /** Time left without cover between the previous block and this one, when the previous one could not be extended in time. */
  gap: { from: number; to: number } | null
}

/**
 * The next block to buy. It starts where the paid-up cover ends, so blocks follow each other without overlap;
 * when that moment can no longer be bought, it starts at the earliest minute that can, and the stretch in
 * between is reported as a gap.
 */
export function nextWindow(now: number, minLead: number, seconds: number, coveredUntil: number | null): CoverWindow {
  const earliest = earliestStart(now, minLead)
  if (coveredUntil !== null && coveredUntil >= earliest) {
    return { start: coveredUntil, end: coveredUntil + seconds, gap: null }
  }
  return {
    start: earliest,
    end: earliest + seconds,
    gap: coveredUntil !== null && coveredUntil < earliest ? { from: coveredUntil, to: earliest } : null,
  }
}

/** Raised when a quote is not for what was asked. Nothing must be signed for it. */
export class QuoteMismatch extends Error {
  readonly field: string

  constructor(field: string) {
    super(`the quote does not match the request: ${field}`)
    this.name = 'QuoteMismatch'
    this.field = field
  }
}

/** The most a quote may charge relative to the most it can pay. The price model never exceeds 1.25. */
const MAX_PREMIUM_NUMERATOR = 2n

/**
 * Checks a quote against the request it answers and returns its digest, computed here.
 *
 * The digest becomes the nonce of the payment, so signing the payment commits to exactly these terms. It is
 * therefore never taken from the service: a quote whose terms differ from the request, or whose stated digest
 * differs from the one its terms hash to, is refused.
 */
export function checkQuote(
  signed: SignedQuote,
  request: QuoteRequest & { key: bigint },
  deployment: { chainId: number; coverBook: Address },
  now: number,
): Hex {
  const { quote } = signed
  if (!isAddressEqual(quote.holder, request.holder)) throw new QuoteMismatch('holder')
  if (quote.key !== request.key) throw new QuoteMismatch('key')
  if (quote.start !== BigInt(request.start)) throw new QuoteMismatch('start')
  if (quote.end !== BigInt(request.end)) throw new QuoteMismatch('end')
  if (quote.ratePerSecond !== request.rate) throw new QuoteMismatch('ratePerSecond')
  if (quote.expiry <= BigInt(now)) throw new QuoteMismatch('expiry')

  const maxPayout = quote.ratePerSecond * (quote.end - quote.start)
  if (quote.premium <= 0n || quote.premium > maxPayout * MAX_PREMIUM_NUMERATOR) throw new QuoteMismatch('premium')

  const digest = hashQuote(quote, quoteDomain(deployment.chainId, deployment.coverBook))
  if (digest.toLowerCase() !== signed.digest.toLowerCase()) throw new QuoteMismatch('digest')
  return digest
}

/** A quote laid out for showing: what it costs, what it can pay, and what the price was worked out from. */
export interface PriceView {
  start: number
  end: number
  seconds: number
  premium: bigint
  /** The premium spread over the window, per minute. */
  costPerMinute: bigint
  ratePerSecond: bigint
  maxPayout: bigint
  /** When the quote stops being usable, unix seconds. */
  expiresAt: number
  /** The forecast behind the price; null when the service sent no breakdown. */
  why: {
    slots: PriceSlot[]
    expectedPayout: bigint
    loadBps: number
    floorBps: number
  } | null
}

export function priceView(signed: SignedQuote): PriceView {
  const { quote, inputs } = signed
  const seconds = Number(quote.end - quote.start)
  return {
    start: Number(quote.start),
    end: Number(quote.end),
    seconds,
    premium: quote.premium,
    costPerMinute: (quote.premium * BigInt(MINUTE)) / BigInt(Math.max(seconds, 1)),
    ratePerSecond: quote.ratePerSecond,
    maxPayout: quote.ratePerSecond * BigInt(seconds),
    expiresAt: Number(quote.expiry),
    why: inputs
      ? {
          slots: inputs.slots,
          expectedPayout: inputs.expectedPayout,
          loadBps: inputs.loadBps,
          floorBps: inputs.floorBps,
        }
      : null,
  }
}
