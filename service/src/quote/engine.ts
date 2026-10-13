import { toHex, type Hex } from 'viem'
import type { CoverReader, Market } from '../chain/reader'
import type { Settings } from '../config'
import { ServiceError, conflict, unavailable, unprocessable } from '../http/errors'
import type { Logger } from '../http/respond'
import type { Cells, Pricing, Signing } from '../ports'
import { MINUTE, type Clock, type DigestSigner, type Quote } from '../types'
import type { CoverRequest } from '../validation'

const BPS = 10_000n
const UINT128_MAX = (1n << 128n) - 1n

/** A quote that would expire sooner than this is not worth handing out. */
const MIN_QUOTE_LIFETIME_SECONDS = 10

export interface Capacity {
  /** Assets the caps are measured against. */
  assets: bigint
  lockedExposure: bigint
  cellExposure: bigint
  /** Exposure the pool may carry in total and in this cell. */
  globalLimit: bigint
  cellLimit: bigint
  globalRemaining: bigint
  cellRemaining: bigint
  maxPolicyPayout: bigint
  /** Largest maximum payout a new policy in this cell could have right now. */
  available: bigint
}

export interface SignedQuote {
  quote: Quote
  quoteSig: Hex
  /** EIP-712 digest of the quote: the ERC-3009 nonce the holder authorises the premium with. */
  digest: Hex
  /** Maximum payout of the policy: rate times duration. */
  maxPayout: bigint
  cell: { key: bigint; lat: number; lon: number }
  inputs: unknown
  capacity: Capacity
}

/** A priced request that passed every check, not yet signed. */
export interface Offer {
  request: CoverRequest
  key: bigint
  premium: bigint
  maxPayout: bigint
  /** Last moment a quote for this offer may be used. */
  expiry: number
  cell: { key: bigint; lat: number; lon: number }
  inputs: unknown
  capacity: Capacity
}

export interface QuoteEngineDeps {
  settings: Pick<Settings, 'chainId' | 'contracts' | 'quote'>
  reader: CoverReader
  cells: Cells
  pricing: Pricing
  signing: Signing
  underwriter: DigestSigner
  now: Clock
  logger: Logger
}

const floorNonNegative = (value: bigint) => (value > 0n ? value : 0n)
const min = (...values: bigint[]) => values.reduce((a, b) => (b < a ? b : a))

export function capacityOf(market: Market): Capacity {
  const globalLimit = (market.assets * BigInt(market.maxUtilizationBps)) / BPS
  const cellLimit = (market.assets * BigInt(market.maxCellBps)) / BPS
  const globalRemaining = floorNonNegative(globalLimit - market.lockedExposure)
  const cellRemaining = floorNonNegative(cellLimit - market.cellExposure)
  return {
    assets: market.assets,
    lockedExposure: market.lockedExposure,
    cellExposure: market.cellExposure,
    globalLimit,
    cellLimit,
    globalRemaining,
    cellRemaining,
    maxPolicyPayout: market.maxPolicyPayout,
    available: min(globalRemaining, cellRemaining, market.maxPolicyPayout),
  }
}

/**
 * Prices cover and signs the quote with the underwriter key. A signature commits pool capital, so nothing is
 * signed unless the book would accept it right now: the window is in the future and within bounds, the rate
 * is under the configured maximum, the pool has room in total and in the cell, and the oracle is reporting.
 */
export class QuoteEngine {
  private readonly deps: QuoteEngineDeps

  constructor(deps: QuoteEngineDeps) {
    this.deps = deps
  }

