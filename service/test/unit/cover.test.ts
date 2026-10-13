import { coverBookAbi, testDollarAbi } from '@cover/core/abi'
import { decodePaymentRequiredHeader, decodePaymentResponseHeader, encodePaymentSignatureHeader } from '@x402/core/http'
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeErrorResult,
  encodeEventTopics,
  maxUint256,
  type Hex,
} from 'viem'
import { generatePrivateKey, privateKeyToAccount, privateKeyToAddress } from 'viem/accounts'
import { beforeEach, describe, expect, it } from 'vitest'
import type { Handler } from '../../src/http/respond'
import { selectorOf } from '../../src/relayer/allowlist'
import { InclusionUnknown, SimulationReverted } from '../../src/relayer/errors'
import type { Quote } from '../../src/types'
import { PAYMENT_RESPONSE_HEADER, PAYMENT_SIGNATURE_HEADER, coverHandler } from '../../src/x402/cover'
import { T0, fakeMarket, fakePolicy } from '../helpers/fakes'
import { body, harness, post, type Harness } from '../helpers/harness'
import { FakeFacilitator, nonceOf, payFor, signPayment } from '../helpers/x402'

const agent = privateKeyToAccount(generatePrivateKey())
const holder = privateKeyToAddress(generatePrivateKey())
const order = { lat: 52.2297, lon: 21.0122, start: T0 + 120, end: T0 + 720, rate: '1000', holder }
const enabled = { X402_ENABLED: 'true' }

