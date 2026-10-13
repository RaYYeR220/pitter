import { coverBookAbi, coverPoolAbi } from '@cover/core/abi'
import { contractRefusal } from '@cover/core/refusals'
import {
  HttpRequestError,
  decodeFunctionData,
  encodeAbiParameters,
  encodeErrorResult,
  encodeEventTopics,
  parseAbi,
  parseEther,
  type Hex,
} from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { beforeEach, describe, expect, it } from 'vitest'
import { quoteToJson, type SignedQuote } from '../../src/quote/engine'
import { relayHandlers } from '../../src/relay/handlers'
import { InclusionUnknown } from '../../src/relayer/errors'
import { MAX_RELAY_GAS, settleManyGas } from '../../src/relayer/gas'
import { selectorOf } from '../../src/relayer/allowlist'
import type { RelayLog } from '../../src/relayer/rpc'
import { T0, fakePolicy } from '../helpers/fakes'
import { body, harness, post, type Harness } from '../helpers/harness'
import { randomNonce, signAuthorization } from '../helpers/signing'

const holder = privateKeyToAccount(generatePrivateKey())
const stranger = privateKeyToAccount(generatePrivateKey())
const START = BigInt(T0 + 120)
const END = START + 600n
const VALID_BEFORE = BigInt(T0 + 600)

function policyBoughtLog(h: Harness, id: bigint, signed: SignedQuote): RelayLog {
  const { quote } = signed
  return {
    address: h.settings.contracts.coverBook,
    topics: encodeEventTopics({
      abi: coverBookAbi,
      eventName: 'PolicyBought',
      args: { id, holder: quote.holder, key: quote.key },
    }) as Hex[],
    data: encodeAbiParameters(
      [{ type: 'uint64' }, { type: 'uint64' }, { type: 'uint128' }, { type: 'uint128' }, { type: 'uint256' }],
      [quote.start, quote.end, quote.ratePerSecond, quote.premium, signed.maxPayout],
    ),
  }
}

function policySettledLog(h: Harness, id: bigint, paid: bigint, closed: boolean): RelayLog {
  return {
    address: h.settings.contracts.coverBook,
    topics: encodeEventTopics({
      abi: coverBookAbi,
      eventName: 'PolicySettled',
      args: { id, holder: holder.address },
    }) as Hex[],
    data: encodeAbiParameters(
      [{ type: 'uint256' }, { type: 'uint64' }, { type: 'bool' }],
      [paid, BigInt(T0 + 600), closed],
    ),
  }
}

