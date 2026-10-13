import { keyFromLatLon } from '@cover/core/cells'
import { hashQuote, quoteDomain, signQuote, type Quote } from '@cover/core/eip712'
import { isAddressEqual, keccak256, recoverTypedDataAddress, toHex, type Address, type Hex } from 'viem'
import { generatePrivateKey } from 'viem/accounts'
import { SigningSession, type SessionScope } from '@/lib/account'
import { receiveAuthorization, type Authorization, type TokenDomain } from '@/lib/chain/erc3009'
import type { CoverEnginePorts } from '@/lib/cover/engine'
import { ServiceFailure } from '@/lib/service/errors'
import type { BuyReceipt, QuoteRequest, SignedQuote } from '@/lib/service/client'

export const CHAIN_ID = 10143
export const COVER_BOOK: Address = '0x58d970780565E4C064369AD80eEC2D3581d6d75D'
export const TOKEN: Address = '0xDe6fb6D4C560C5901f733D53e591F2A0D6EB1438'
export const DOMAIN: TokenDomain = { name: 'Test Dollar', version: '1', chainId: CHAIN_ID, verifyingContract: TOKEN }

/** Unix seconds, on a whole minute. */
export const T0 = 1_800_000_000

export interface Purchase {
  quote: Quote
  digest: Hex
  authorization: Authorization
}

type Failure = ServiceFailure | Error

/**
 * A stand-in for the service and the chain behind it. It signs quotes and checks payments the way the real
 * ones do: the quote's digest must be the payment's nonce, the payment must be signed by the holder for the
 * cover book, a digest is spent once, and the balance must cover the premium.
 */
