import { decodePaymentSignatureHeader, encodePaymentRequiredHeader, encodePaymentResponseHeader } from '@x402/core/http'
import type { PaymentPayload, PaymentRequired, PaymentRequirements, SettleResponse } from '@x402/core/types'
import { isAddressEqual, maxUint256, type Hex } from 'viem'
import { z } from 'zod'
import { eventsOf } from '../chain/events'
import type { Context } from '../context'
import { readJson } from '../http/body'
import { ServiceError, badRequest, conflict, unavailable } from '../http/errors'
import { limitByAddress, limitByIp, requireMethod } from '../http/request'
import { json, type Handler } from '../http/respond'
import { quoteToJson, stringifyCapacity, type Offer } from '../quote/engine'
import { describeRevert, relayFailure } from '../relay/reverts'
import { SimulationReverted } from '../relayer/errors'
import type { Json } from '../stores/ledger'
import type { Quote } from '../types'
import { address, bytes32, coverRequestSchema, quoteSchema, signature, uint, type CoverRequest } from '../validation'

export const COVER_PATH = '/v1/cover'
export const PAYMENT_SIGNATURE_HEADER = 'payment-signature'
export const PAYMENT_REQUIRED_HEADER = 'payment-required'
export const PAYMENT_RESPONSE_HEADER = 'payment-response'

const X402_VERSION = 2
const RECENT_POLICIES = 50

const paymentSchema = z.looseObject({
  x402Version: z.literal(X402_VERSION),
  accepted: z.looseObject({
    scheme: z.literal('exact'),
    network: z.string(),
    asset: address,
    amount: uint(128),
    payTo: address,
  }),
  payload: z.looseObject({
    signature: z.string().regex(/^0x[0-9a-fA-F]+$/),
    authorization: z.looseObject({
      from: address,
      to: address,
      value: uint(256),
      nonce: bytes32,
    }),
  }),
})

/** What is kept about a payment from the moment it settles: enough to finish or audit the purchase. */
const recordSchema = z.object({
  request: z.record(z.string(), z.string()),
  settlement: z.object({
    transaction: z.string(),
    network: z.string(),
    payer: z.string(),
    amount: z.string(),
  }),
  quote: quoteSchema,
  quoteSig: signature,
  digest: bytes32,
})

type PaymentRecord = z.infer<typeof recordSchema>

function requestToJson(request: CoverRequest): Record<string, string> {
  return {
    lat: String(request.lat),
    lon: String(request.lon),
    start: request.start.toString(),
    end: request.end.toString(),
    rate: request.rate.toString(),
    holder: request.holder,
  }
}

/** A facilitator's reason code, cut down to what is safe to repeat to a client. */
const printable = (reason: unknown) =>
  String(reason ?? 'rejected')
    .replace(/[^A-Za-z0-9 _.:-]/g, '')
    .slice(0, 64)

const sameRequest = (a: Record<string, string>, b: Record<string, string>) =>
  Object.keys(a).length === Object.keys(b).length && Object.entries(a).every(([name, value]) => b[name] === value)

/**
 * `POST /v1/cover` — cover for a holder, paid over HTTP with x402 (`exact` scheme, the dollar token).
 *
 * Without a payment the answer is 402 with the price. With one, the payment is verified, settled through the
 * facilitator, and only then does the service buy the policy from the balance the payment landed in.
 *
 * A payment is identified by its payer and authorization nonce. From claim to finish that identity is held
 * in the ledger: a second request with the same payment gets the first one's answer, never a second policy.
 * Once a payment has settled, the purchase it paid for is recorded with its quote, and every later attempt
 * reuses that quote while it is valid, so the book itself rejects a duplicate.
 */