describe('POST /relay/buy', () => {
  let h: Harness
  let relay: ReturnType<typeof relayHandlers>
  let signed: SignedQuote

  async function freshQuote(who = holder.address) {
    return h.context.quotes.quote({ lat: 52.2297, lon: 21.0122, start: START, end: END, rate: 1000n, holder: who })
  }

  async function buyBody(quote = signed, signer = holder, overrides: Record<string, unknown> = {}) {
    const authorization = await signAuthorization(signer, 'ReceiveWithAuthorization', h.reader.domain, {
      to: h.settings.contracts.coverBook,
      value: quote.quote.premium,
      nonce: quote.digest,
      validBefore: VALID_BEFORE,
    })
    return { quote: quoteToJson(quote.quote), quoteSig: quote.quoteSig, ...authorization, ...overrides }
  }

  const buy = (payload: unknown, headers: Record<string, string> = {}) =>
    h.guarded(relay.buy)(post('/relay/buy', payload, headers))

  beforeEach(async () => {
    h = harness()
    relay = relayHandlers(h.context)
    signed = await freshQuote()
    h.rpc.logs = [policyBoughtLog(h, 1n, signed)]
  })

  it('submits the purchase the holder signed for and returns the policy id', async () => {
    const response = await buy(await buyBody())
    const result = await body(response)

    expect(response.status).toBe(200)
    expect(result).toMatchObject({ policyId: '1', holder: holder.address, digest: signed.digest })
    expect(result.transactionHash).toMatch(/^0x[0-9a-f]{64}$/)

    expect(h.rpc.simulated).toHaveLength(1)
    const call = h.rpc.simulated[0]!
    expect(call.to).toBe(h.settings.contracts.coverBook)
    expect(call.from).toBe(h.relayerAccount.address)
    expect(call.data.slice(0, 10)).toBe(selectorOf('buyWithAuthorization'))
    const decoded = decodeFunctionData({ abi: coverBookAbi, data: call.data })
    expect(decoded.functionName).toBe('buyWithAuthorization')
    expect(decoded.args?.[0]).toEqual(signed.quote)
    expect(decoded.args?.[1]).toBe(signed.quoteSig)
  })

  it('answers a replayed body with the original result without sending again', async () => {
    const payload = await buyBody()

    const first = await body(await buy(payload))
    const replay = await buy(payload)

    expect(replay.status).toBe(200)
    expect(await body(replay)).toEqual(first)
    expect(h.rpc.sent).toHaveLength(1)
  })

  it('sends one transaction for identical bodies that arrive together', async () => {
    const payload = await buyBody()
    h.rpc.delayMs = 5

    const responses = await Promise.all([buy(payload), buy(payload), buy(payload)])

    expect(h.rpc.sent).toHaveLength(1)
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409, 409])
  })

  it("refuses one holder's quote paid with another holder's authorization", async () => {
    const response = await buy(await buyBody(signed, stranger))

    expect(response.status).toBe(400)
    expect((await body(response)).error.code).toBe('authorization_invalid')
    expect(h.rpc.simulated).toHaveLength(0)
    expect(h.rpc.sent).toHaveLength(0)
  })

  it("refuses another holder's quote submitted with one's own authorization for it", async () => {
    const theirs = await freshQuote(stranger.address)

    const response = await buy(await buyBody(theirs, holder))

    expect(response.status).toBe(400)
    expect((await body(response)).error.code).toBe('authorization_invalid')
  })

  it('refuses an authorization for a different amount, nonce or payee', async () => {
    const terms = {
      to: h.settings.contracts.coverBook,
      value: signed.quote.premium,
      nonce: signed.digest,
      validBefore: VALID_BEFORE,
    }
    const variants = [
      { ...terms, value: signed.quote.premium - 1n },
      { ...terms, nonce: randomNonce() },
      { ...terms, to: h.settings.contracts.coverPool },
    ]

    for (const variant of variants) {
      const authorization = await signAuthorization(holder, 'ReceiveWithAuthorization', h.reader.domain, variant)
      const response = await buy({ quote: quoteToJson(signed.quote), quoteSig: signed.quoteSig, ...authorization })
      expect((await body(response)).error.code).toBe('authorization_invalid')
    }
    expect(h.rpc.sent).toHaveLength(0)
  })

  it('refuses a transfer authorization presented as a purchase', async () => {
    const authorization = await signAuthorization(holder, 'TransferWithAuthorization', h.reader.domain, {
      to: h.settings.contracts.coverBook,
      value: signed.quote.premium,
      nonce: signed.digest,
      validBefore: VALID_BEFORE,
    })

    const response = await buy({ quote: quoteToJson(signed.quote), quoteSig: signed.quoteSig, ...authorization })

    expect((await body(response)).error.code).toBe('authorization_invalid')
  })

  it('refuses a quote the underwriter did not sign', async () => {
    const forged = await stranger.sign({ hash: signed.digest })

    const response = await buy(await buyBody({ ...signed, quoteSig: forged }))

    expect(response.status).toBe(400)
    expect((await body(response)).error.code).toBe('quote_signature_invalid')
    expect(h.rpc.simulated).toHaveLength(0)
  })

  it('refuses a quote whose terms were changed after signing', async () => {
    const cheaper = { ...signed, quote: { ...signed.quote, premium: 1n } }
    const digest = h.context.core.signing.quoteDigest(cheaper.quote, h.settings.chainId, h.settings.contracts.coverBook)

    const response = await buy(await buyBody({ ...cheaper, digest }))

    expect((await body(response)).error.code).toBe('quote_signature_invalid')
  })

  it('refuses an expired quote', async () => {
    const payload = await buyBody()
    h.clock.time = Number(signed.quote.expiry) + 1

    const response = await buy(payload)

    expect(response.status).toBe(409)
    expect((await body(response)).error.code).toBe('quote_expired')
  })

  it('refuses an authorization outside its validity window', async () => {
    const terms = { to: h.settings.contracts.coverBook, value: signed.quote.premium, nonce: signed.digest }
    const expired = await signAuthorization(holder, 'ReceiveWithAuthorization', h.reader.domain, {
      ...terms,
      validBefore: BigInt(T0),
    })
    const early = await signAuthorization(holder, 'ReceiveWithAuthorization', h.reader.domain, {
      ...terms,
      validAfter: BigInt(T0 + 30),
      validBefore: VALID_BEFORE,
    })
    const base = { quote: quoteToJson(signed.quote), quoteSig: signed.quoteSig }

    expect((await body(await buy({ ...base, ...expired }))).error.code).toBe('authorization_expired')
    expect((await body(await buy({ ...base, ...early }))).error.code).toBe('authorization_not_yet_valid')
  })

  it('does not pay for a purchase that would revert, and names the reason', async () => {
    const payload = await buyBody()
    h.rpc.revertWith = encodeErrorResult({ abi: coverPoolAbi, errorName: 'GlobalCapExceeded' })

    const response = await buy(payload)
    const { error } = await body(response)

    expect(response.status).toBe(409)
    expect(error.code).toBe('would_revert')
    expect(error.details.reason).toBe('GlobalCapExceeded')
    expect(h.rpc.sent).toHaveLength(0)

    h.rpc.revertWith = null
    expect((await buy(payload)).status).toBe(200)
    expect(h.rpc.sent).toHaveLength(1)
  })

  it('answers the refusals a buyer can act on under codes of their own', async () => {
    const payload = await buyBody()
    const cases = [
      ['AreaNotServed', 422, 'area_not_served'],
      ['PremiumTooSmall', 422, 'premium_too_small'],
      ['WindowTooFar', 422, 'window_too_far'],
    ] as const
    for (const [errorName, status, code] of cases) {
      h.rpc.revertWith = encodeErrorResult({ abi: coverBookAbi, errorName })

      const response = await buy(payload)
      const { error } = await body(response)

      expect(response.status, errorName).toBe(status)
      expect(error.code, errorName).toBe(code)
      // The same code the shared package gives the error, and the contract's name for it.
      expect(error.code, errorName).toBe(contractRefusal(errorName)?.code)
      expect(error.details.reason, errorName).toBe(errorName)
    }
    expect(h.rpc.sent).toHaveLength(0)
  })

  it('reports a used quote as a refusal, not as a payment', async () => {
    h.rpc.revertWith = encodeErrorResult({ abi: coverBookAbi, errorName: 'QuoteUsed' })

    const { error } = await body(await buy(await buyBody()))

    expect(error.details.reason).toBe('QuoteUsed')
    expect(h.rpc.sent).toHaveLength(0)
  })

  it('passes on a revert string with anything unusual stripped', async () => {
    h.rpc.revertWith = encodeErrorResult({
      abi: parseAbi(['error Error(string)']),
      errorName: 'Error',
      args: ['FiatTokenV2: invalid signature <script>'],
    })

    const { error } = await body(await buy(await buyBody()))

    expect(error.details.reason).toBe('FiatTokenV2: invalid signature script')
  })

  it('reports unknown revert data without echoing it', async () => {
    h.rpc.revertWith = '0xdeadbeef'

    const { error } = await body(await buy(await buyBody()))

    expect(error.details.reason).toBe('unknown')
  })

  it('reports a transaction that failed after it was sent', async () => {
    h.rpc.onSend = () => h.rpc.receipt({ status: 'reverted' })

    const response = await buy(await buyBody())
    const { error } = await body(response)

    expect(response.status).toBe(409)
    expect(error.code).toBe('reverted')
    expect(error.details.transactionHash).toMatch(/^0x/)
  })

  it('says so when the outcome is not known yet', async () => {
    const hash = `0x${'ab'.repeat(32)}` as Hex
    h.rpc.onSend = () => {
      throw new InclusionUnknown(hash)
    }

    const response = await buy(await buyBody())
    const { error } = await body(response)

    expect(response.status).toBe(504)
    expect(error.code).toBe('relay_pending')
    expect(error.details.transactionHash).toBe(hash)
  })

  it('tells the client when the relayer is out of funds', async () => {
    h.rpc.funds = parseEther('0.1')

    const response = await buy(await buyBody())

    expect(response.status).toBe(503)
    expect((await body(response)).error.code).toBe('relayer_unfunded')
  })

  it('never shows the node address or key when the node fails', async () => {
    h.rpc.simulate = async () => {
      throw new HttpRequestError({ url: 'https://rpc.internal.example/v1/SECRET-API-KEY', status: 500 })
    }

    const response = await buy(await buyBody())
    const text = await response.text()

    expect(response.status).toBe(502)
    expect(JSON.parse(text).error.code).toBe('rpc_unavailable')
    expect(text).not.toContain('SECRET-API-KEY')
    expect(text).not.toContain('internal.example')
  })

  it('hides unexpected failures behind a reference', async () => {
    h.rpc.simulate = async () => {
      throw new Error(`boom with key ${h.secrets.relayerKey}`)
    }

    const response = await buy(await buyBody())
    const text = await response.text()

    expect(response.status).toBe(500)
    expect(JSON.parse(text).error).toMatchObject({ code: 'internal', message: 'Internal error' })
    expect(text).not.toContain(h.secrets.relayerKey.slice(2))
    expect(text).not.toContain('boom')
    expect(h.logger.entries.at(-1)?.level).toBe('error')
  })

  describe('validation', () => {
    it('rejects a body that is not JSON', async () => {
      const response = await buy('not json')

      expect(response.status).toBe(400)
      expect((await body(response)).error.code).toBe('invalid_json')
    })

    it('rejects an oversized body before reading it all', async () => {
      const response = await buy(JSON.stringify({ padding: 'x'.repeat(40_000) }))

      expect(response.status).toBe(413)
    })

    it('rejects unknown fields and missing fields', async () => {
      const payload = await buyBody()
      const { quoteSig: _dropped, ...missing } = payload

      expect((await buy({ ...payload, gas: '9000000' })).status).toBe(400)
      expect((await buy(missing)).status).toBe(400)
      expect(h.rpc.simulated).toHaveLength(0)
    })

    it('lists what is wrong without echoing the body', async () => {
      const payload = await buyBody(signed, holder, { v: 99 })

      const { error } = await body(await buy(payload))

      expect(error.code).toBe('invalid_request')
      expect(error.details.issues[0].path).toBe('v')
    })

    it('rejects other methods', async () => {
      const response = await h.guarded(relay.buy)(new Request('https://cover.test/relay/buy'))

      expect(response.status).toBe(405)
    })
  })

  describe('rate limits', () => {
    it('limits relays per holder', async () => {
      h = harness({ RATE_RELAY_PER_ADDRESS: '2', RATE_RELAY_PER_IP: '100' })
      relay = relayHandlers(h.context)

      const statuses: number[] = []
      for (let i = 0; i < 3; i++) {
        signed = await freshQuote()
        h.rpc.logs = [policyBoughtLog(h, BigInt(i + 1), signed)]
        statuses.push((await buy(await buyBody())).status)
      }

      expect(statuses).toEqual([200, 200, 429])
      expect(h.rpc.sent).toHaveLength(2)
    })

    it("does not let unsigned requests use up a holder's allowance", async () => {
      h = harness({ RATE_RELAY_PER_ADDRESS: '1', RATE_RELAY_PER_IP: '100' })
      relay = relayHandlers(h.context)
      signed = await freshQuote()
      h.rpc.logs = [policyBoughtLog(h, 1n, signed)]

      for (let i = 0; i < 5; i++) expect((await buy(await buyBody(signed, stranger))).status).toBe(400)

      expect((await buy(await buyBody())).status).toBe(200)
    })

    it('limits relays per IP before looking at the body', async () => {
      h = harness({ RATE_RELAY_PER_IP: '2' })
      relay = relayHandlers(h.context)
      const from = { 'x-forwarded-for': '198.51.100.4' }

      expect((await buy('junk', from)).status).toBe(400)
      expect((await buy('junk', from)).status).toBe(400)
      expect((await buy('junk', from)).status).toBe(429)
      expect((await buy('junk', { 'x-forwarded-for': '198.51.100.5' })).status).toBe(400)
    })

    it('limits relays across all callers', async () => {
      h = harness({ RATE_RELAY_GLOBAL: '1', RATE_RELAY_PER_IP: '100', RATE_RELAY_PER_ADDRESS: '100' })
      relay = relayHandlers(h.context)
      signed = await freshQuote()
      h.rpc.logs = [policyBoughtLog(h, 1n, signed)]
      const other = await freshQuote(stranger.address)

      expect((await buy(await buyBody())).status).toBe(200)
      expect((await buy(await buyBody(other, stranger), { 'x-forwarded-for': '198.51.100.9' })).status).toBe(429)
    })
  })
})