  /**
   * Checks a request against the book, the pool and the oracle, and prices it. Signs nothing.
   */
  async offer(request: CoverRequest): Promise<Offer> {
    const { settings, reader, cells, pricing, now, logger } = this.deps
    const { start, end, rate, lat, lon } = request

    if (start % BigInt(MINUTE) !== 0n || end % BigInt(MINUTE) !== 0n) {
      throw unprocessable('window_invalid', 'The window must start and end on a whole minute')
    }
    if (end <= start) throw unprocessable('window_invalid', 'The window must end after it starts')
    const duration = end - start
    if (duration > BigInt(settings.quote.maxDurationSeconds)) {
      throw unprocessable('window_too_long', 'The window is longer than the longest cover on offer', {
        maxDurationSeconds: settings.quote.maxDurationSeconds,
      })
    }
    if (rate > settings.quote.maxRatePerSecond) {
      throw unprocessable('rate_too_high', 'The payout rate is above the maximum on offer', {
        maxRatePerSecond: settings.quote.maxRatePerSecond.toString(),
      })
    }

    const key = cells.keyAt(lat, lon)
    const market = await reader.market(key)
    const time = Math.max(now(), market.head.timestamp)

    if (duration < BigInt(market.minDuration) || duration > BigInt(market.maxDuration)) {
      throw unprocessable('window_invalid', 'The window length is outside what the book accepts', {
        minDurationSeconds: market.minDuration,
        maxDurationSeconds: Math.min(market.maxDuration, settings.quote.maxDurationSeconds),
      })
    }

    const earliestStart = Math.ceil((time + market.minLead + MIN_QUOTE_LIFETIME_SECONDS) / MINUTE) * MINUTE
    if (start < BigInt(earliestStart)) {
      throw unprocessable('window_too_soon', 'The window starts too soon', { earliestStart })
    }

    const oracleFreshUntil = market.heartbeat + market.maxOracleAge
    if (time + MIN_QUOTE_LIFETIME_SECONDS > oracleFreshUntil) {
      throw unavailable('oracle_stale', 'Sales are paused until the weather oracle reports again', {
        heartbeat: market.heartbeat,
        maxOracleAgeSeconds: market.maxOracleAge,
      })
    }

    const maxPayout = rate * duration
    const capacity = capacityOf(market)
    const capacityDetails = { capacity: stringifyCapacity(capacity), maxPayout: maxPayout.toString() }
    if (maxPayout > market.maxPolicyPayout) {
      throw unprocessable('policy_too_large', 'The cover is larger than a single policy may be', capacityDetails)
    }
    if (maxPayout > capacity.globalRemaining) {
      throw conflict('capacity_exhausted', 'The pool cannot back this cover right now', {
        scope: 'pool',
        ...capacityDetails,
      })
    }
    if (maxPayout > capacity.cellRemaining) {
      throw conflict('capacity_exhausted', 'The pool cannot back more cover in this cell right now', {
        scope: 'cell',
        ...capacityDetails,
      })
    }
    if (market.cellOpenPolicies === 0n && market.activeCells >= market.maxActiveCells) {
      throw conflict('too_many_cells', 'No further cells can be covered right now')
    }

    let price
    try {
      price = await pricing.price({
        key,
        lat,
        lon,
        start: Number(start),
        end: Number(end),
        ratePerSecond: rate,
        now: time,
      })
    } catch (error) {
      if (error instanceof ServiceError) throw error
      logger.warn('pricing failed', { error })
      throw unavailable('pricing_unavailable', 'No forecast is available to price this cover')
    }

    const floor = (maxPayout * BigInt(settings.quote.minPremiumBps) + BPS - 1n) / BPS
    const premium = [price.premium, market.minPremium, floor, 1n].reduce((a, b) => (b > a ? b : a))
    if (premium > UINT128_MAX) throw unprocessable('policy_too_large', 'The premium is out of range')

    return {
      request,
      key,
      premium,
      maxPayout,
      expiry: Math.min(time + settings.quote.ttlSeconds, Number(start) - market.minLead, oracleFreshUntil),
      cell: { key, ...cells.locate(key) },
      inputs: price.inputs,
      capacity,
    }
  }

  /**
   * Prices a request and signs the quote.
   *
   * @param paid When the caller has already committed to paying an amount, the quote is written for exactly
   * that premium, provided it covers the current price; otherwise the request is refused with `price_changed`.
   */
  async quote(request: CoverRequest, paid?: bigint): Promise<SignedQuote> {
    const { settings, signing, underwriter } = this.deps
    const offer = await this.offer(request)

    let premium = offer.premium
    if (paid !== undefined) {
      if (paid < premium) {
        throw conflict('price_changed', 'The price is now higher than the amount paid', {
          premium: premium.toString(),
        })
      }
      if (paid > UINT128_MAX) throw unprocessable('policy_too_large', 'The premium is out of range')
      premium = paid
    }

    const quote: Quote = {
      holder: request.holder,
      key: offer.key,
      start: request.start,
      end: request.end,
      ratePerSecond: request.rate,
      premium,
      expiry: BigInt(offer.expiry),
      salt: toHex(crypto.getRandomValues(new Uint8Array(32))),
    }
    const digest = signing.quoteDigest(quote, settings.chainId, settings.contracts.coverBook)
    const quoteSig = await underwriter.sign({ hash: digest })

    return {
      quote,
      quoteSig,
      digest,
      maxPayout: offer.maxPayout,
      cell: offer.cell,
      inputs: offer.inputs,
      capacity: offer.capacity,
    }
  }
}

export function stringifyCapacity(capacity: Capacity): Record<string, string> {
  return Object.fromEntries(Object.entries(capacity).map(([name, value]) => [name, String(value)]))
}

/** JSON form of a quote: every integer as a decimal string, ready to be posted back to a relay endpoint. */
export function quoteToJson(quote: Quote): Record<string, string> {
  return {
    holder: quote.holder,
    key: quote.key.toString(),
    start: quote.start.toString(),
    end: quote.end.toString(),
    ratePerSecond: quote.ratePerSecond.toString(),
    premium: quote.premium.toString(),
    expiry: quote.expiry.toString(),
    salt: quote.salt,
  }
}

export function signedQuoteToJson(signed: SignedQuote): Record<string, unknown> {
  return {
    quote: quoteToJson(signed.quote),
    quoteSig: signed.quoteSig,
    digest: signed.digest,
    maxPayout: signed.maxPayout.toString(),
    cell: { key: signed.cell.key.toString(), lat: signed.cell.lat, lon: signed.cell.lon },
    inputs: signed.inputs,
    capacity: stringifyCapacity(signed.capacity),
  }
}