describe('POST /v1/cover', () => {
  let h: Harness
  let facilitator: FakeFacilitator
  let handler: Handler

  function start(env: Record<string, string | undefined> = enabled) {
    facilitator = new FakeFacilitator()
    h = harness(env, { facilitator })
    handler = h.guarded(coverHandler(h.context))
    h.rpc.onSend = () => {
      h.rpc.chainNonce++
      return h.rpc.receipt({ logs: boughtLogs() })
    }
  }

  const buys = () => h.rpc.simulated.filter((call) => call.data.startsWith(selectorOf('buy')))
  const boughtQuote = (index = -1) =>
    decodeFunctionData({ abi: coverBookAbi, data: buys().at(index)!.data }).args![0] as Quote
  const sentCount = () => h.rpc.sent.length

  function boughtLogs() {
    const call = buys().at(-1)
    if (!call) return []
    const quote = decodeFunctionData({ abi: coverBookAbi, data: call.data }).args![0] as Quote
    return [
      {
        address: h.settings.contracts.coverBook,
        topics: encodeEventTopics({
          abi: coverBookAbi,
          eventName: 'PolicyBought',
          args: { id: 7n, holder: quote.holder, key: quote.key },
        }) as Hex[],
        data: encodeAbiParameters(
          [{ type: 'uint64' }, { type: 'uint64' }, { type: 'uint128' }, { type: 'uint128' }, { type: 'uint256' }],
          [quote.start, quote.end, quote.ratePerSecond, quote.premium, 600_000n],
        ),
      },
    ]
  }

  const request = (payment?: string, payload: unknown = order, headers: Record<string, string> = {}) =>
    handler(post('/v1/cover', payload, { ...(payment ? { [PAYMENT_SIGNATURE_HEADER]: payment } : {}), ...headers }))

  async function paid(payload: unknown = order): Promise<{ payment: string; response: Response }> {
    const payment = await payFor(await request(undefined, payload), agent)
    return { payment, response: await request(payment, payload) }
  }

  beforeEach(() => start())

  it('is closed unless enabled', async () => {
    start({})

    const response = await request()

    expect(response.status).toBe(503)
    expect((await body(response)).error.code).toBe('not_configured')
  })

  describe('without a payment', () => {
    it('answers 402 with the price and how to pay it', async () => {
      const response = await request()
      const result = await body(response)
      const required = decodePaymentRequiredHeader(response.headers.get('payment-required')!)

      expect(response.status).toBe(402)
      expect(result.premium).toBe('50000')
      expect(result.maxPayout).toBe('600000')
      expect(required.x402Version).toBe(2)
      expect(required.accepts).toEqual([
        {
          scheme: 'exact',
          network: 'eip155:10143',
          asset: h.settings.contracts.token,
          amount: '50000',
          payTo: h.relayerAccount.address,
          maxTimeoutSeconds: 120,
          extra: { name: 'Test Dollar', version: '1' },
        },
      ])
      expect(facilitator.verified).toHaveLength(0)
      expect(sentCount()).toBe(0)
    })

    it('refuses what it would not sell instead of asking for money', async () => {
      h.reader.marketState = fakeMarket({ heartbeat: 0 })
      const stale = await request()
      h.reader.marketState = fakeMarket({ lockedExposure: 800_000_000n })
      const full = await request()

      expect(stale.status).toBe(503)
      expect((await body(stale)).error.code).toBe('oracle_stale')
      expect(full.status).toBe(409)
      expect((await body(full)).error.code).toBe('capacity_exhausted')
    })

    it('validates the order', async () => {
      expect((await request(undefined, { ...order, rate: '0' })).status).toBe(400)
      expect((await request(undefined, { ...order, premium: '1' })).status).toBe(400)
      expect((await request(undefined, 'nope')).status).toBe(400)
    })
  })

  describe('with a payment', () => {
    it('settles the payment, then buys the policy for the holder', async () => {
      const steps: string[] = []
      facilitator.onSettle = async (_payload, requirements) => {
        steps.push('settle')
        return {
          success: true,
          transaction: `0x${'ab'.repeat(32)}`,
          network: requirements.network,
          payer: agent.address,
        }
      }
      const send = h.rpc.onSend!
      h.rpc.onSend = (serialized, attempt) => {
        steps.push('send')
        return send(serialized, attempt)
      }
      h.reader.allowances.set(`${h.relayerAccount.address}:${h.settings.contracts.coverBook}`, maxUint256)

      const { response } = await paid()
      const result = await body(response)

      expect(response.status).toBe(200)
      expect(steps).toEqual(['settle', 'send'])
      expect(result).toMatchObject({ policyId: '7', holder })
      expect(result.payment).toMatchObject({ success: true, payer: agent.address, amount: '50000' })
      expect(decodePaymentResponseHeader(response.headers.get(PAYMENT_RESPONSE_HEADER)!)).toMatchObject({
        success: true,
        transaction: `0x${'ab'.repeat(32)}`,
        network: 'eip155:10143',
      })

      expect(facilitator.verified).toHaveLength(1)
      expect(facilitator.verified[0]!.requirements).toMatchObject({
        amount: '50000',
        payTo: h.relayerAccount.address,
        asset: h.settings.contracts.token,
      })
      const quote = boughtQuote()
      expect(quote.holder).toBe(holder)
      expect(quote.premium).toBe(50_000n)
      expect(buys().at(-1)!.to).toBe(h.settings.contracts.coverBook)
    })

    it('grants the book its allowance once, and only when it is missing', async () => {
      await paid()
      await paid({ ...order, start: T0 + 180, end: T0 + 780 })

      const approvals = h.rpc.simulated.filter((call) => call.data.startsWith(selectorOf('approve')))
      expect(approvals).toHaveLength(1)
      expect(approvals[0]!.to).toBe(h.settings.contracts.token)
      expect(decodeFunctionData({ abi: testDollarAbi, data: approvals[0]!.data }).args).toEqual([
        h.settings.contracts.coverBook,
        maxUint256,
      ])
    })

    it('does not buy when the payment is not valid', async () => {
      facilitator.verification = { isValid: false, invalidReason: 'insufficient_funds' }

      const { response } = await paid()

      expect(response.status).toBe(402)
      expect((await body(response)).error.message).toContain('insufficient_funds')
      expect(facilitator.settled).toHaveLength(0)
      expect(sentCount()).toBe(0)
    })

    it('does not buy when the payment does not settle', async () => {
      facilitator.onSettle = async (_payload, requirements) => ({
        success: false,
        errorReason: 'transaction_failed',
        transaction: '',
        network: requirements.network,
      })

      const { response } = await paid()

      expect(response.status).toBe(402)
      expect(h.rpc.sent.filter((tx) => tx.includes(selectorOf('buy').slice(2)))).toHaveLength(0)
    })

    it('takes no money for cover the book would refuse', async () => {
      h.reader.allowances.set(`${h.relayerAccount.address}:${h.settings.contracts.coverBook}`, maxUint256)
      h.rpc.revertWith = encodeErrorResult({ abi: coverBookAbi, errorName: 'OracleStale' })

      const { response } = await paid()
      const { error } = await body(response)

      expect(response.status).toBe(409)
      expect(error.details.reason).toBe('OracleStale')
      expect(facilitator.settled).toHaveLength(0)
      expect(sentCount()).toBe(0)
    })

    it('goes ahead when the only obstacle is the balance the payment will bring', async () => {
      h.reader.allowances.set(`${h.relayerAccount.address}:${h.settings.contracts.coverBook}`, maxUint256)
      let simulations = 0
      const simulate = h.rpc.simulate
      h.rpc.simulate = async (call) => {
        if (++simulations === 1) {
          throw new SimulationReverted(
            encodeErrorResult({
              abi: testDollarAbi,
              errorName: 'ERC20InsufficientBalance',
              args: [h.relayerAccount.address, 0n, 50_000n],
            }),
          )
        }
        return simulate(call)
      }

      const { response } = await paid()

      expect(response.status).toBe(200)
      expect(facilitator.settled).toHaveLength(1)
    })

    it('accepts an overpayment and passes all of it on as premium', async () => {
      const first = await request()
      const required = decodePaymentRequiredHeader(first.headers.get('payment-required')!)
      required.accepts[0]!.amount = '80000'
      const payment = encodePaymentSignatureHeader(await signPayment(required, agent))

      const response = await request(payment)

      expect(response.status).toBe(200)
      expect(boughtQuote().premium).toBe(80_000n)
      expect(facilitator.settled[0]!.requirements.amount).toBe('80000')
    })

    it('asks again when the price rose after the payment was signed', async () => {
      const payment = await payFor(await request(), agent)
      h.pricing.premium = 90_000n

      const response = await request(payment)
      const required = decodePaymentRequiredHeader(response.headers.get('payment-required')!)

      expect(response.status).toBe(402)
      expect(required.accepts[0]!.amount).toBe('90000')
      expect(facilitator.verified).toHaveLength(0)
      expect(facilitator.settled).toHaveLength(0)
    })

    it('rejects a payment made out to someone else, for another token or network', async () => {
      const first = await request()
      const required = decodePaymentRequiredHeader(first.headers.get('payment-required')!)
      const variants = [
        { payTo: privateKeyToAddress(generatePrivateKey()) },
        { asset: privateKeyToAddress(generatePrivateKey()) },
        { network: 'eip155:143' as const },
      ]

      for (const variant of variants) {
        const altered = { ...required, accepts: [{ ...required.accepts[0]!, ...variant }] }
        const payment = encodePaymentSignatureHeader(await signPayment(altered, agent))
        expect((await request(payment)).status).toBe(402)
      }
      expect(facilitator.verified).toHaveLength(0)
      expect(sentCount()).toBe(0)
    })

    it('rejects a header that is not a payment', async () => {
      const response = await request('not-base64-json')

      expect(response.status).toBe(400)
      expect((await body(response)).error.code).toBe('invalid_payment')
    })

    it('reports an unreachable facilitator and leaves the payment usable', async () => {
      const payment = await payFor(await request(), agent)
      const verify = facilitator.verify.bind(facilitator)
      facilitator.verify = async () => {
        throw new Error('connect ECONNREFUSED facilitator.internal.example')
      }

      const failed = await request(payment)
      const text = await failed.text()
      facilitator.verify = verify
      const retried = await request(payment)

      expect(failed.status).toBe(502)
      expect(JSON.parse(text).error.code).toBe('facilitator_unavailable')
      expect(text).not.toContain('internal.example')
      expect(retried.status).toBe(200)
    })
  })

  describe('one payment, one policy', () => {
    it('answers a repeated payment with the first result', async () => {
      const { payment, response } = await paid()
      const first = await body(response)

      const again = await request(payment)

      expect(again.status).toBe(200)
      expect(await body(again)).toEqual(first)
      expect(again.headers.get(PAYMENT_RESPONSE_HEADER)).toBe(response.headers.get(PAYMENT_RESPONSE_HEADER))
      expect(facilitator.settled).toHaveLength(1)
      expect(h.rpc.sent.filter((tx) => tx.includes(selectorOf('buy').slice(2)))).toHaveLength(1)
    })

    it('settles and buys once when the same payment arrives several times at once', async () => {
      const payment = await payFor(await request(), agent)
      facilitator.delayMs = 5
      h.rpc.delayMs = 5

      const responses = await Promise.all([request(payment), request(payment), request(payment), request(payment)])

      expect(responses.map((response) => response.status).sort()).toEqual([200, 409, 409, 409])
      expect(facilitator.settled).toHaveLength(1)
      expect(h.rpc.sent.filter((tx) => tx.includes(selectorOf('buy').slice(2)))).toHaveLength(1)
    })

    it('never settles again after a settlement that did not answer', async () => {
      const payment = await payFor(await request(), agent)
      facilitator.onSettle = async () => {
        throw new Error('socket hang up')
      }

      const first = await request(payment)
      facilitator.onSettle = undefined
      const second = await request(payment)

      expect(first.status).toBe(502)
      expect((await body(first)).error.code).toBe('settlement_unknown')
      expect(second.status).toBe(409)
      expect((await body(second)).error.code).toBe('payment_in_progress')
      expect(facilitator.settled).toHaveLength(1)
      expect(h.rpc.sent.filter((tx) => tx.includes(selectorOf('buy').slice(2)))).toHaveLength(0)
    })

    it('finishes a paid purchase on retry without charging twice', async () => {
      h.reader.allowances.set(`${h.relayerAccount.address}:${h.settings.contracts.coverBook}`, maxUint256)
      const payment = await payFor(await request(), agent)
      let simulations = 0
      const simulate = h.rpc.simulate
      h.rpc.simulate = async (call) => {
        if (++simulations === 2) {
          throw new SimulationReverted(encodeErrorResult({ abi: coverBookAbi, errorName: 'OracleStale' }))
        }
        return simulate(call)
      }

      const first = await request(payment)
      const { error } = await body(first)
      const retried = await request(payment)

      expect(first.status).toBe(502)
      expect(error.code).toBe('cover_pending')
      expect(error.details.paymentId).toMatch(/^x402:10143:0x[0-9a-f]{40}:0x[0-9a-f]{64}$/)
      expect(error.details.payment.transaction).toMatch(/^0x/)
      expect(error.details.reason).toBe('OracleStale')
      expect(retried.status).toBe(200)
      expect((await body(retried)).policyId).toBe('7')
      expect(facilitator.settled).toHaveLength(1)
      expect(facilitator.verified).toHaveLength(1)
    })

    it('reuses the quote of the first attempt, so the book rejects a duplicate', async () => {
      h.reader.allowances.set(`${h.relayerAccount.address}:${h.settings.contracts.coverBook}`, maxUint256)
      const payment = await payFor(await request(), agent)
      const send = h.rpc.onSend!
      h.rpc.onSend = () => {
        throw new InclusionUnknown(`0x${'cd'.repeat(32)}`)
      }

      const first = await request(payment)
      const firstQuote = boughtQuote()
      h.rpc.onSend = send
      const retried = await request(payment)

      expect(first.status).toBe(502)
      expect((await body(first)).error.details.cause).toBe('relay_pending')
      expect(retried.status).toBe(200)
      expect(boughtQuote()).toEqual(firstQuote)
    })

    it('recognises a purchase that landed after its outcome was unknown', async () => {
      h.reader.allowances.set(`${h.relayerAccount.address}:${h.settings.contracts.coverBook}`, maxUint256)
      const payment = await payFor(await request(), agent)
      h.rpc.onSend = () => {
        throw new InclusionUnknown(`0x${'cd'.repeat(32)}`)
      }
      await request(payment)
      const quote = boughtQuote()
      const digest = h.context.core.signing.quoteDigest(quote, h.settings.chainId, h.settings.contracts.coverBook)
      h.reader.usedQuotes.add(digest)
      h.reader.policyRows.set(
        1n,
        fakePolicy(1n, {
          holder: quote.holder,
          key: quote.key,
          start: Number(quote.start),
          end: Number(quote.end),
          premium: quote.premium,
        }),
      )
      const sentBefore = sentCount()

      const retried = await request(payment)

      expect(retried.status).toBe(200)
      expect(await body(retried)).toMatchObject({ policyId: '1', transactionHash: null })
      expect(sentCount()).toBe(sentBefore)
      expect(facilitator.settled).toHaveLength(1)
    })

    it('issues a fresh quote for the amount paid when the first one has expired', async () => {
      h.reader.allowances.set(`${h.relayerAccount.address}:${h.settings.contracts.coverBook}`, maxUint256)
      const later = { ...order, start: T0 + 1_800, end: T0 + 2_400 }
      const payment = await payFor(await request(undefined, later), agent)
      let simulations = 0
      const simulate = h.rpc.simulate
      h.rpc.simulate = async (call) => {
        if (++simulations === 2) {
          throw new SimulationReverted(encodeErrorResult({ abi: coverBookAbi, errorName: 'OracleStale' }))
        }
        return simulate(call)
      }
      await request(payment, later)
      const firstQuote = boughtQuote()
      h.clock.time = T0 + 300
      h.reader.marketState = fakeMarket({ head: { number: 2n, timestamp: T0 + 300 }, heartbeat: T0 + 240 })
      h.pricing.premium = 10_000n

      const retried = await request(payment, later)

      expect(retried.status).toBe(200)
      const secondQuote = boughtQuote()
      expect(secondQuote.salt).not.toBe(firstQuote.salt)
      expect(secondQuote.premium).toBe(50_000n)
      expect(Number(secondQuote.expiry)).toBeGreaterThan(T0 + 300)
      expect(facilitator.settled).toHaveLength(1)
    })

    it('does not let a settled payment be spent on a different order', async () => {
      h.reader.allowances.set(`${h.relayerAccount.address}:${h.settings.contracts.coverBook}`, maxUint256)
      const payment = await payFor(await request(), agent)
      let simulations = 0
      const simulate = h.rpc.simulate
      h.rpc.simulate = async (call) => {
        if (++simulations === 2) {
          throw new SimulationReverted(encodeErrorResult({ abi: coverBookAbi, errorName: 'OracleStale' }))
        }
        return simulate(call)
      }
      await request(payment)

      const other = await request(payment, { ...order, rate: '9000' })
      const original = await request(payment)

      expect(other.status).toBe(409)
      expect((await body(other)).error.code).toBe('payment_already_used')
      expect(original.status).toBe(200)
      expect(boughtQuote().ratePerSecond).toBe(1000n)
    })

    it('treats payments with different nonces as different payments', async () => {
      const first = await request()
      const required = decodePaymentRequiredHeader(first.headers.get('payment-required')!)
      const one = await signPayment(required, agent)
      const two = await signPayment(required, agent)

      expect(nonceOf(one)).not.toBe(nonceOf(two))
      expect((await request(encodePaymentSignatureHeader(one))).status).toBe(200)
      expect((await request(encodePaymentSignatureHeader(two))).status).toBe(200)
      expect(facilitator.settled).toHaveLength(2)
    })
  })

  describe('when the ledger cannot be written', () => {
    it('keeps hold of a settled payment whose purchase then fails', async () => {
      h.reader.allowances.set(`${h.relayerAccount.address}:${h.settings.contracts.coverBook}`, maxUint256)
      const payment = await payFor(await request(), agent)
      h.stores.ledger.checkpoint = async () => {
        throw new Error('database unavailable')
      }
      let simulations = 0
      const simulate = h.rpc.simulate
      h.rpc.simulate = async (call) => {
        if (++simulations === 2) {
          throw new SimulationReverted(encodeErrorResult({ abi: coverBookAbi, errorName: 'OracleStale' }))
        }
        return simulate(call)
      }

      const first = await request(payment)
      const second = await request(payment)

      expect((await body(first)).error.code).toBe('cover_pending')
      expect(second.status).toBe(409)
      expect((await body(second)).error.code).toBe('payment_in_progress')
      expect(facilitator.settled).toHaveLength(1)
      expect(h.logger.entries.some((entry) => entry.message === 'a settled payment could not be recorded')).toBe(true)
    })

    it('still hands over a policy that was bought', async () => {
      const payment = await payFor(await request(), agent)
      h.stores.ledger.save = async () => {
        throw new Error('database unavailable')
      }

      const response = await request(payment)

      expect(response.status).toBe(200)
      expect((await body(response)).policyId).toBe('7')
    })
  })

  it('is limited per IP', async () => {
    start({ ...enabled, RATE_COVER_PER_IP: '2' })

    expect((await request()).status).toBe(402)
    expect((await request()).status).toBe(402)
    expect((await request()).status).toBe(429)
  })
})