describe('POST /relay/deposit', () => {
  let h: Harness
  let relay: ReturnType<typeof relayHandlers>
  const provider = privateKeyToAccount(generatePrivateKey())
  const deposit = (payload: unknown) => h.guarded(relay.deposit)(post('/relay/deposit', payload))

  async function depositBody(signer = provider, to = h.settings.contracts.coverPool) {
    const nonce = randomNonce()
    const authorization = await signAuthorization(signer, 'ReceiveWithAuthorization', h.reader.domain, {
      from: provider.address,
      to,
      value: 250_000_000n,
      nonce,
      validBefore: VALID_BEFORE,
    })
    return { assets: '250000000', receiver: provider.address, nonce, ...authorization }
  }

  beforeEach(() => {
    h = harness()
    relay = relayHandlers(h.context)
    h.rpc.logs = [
      {
        address: h.settings.contracts.coverPool,
        topics: encodeEventTopics({
          abi: coverPoolAbi,
          eventName: 'Deposit',
          args: { sender: h.relayerAccount.address, owner: provider.address },
        }) as Hex[],
        data: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [250_000_000n, 250_000_000_000_000n]),
      },
    ]
  })

  it('deposits for the provider who signed and reports the shares', async () => {
    const response = await deposit(await depositBody())
    const result = await body(response)

    expect(response.status).toBe(200)
    expect(result).toMatchObject({ receiver: provider.address, assets: '250000000', shares: '250000000000000' })
    const call = h.rpc.simulated[0]!
    expect(call.to).toBe(h.settings.contracts.coverPool)
    expect(call.data.slice(0, 10)).toBe(selectorOf('depositWithAuthorization'))
  })

  it('refuses an authorization signed by someone else', async () => {
    const response = await deposit(await depositBody(stranger))

    expect((await body(response)).error.code).toBe('authorization_invalid')
    expect(h.rpc.sent).toHaveLength(0)
  })

  it('refuses an authorization made out to another payee', async () => {
    const response = await deposit(await depositBody(provider, h.settings.contracts.coverBook))

    expect((await body(response)).error.code).toBe('authorization_invalid')
  })

  it('answers a replay with the original result', async () => {
    const payload = await depositBody()

    const first = await body(await deposit(payload))
    const replay = await body(await deposit(payload))

    expect(replay).toEqual(first)
    expect(h.rpc.sent).toHaveLength(1)
  })
})