export function coverHandler(context: Context): Handler {
  const { settings, reader, relayer, calls, core, stores, quotes, facilitator, logger } = context
  const { limits, contracts } = settings
  const network = `eip155:${settings.chainId}` as const
  let approved = false

  async function requirementsFor(amount: bigint): Promise<PaymentRequirements> {
    const domain = await reader.tokenDomain()
    return {
      scheme: 'exact',
      network,
      asset: contracts.token,
      amount: amount.toString(),
      payTo: relayer.address,
      maxTimeoutSeconds: settings.x402.maxTimeoutSeconds,
      extra: { name: domain.name, version: domain.version },
    }
  }

  async function paymentRequired(request: Request, offer: Offer, reason = 'Payment required'): Promise<Response> {
    const required: PaymentRequired = {
      x402Version: X402_VERSION,
      error: reason,
      resource: {
        url: request.url,
        description: 'Rain cover for one window in one cell, paid out per wet second',
        mimeType: 'application/json',
      },
      accepts: [await requirementsFor(offer.premium)],
    }
    return json(
      {
        error: { code: 'payment_required', message: reason },
        premium: offer.premium.toString(),
        maxPayout: offer.maxPayout.toString(),
        cell: { key: offer.cell.key.toString(), lat: offer.cell.lat, lon: offer.cell.lon },
        inputs: offer.inputs,
        capacity: stringifyCapacity(offer.capacity),
        accepts: required.accepts,
      },
      { status: 402, headers: { [PAYMENT_REQUIRED_HEADER]: encodePaymentRequiredHeader(required) } },
    )
  }

  function decodePayment(header: string) {
    let payload: PaymentPayload
    try {
      payload = decodePaymentSignatureHeader(header)
    } catch {
      throw badRequest('invalid_payment', 'The payment header cannot be read')
    }
    const parsed = paymentSchema.safeParse(payload)
    if (!parsed.success) throw badRequest('invalid_payment', 'The payment is not an x402 v2 exact payment')
    return { payload, fields: parsed.data }
  }

  async function verify(payload: PaymentPayload, requirements: PaymentRequirements) {
    try {
      return await facilitator!.verify(payload, requirements)
    } catch (error) {
      logger.warn('the payment facilitator could not verify a payment', { error })
      throw new ServiceError(502, 'facilitator_unavailable', 'The payment facilitator is not reachable right now')
    }
  }

  /** The relayer pays premiums through an allowance to the book. It is granted once, to the book only. */
  async function ensureAllowance(amount: bigint): Promise<void> {
    if (approved) return
    if ((await reader.allowance(relayer.address, contracts.coverBook)) < amount) {
      const receipt = await relayer.execute(calls.approve(contracts.coverBook, maxUint256))
      if (receipt.status !== 'success') throw unavailable('relayer_misconfigured', 'The relayer is not available')
    }
    approved = true
  }

  /**
   * Checks, before any money moves, that the book would sell this policy. The book validates the cover and
   * reserves it in the pool before it collects the premium, so a simulation that only fails on the relayer's
   * token balance has passed every cover check: the balance arrives with the payment.
   */
  async function assertSellable(quote: Quote, quoteSig: Hex): Promise<void> {
    try {
      await relayer.preflight(calls.buy(quote, quoteSig))
    } catch (error) {
      if (!(error instanceof SimulationReverted)) throw error
      const reason = describeRevert(error.data, core.abis)
      if (/InsufficientBalance|exceeds balance/.test(reason)) return
      throw conflict('would_revert', `The purchase would fail: ${reason}`, { reason })
    }
  }

  async function findPolicy(quote: Quote): Promise<string | null> {
    const count = await reader.policyCount()
    const ids: bigint[] = []
    for (let id = count; id >= 1n && ids.length < RECENT_POLICIES; id--) ids.push(id)
    const match = (await reader.policies(ids)).find(
      (policy) =>
        isAddressEqual(policy.holder, quote.holder) &&
        policy.key === quote.key &&
        BigInt(policy.start) === quote.start &&
        BigInt(policy.end) === quote.end &&
        policy.premium === quote.premium,
    )
    return match ? match.id.toString() : null
  }

  function finished(result: Json): Response {
    const settlement = (result as { payment: SettleResponse }).payment
    return json(result, { headers: { [PAYMENT_RESPONSE_HEADER]: encodePaymentResponseHeader(settlement) } })
  }

  /**
   * Buys the policy a settled payment paid for. The claim on the payment is held throughout; on failure it
   * is handed back as `settled`, so the next attempt resumes here.
   *
   * @param recorded Whether the settlement is in the ledger. If it could not be written, a failed purchase
   * keeps the claim instead of handing it back: releasing a claim with nothing recorded would forget that
   * the payment was ever made.
   */
  async function issue(paymentId: string, record: PaymentRecord, recorded = true): Promise<Response> {
    const result = (policyId: string | null, transactionHash: string | null): Json => ({
      policyId,
      holder: record.quote.holder,
      quote: quoteToJson(record.quote),
      digest: record.digest,
      transactionHash,
      payment: { success: true, ...record.settlement },
    })

    let outcome: Json
    try {
      if (await reader.quoteUsed(record.digest)) {
        outcome = result(await findPolicy(record.quote), null)
      } else {
        if (record.quote.expiry < BigInt(context.now())) {
          const fresh = await quotes.quote(coverRequestSchema.parse(record.request), record.quote.premium)
          record = { ...record, quote: fresh.quote, quoteSig: fresh.quoteSig, digest: fresh.digest }
          await stores.ledger.checkpoint(paymentId, recordToJson(record), context.now())
        }
        const receipt = await relayer.execute(calls.buy(record.quote, record.quoteSig))
        if (receipt.status !== 'success') throw conflict('reverted', 'The purchase was included but failed')
        const [bought] = eventsOf(core.abis.coverBook, contracts.coverBook, receipt.logs, 'PolicyBought')
        outcome = result(bought ? String(bought.id) : null, receipt.transactionHash)
      }
    } catch (error) {
      if (recorded) await stores.ledger.release(paymentId)
      logger.error('a settled payment has no policy yet', { paymentId, payment: record.settlement, error })
      const failure = relayFailure(error, core.abis)
      const cause = failure instanceof ServiceError ? { cause: failure.code, ...failure.details } : {}
      throw new ServiceError(
        502,
        'cover_pending',
        'The payment settled but the cover is not issued yet; send the same request again',
        {
          details: { paymentId, payment: record.settlement, ...cause },
        },
      )
    }

    try {
      await stores.ledger.save(paymentId, 'done', outcome, context.now())
    } catch (error) {
      logger.error('an issued policy could not be recorded against its payment', { paymentId, error })
    }
    return finished(outcome)
  }

  function recordToJson(record: PaymentRecord): Json {
    return { ...record, quote: quoteToJson(record.quote) }
  }

  return async (request) => {
    requireMethod(request, 'POST')
    if (!settings.x402.enabled || !facilitator) throw unavailable('not_configured', 'This endpoint is not enabled')
    await limitByIp(context, request, 'cover', limits.coverPerIp)
    const input = coverRequestSchema.parse(await readJson(request))

    const header = request.headers.get(PAYMENT_SIGNATURE_HEADER)
    if (!header) {
      await limitByAddress(context, 'quote', input.holder, limits.quotePerAddress)
      return paymentRequired(request, await quotes.offer(input))
    }

    const { payload, fields } = decodePayment(header)
    const { accepted } = fields
    const { authorization } = fields.payload
    const expected =
      accepted.network === network &&
      isAddressEqual(accepted.asset, contracts.token) &&
      isAddressEqual(accepted.payTo, relayer.address) &&
      isAddressEqual(authorization.to, relayer.address) &&
      authorization.value === accepted.amount
    if (!expected) {
      return paymentRequired(request, await quotes.offer(input), 'The payment does not match the requirements')
    }

    const paid = accepted.amount
    const paymentId = `x402:${settings.chainId}:${authorization.from.toLowerCase()}:${authorization.nonce}`
    const claim = await stores.ledger.claim(paymentId, context.now())
    if (!claim.claimed) {
      if (claim.entry.status === 'done' && claim.entry.data !== null) return finished(claim.entry.data)
      throw conflict('payment_in_progress', 'This payment is already being processed', { paymentId })
    }

    if (claim.resumed !== null) {
      const record = recordSchema.safeParse(claim.resumed)
      if (!record.success) {
        await stores.ledger.release(paymentId)
        logger.error('a settled payment has an unreadable record', { paymentId })
        throw new ServiceError(500, 'internal', 'Internal error', { details: { paymentId } })
      }
      if (!sameRequest(record.data.request, requestToJson(input))) {
        await stores.ledger.release(paymentId)
        throw conflict('payment_already_used', 'This payment was made for a different request', { paymentId })
      }
      return issue(paymentId, record.data)
    }

    // Nothing irreversible happens before settlement: any refusal up to there hands the payment back unused.
    let signed
    let requirements: PaymentRequirements
    let refusal: string | undefined
    try {
      signed = await quotes.quote(input, paid)
      requirements = await requirementsFor(paid)
      const verification = await verify(payload, requirements)
      if (verification.isValid) {
        await ensureAllowance(paid)
        await assertSellable(signed.quote, signed.quoteSig)
      } else {
        refusal = `The payment is not valid: ${printable(verification.invalidReason)}`
      }
    } catch (error) {
      await stores.ledger.release(paymentId)
      if (error instanceof ServiceError && error.code === 'price_changed') {
        return paymentRequired(request, await quotes.offer(input), 'The price has changed')
      }
      throw relayFailure(error, core.abis)
    }
    if (refusal !== undefined) {
      await stores.ledger.release(paymentId)
      return paymentRequired(request, await quotes.offer(input), refusal)
    }

    // A settlement that fails to answer may still have moved the money, so the claim is kept: the payment
    // can then neither be settled again nor silently dropped, and is left for reconciliation.
    let settlement: SettleResponse
    try {
      settlement = await facilitator.settle(payload, requirements)
    } catch (error) {
      logger.error('the outcome of a payment settlement is unknown', { paymentId, error })
      throw new ServiceError(502, 'settlement_unknown', 'The payment could not be confirmed; do not pay again', {
        details: { paymentId },
      })
    }
    if (!settlement.success) {
      await stores.ledger.release(paymentId)
      const reason = `The payment did not settle: ${printable(settlement.errorReason)}`
      return paymentRequired(request, await quotes.offer(input), reason)
    }

    const record: PaymentRecord = {
      request: requestToJson(input),
      settlement: {
        transaction: settlement.transaction,
        network: settlement.network,
        payer: settlement.payer ?? authorization.from,
        amount: paid.toString(),
      },
      quote: signed.quote,
      quoteSig: signed.quoteSig,
      digest: signed.digest,
    }
    let recorded = true
    try {
      await stores.ledger.checkpoint(paymentId, recordToJson(record), context.now())
    } catch (error) {
      recorded = false
      logger.error('a settled payment could not be recorded', { paymentId, payment: record.settlement, error })
    }
    return issue(paymentId, record, recorded)
  }
}