export function fakeMarket(options: { balance?: bigint; minLead?: number; premiumPerSecondOfRate?: bigint } = {}) {
  let now = T0
  const underwriter = generatePrivateKey()
  const used = new Set<Hex>()
  const purchases: Purchase[] = []
  const quoteFailures: Failure[] = []
  const relayFailures: Array<{ error: Failure; land: boolean }> = []
  const balances = new Map<string, bigint>()
  const premiumFactor = options.premiumPerSecondOfRate ?? 1n
  let quotes = 0
  let quoteOverride: ((signed: SignedQuote) => SignedQuote) | null = null
  const domain = quoteDomain(CHAIN_ID, COVER_BOOK)

  const balanceOf = (holder: Address) => balances.get(holder.toLowerCase()) ?? options.balance ?? 100_000_000n

  async function verify(signed: SignedQuote, authorization: Authorization): Promise<Hex> {
    const { quote } = signed
    const digest = hashQuote(quote, domain)
    const signer = await recoverTypedDataAddress({
      ...receiveAuthorization(DOMAIN, {
        from: quote.holder,
        to: COVER_BOOK,
        value: quote.premium,
        validAfter: authorization.validAfter,
        validBefore: authorization.validBefore,
        nonce: digest,
      }),
      signature: { r: authorization.r, s: authorization.s, v: BigInt(authorization.v) },
    })
    if (!isAddressEqual(signer, quote.holder)) {
      throw new ServiceFailure(400, 'authorization_invalid', 'The payment authorization was not signed by the payer')
    }
    return digest
  }

  function land(signed: SignedQuote, authorization: Authorization, digest: Hex): BuyReceipt {
    const { quote } = signed
    if (used.has(digest)) {
      throw new ServiceFailure(409, 'would_revert', 'The transaction would fail: QuoteUsed', { reason: 'QuoteUsed' })
    }
    if (BigInt(now) > quote.expiry) {
      throw new ServiceFailure(409, 'quote_expired', 'The quote has expired; request a new one')
    }
    const balance = balanceOf(quote.holder)
    if (balance < quote.premium) {
      throw new ServiceFailure(409, 'would_revert', 'The transaction would fail: ERC20InsufficientBalance', {
        reason: 'ERC20InsufficientBalance',
      })
    }
    balances.set(quote.holder.toLowerCase(), balance - quote.premium)
    used.add(digest)
    purchases.push({ quote, digest, authorization })
    return {
      transactionHash: keccak256(digest),
      blockNumber: BigInt(purchases.length),
      policyId: BigInt(purchases.length),
      holder: quote.holder,
      digest,
    }
  }

  const ports: Omit<CoverEnginePorts, 'signer'> = {
    now: () => now,
    deployment: { chainId: CHAIN_ID, coverBook: COVER_BOOK },

    async quote(request: QuoteRequest): Promise<SignedQuote> {
      quotes++
      const failure = quoteFailures.shift()
      if (failure) throw failure
      const quote: Quote = {
        holder: request.holder,
        key: keyFromLatLon(request.lat, request.lon),
        start: BigInt(request.start),
        end: BigInt(request.end),
        ratePerSecond: request.rate,
        premium: (request.rate * BigInt(request.end - request.start) * premiumFactor) / 100n,
        expiry: BigInt(Math.min(now + 120, request.start)),
        salt: toHex(crypto.getRandomValues(new Uint8Array(32))),
      }
      const signed: SignedQuote = {
        quote,
        quoteSig: signQuote(quote, underwriter, domain),
        digest: hashQuote(quote, domain),
        maxPayout: quote.ratePerSecond * (quote.end - quote.start),
        cell: { key: quote.key, lat: request.lat, lon: request.lon },
        inputs: {
          expectedPayout: quote.premium / 2n,
          expectedWetSeconds: 6,
          loadBps: 2500,
          floorBps: 100,
          slots: [
            {
              start: request.start,
              end: request.end,
              seconds: request.end - request.start,
              forecastMmPerHour: 0,
              precipitationProbability: 1,
              probabilityWet: 0.01,
              basis: 'floor',
            },
          ],
        },
        capacity: null,
      }
      return quoteOverride ? quoteOverride(signed) : signed
    },

    async relayBuy(signed, authorization) {
      const digest = await verify(signed, authorization)
      const failure = relayFailures.shift()
      if (failure) {
        if (failure.land) land(signed, authorization, digest)
        throw failure.error
      }
      return land(signed, authorization, digest)
    },

    balance: async (holder) => balanceOf(holder),
    quoteUsed: async (digest) => used.has(digest),
    minLead: async () => options.minLead ?? 0,
    async coveredUntil(holder, key) {
      let latest: number | null = null
      for (const { quote } of purchases) {
        if (!isAddressEqual(quote.holder, holder) || quote.key !== key || Number(quote.end) <= now) continue
        latest = Math.max(latest ?? 0, Number(quote.end))
      }
      return latest
    },
  }

  return {
    ports,
    purchases,
    quotesAsked: () => quotes,
    advance(seconds: number) {
      now += seconds
    },
    set(seconds: number) {
      now = seconds
    },
    now: () => now,
    /** The next quote request fails with `error`. */
    failQuote(error: Failure) {
      quoteFailures.push(error)
    },
    /** The next relay fails with `error`; with `land`, the purchase happens on chain all the same. */
    failRelay(error: Failure, land = false) {
      relayFailures.push({ error, land })
    },
    setBalance(holder: Address, amount: bigint) {
      balances.set(holder.toLowerCase(), amount)
    },
    balanceOf,
    tamperQuotes(change: ((signed: SignedQuote) => SignedQuote) | null) {
      quoteOverride = change
    },
    /** Every pair of purchases for the same holder and area that share a second. */
    overlaps(): Array<[Purchase, Purchase]> {
      const found: Array<[Purchase, Purchase]> = []
      purchases.forEach((a, i) =>
        purchases.slice(i + 1).forEach((b) => {
          if (
            a.quote.holder === b.quote.holder &&
            a.quote.key === b.quote.key &&
            a.quote.start < b.quote.end &&
            b.quote.start < a.quote.end
          ) {
            found.push([a, b])
          }
        }),
      )
      return found
    },
  }
}

/** A signed-in session on the clock of the market; on a throwaway key unless one is given. */
export function session(
  now: () => number,
  scope: Partial<SessionScope> = {},
  privateKey: Uint8Array = crypto.getRandomValues(new Uint8Array(32)),
): SigningSession {
  return new SigningSession({
    privateKey: Uint8Array.from(privateKey),
    credential: { credentialId: 'engine-test' },
    scope: {
      actions: ['cover.buy'],
      maxSpendPerHour: 1_000_000_000n,
      expiresAt: (now() + 8 * 3600) * 1000,
      idleTimeoutMs: 20 * 60_000,
      ...scope,
    },
    terms: async () => ({ domain: DOMAIN, payee: COVER_BOOK }),
    now: () => now() * 1000,
  })
}