describe('POST /relay/transfer', () => {
  let h: Harness
  let relay: ReturnType<typeof relayHandlers>
  const transfer = (payload: unknown) => h.guarded(relay.transfer)(post('/relay/transfer', payload))

  async function transferBody(signer = holder) {
    const nonce = randomNonce()
    const authorization = await signAuthorization(signer, 'TransferWithAuthorization', h.reader.domain, {
      from: holder.address,
      to: stranger.address,
      value: 5_000_000n,
      nonce,
      validBefore: VALID_BEFORE,
    })
    return { from: holder.address, to: stranger.address, value: '5000000', nonce, ...authorization }
  }

  beforeEach(() => {
    h = harness()
    relay = relayHandlers(h.context)
  })

  it('moves the dollars the sender signed for', async () => {
    const response = await transfer(await transferBody())

    expect(response.status).toBe(200)
    expect(await body(response)).toMatchObject({ from: holder.address, to: stranger.address, value: '5000000' })
    const call = h.rpc.simulated[0]!
    expect(call.to).toBe(h.settings.contracts.token)
    expect(call.data.slice(0, 10)).toBe('0xe3ee160e')
  })

  it('refuses a transfer the sender did not sign', async () => {
    const response = await transfer(await transferBody(stranger))

    expect((await body(response)).error.code).toBe('authorization_invalid')
    expect(h.rpc.sent).toHaveLength(0)
  })

  it('refuses a transfer whose amount was changed after signing', async () => {
    const payload = { ...(await transferBody()), value: '50000000' }

    expect((await body(await transfer(payload))).error.code).toBe('authorization_invalid')
  })

  it('sends a replayed transfer once', async () => {
    const payload = await transferBody()

    await transfer(payload)
    await transfer(payload)

    expect(h.rpc.sent).toHaveLength(1)
  })
})

describe('POST /relay/settle', () => {
  let h: Harness
  let relay: ReturnType<typeof relayHandlers>
  const settle = (payload: unknown) => h.guarded(relay.settle)(post('/relay/settle', payload))
  const key = (1n << 64n) | 7n

  beforeEach(() => {
    h = harness()
    relay = relayHandlers(h.context)
    h.reader.marketState.head = { number: 5n, timestamp: T0 + 900 }
    h.reader.lastToValues.set(key, BigInt(T0 + 900))
  })

  it('settles only the policies that are due', async () => {
    h.reader.policyRows.set(1n, fakePolicy(1n, { key }))
    h.reader.policyRows.set(2n, fakePolicy(2n, { key, closed: true }))
    h.reader.policyRows.set(3n, fakePolicy(3n, { key, start: T0 + 1_200, end: T0 + 1_800, settledUntil: T0 + 1_200 }))
    h.reader.claimableAmounts.set(1n, 120_000n)
    h.rpc.logs = [policySettledLog(h, 1n, 120_000n, true)]

    const response = await settle({ ids: [1, 2, 3] })
    const result = await body(response)

    expect(response.status).toBe(200)
    expect(result.settled).toEqual([{ id: '1', paid: '120000', settledUntil: T0 + 600, closed: true }])
    expect(result.skipped).toEqual(['2', '3'])
    const decoded = decodeFunctionData({ abi: coverBookAbi, data: h.rpc.simulated[0]!.data })
    expect(decoded.functionName).toBe('settleMany')
    expect(decoded.args?.[0]).toEqual([1n])
  })

  it('closes a dry policy whose window is fully reported', async () => {
    h.reader.policyRows.set(1n, fakePolicy(1n, { key }))
    h.rpc.logs = [policySettledLog(h, 1n, 0n, true)]

    const result = await body(await settle({ ids: [1] }))

    expect(result.settled[0]).toMatchObject({ id: '1', paid: '0', closed: true })
  })

  it('sends nothing when there is nothing to settle', async () => {
    h.reader.policyRows.set(1n, fakePolicy(1n, { key, closed: true }))
    h.reader.policyRows.set(2n, fakePolicy(2n, { key: key + 1n }))

    const response = await settle({ ids: [1, 2] })

    expect(response.status).toBe(200)
    expect(await body(response)).toEqual({ transactionHash: null, settled: [], skipped: ['1', '2'] })
    expect(h.rpc.simulated).toHaveLength(0)
    expect(h.rpc.sent).toHaveLength(0)
  })

  it('skips a dry stretch in the middle of a window', async () => {
    h.reader.lastToValues.set(key, BigInt(T0 + 300))
    h.reader.policyRows.set(1n, fakePolicy(1n, { key }))

    expect((await body(await settle({ ids: [1] }))).transactionHash).toBeNull()
  })

  it('abandons the transaction when someone else settled first', async () => {
    h.reader.policyRows.set(1n, fakePolicy(1n, { key }))
    h.reader.claimableAmounts.set(1n, 120_000n)
    const policies = h.reader.policies.bind(h.reader)
    let reads = 0
    h.reader.policies = async (ids) => {
      if (++reads === 2) h.reader.policyRows.set(1n, fakePolicy(1n, { key, closed: true }))
      return policies(ids)
    }

    const response = await settle({ ids: [1] })

    expect(await body(response)).toEqual({ transactionHash: null, settled: [], skipped: ['1'] })
    expect(h.rpc.sent).toHaveLength(0)
  })

  it('settles in one transaction only as many closes as fit its gas, and skips the rest', async () => {
    for (let id = 1n; id <= 10n; id++) {
      h.reader.policyRows.set(id, fakePolicy(id, { key }))
      h.reader.claimableAmounts.set(id, 1_000n)
    }

    const result = await body(await settle({ ids: Array.from({ length: 10 }, (_, i) => i + 1) }))

    const call = h.rpc.simulated[0]!
    const decoded = decodeFunctionData({ abi: coverBookAbi, data: call.data })
    expect(decoded.args?.[0]).toEqual([1n, 2n, 3n, 4n, 5n, 6n])
    expect(call.gas).toBe(settleManyGas(6, 6))
    expect(call.gas).toBeLessThanOrEqual(MAX_RELAY_GAS)
    expect(result.skipped).toEqual(['7', '8', '9', '10'])
  })

  it('budgets a payout that cannot close yet without the walk of a close', async () => {
    h.reader.policyRows.set(1n, fakePolicy(1n, { key, start: T0 + 600, end: T0 + 1_800, settledUntil: T0 + 600 }))
    h.reader.claimableAmounts.set(1n, 1_000n)

    await settle({ ids: [1] })

    expect(h.rpc.simulated[0]!.gas).toBe(settleManyGas(1, 0))
  })

  it('answers 404 for a policy that does not exist', async () => {
    h.reader.policyRows.set(1n, fakePolicy(1n, { key }))

    expect((await settle({ ids: [1, 9] })).status).toBe(404)
  })

  it('refuses a batch that is too large', async () => {
    const response = await settle({ ids: Array.from({ length: 11 }, (_, i) => i + 1) })

    expect(response.status).toBe(400)
  })
})
