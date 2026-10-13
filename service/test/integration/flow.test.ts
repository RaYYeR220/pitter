import { coverBookAbi, coverPoolAbi, weatherIndexAbi } from '@cover/core/abi'
import { toHex, type Hex } from 'viem'
import { generatePrivateKey, privateKeyToAccount, privateKeyToAddress } from 'viem/accounts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { coreSigning } from '../../src/adapters/core'
import { quoteToJson } from '../../src/quote/engine'
import type { Quote } from '../../src/types'
import { randomNonce, signAuthorization } from '../helpers/signing'
import {
  CHAIN_ID,
  DRIP,
  FEE,
  MAX_PAYOUT,
  PREMIUM,
  RATE,
  SIMULATOR,
  SIMULATOR_KEY,
  json,
  startWorld,
  type World,
} from './world'

const holder = privateKeyToAccount(generatePrivateKey())
const provider = privateKeyToAccount(generatePrivateKey())
const stranger = privateKeyToAccount(generatePrivateKey())

let world: World

beforeAll(async () => {
  world = await startWorld()
})

afterAll(() => {
  world?.stop()
})

function quotePath(overrides: Record<string, string | number> = {}): string {
  const params = { ...SIMULATOR, ...world.nextWindow(), rate: RATE.toString(), holder: holder.address, ...overrides }
  return `/quote?${Object.entries(params)
    .map(([name, value]) => `${name}=${value}`)
    .join('&')}`
}

describe('cover on a local Monad chain', () => {
  let quoted: { quote: Record<string, string>; quoteSig: Hex; digest: Hex }
  let purchase: Record<string, unknown>
  let window: { start: number; end: number }

  it('refuses to quote before the oracle has ever reported', async () => {
    const response = await world.get(quotePath())

    expect(response.status).toBe(503)
    expect((await json(response)).error.code).toBe('oracle_stale')
  })

  it('drips test dollars through the relayer', async () => {
    for (const account of [holder, provider]) {
      const response = await world.sandbox('/sandbox/drip', { address: account.address })
      expect(response.status).toBe(200)
      expect(await json(response)).toMatchObject({ amount: DRIP.toString(), simulated: true })
    }

    expect(await world.balanceOf(holder.address)).toBe(DRIP)
    expect(await world.client.getBalance({ address: holder.address })).toBe(0n)
  })

  it('refuses a second drip to the same address without paying for it', async () => {
    const nonce = await world.relayerNonce()

    const response = await world.sandbox('/sandbox/drip', { address: holder.address })

    expect(response.status).toBe(429)
    expect((await json(response)).error.code).toBe('drip_limited')
    expect(await world.relayerNonce()).toBe(nonce)
  })

  it('takes a gasless deposit into the pool', async () => {
    await world.sync()
    const nonce = randomNonce()
    const authorization = await signAuthorization(provider, 'ReceiveWithAuthorization', world.tokenDomain(), {
      to: world.contracts.coverPool,
      value: DRIP,
      nonce,
      validBefore: BigInt(world.clock.now + 3_600),
    })

    const response = await world.post('/relay/deposit', {
      assets: DRIP.toString(),
      receiver: provider.address,
      nonce,
      ...authorization,
    })

    expect(response.status).toBe(200)
    const result = await json(response)
    expect(BigInt(result.shares)).toBeGreaterThan(0n)
    expect(await world.balanceOf(world.contracts.coverPool)).toBe(DRIP)
    expect(await world.balanceOf(provider.address)).toBe(0n)
    expect(
      await world.client.readContract({
        address: world.contracts.coverPool,
        abi: coverPoolAbi,
        functionName: 'balanceOf',
        args: [provider.address],
      }),
    ).toBe(BigInt(result.shares))
  })

  it('starts the heartbeat with the first keeper tick', async () => {
    const outcome = await world.tick()

    expect(outcome.report).toMatchObject({ status: 'submitted', readings: [] })
    const heartbeat = await world.client.readContract({
      address: world.contracts.weatherIndex,
      abi: weatherIndexAbi,
      functionName: 'heartbeat',
    })
    expect(Number(heartbeat)).toBeGreaterThan(world.clock.now - 60)
  })

  it('refuses a quote the pool cannot back in that cell', async () => {
    const response = await world.get(quotePath({ rate: 420_000 }))
    const { error } = await json(response)

    expect(response.status).toBe(409)
    expect(error.code).toBe('capacity_exhausted')
    expect(error.details.scope).toBe('cell')
    expect(error.details.capacity.cellLimit).toBe('250000000')
  })

  it('does not pay for an over-cap purchase even when the underwriter signed it', async () => {
    const { start, end } = world.nextWindow()
    const quote: Quote = {
      holder: holder.address,
      key: SIMULATOR_KEY,
      start: BigInt(start),
      end: BigInt(end),
      ratePerSecond: 420_000n,
      premium: 12_600_000n,
      expiry: BigInt(world.clock.now + 120),
      salt: toHex(crypto.getRandomValues(new Uint8Array(32))),
    }
    const digest = coreSigning.quoteDigest(quote, CHAIN_ID, world.contracts.coverBook)
    const quoteSig = await world.underwriter.sign({ hash: digest })
    const nonce = await world.relayerNonce()
    const funds = await world.client.getBalance({ address: world.relayerAddress })

    const response = await world.post('/relay/buy', await world.buyBody(quoteToJson(quote), quoteSig, digest, holder))
    const { error } = await json(response)

    expect(response.status).toBe(409)
    expect(error).toMatchObject({ code: 'would_revert', details: { reason: 'CellCapExceeded' } })
    expect(await world.relayerNonce()).toBe(nonce)
    expect(await world.client.getBalance({ address: world.relayerAddress })).toBe(funds)
    expect(await world.policyCount()).toBe(0n)
  })

  it('quotes cover for the simulator cell', async () => {
    const response = await world.get(quotePath())
    quoted = await json(response)

    expect(response.status).toBe(200)
    expect(quoted.quote.premium).toBe(PREMIUM.toString())
    expect(quoted.quote.key).toBe(SIMULATOR_KEY.toString())
    window = { start: Number(quoted.quote.start), end: Number(quoted.quote.end) }
    expect(
      await world.client.readContract({
        address: world.contracts.coverBook,
        abi: coverBookAbi,
        functionName: 'hashQuote',
        args: [
          {
            holder: holder.address,
            key: SIMULATOR_KEY,
            start: BigInt(quoted.quote.start!),
            end: BigInt(quoted.quote.end!),
            ratePerSecond: RATE,
            premium: PREMIUM,
            expiry: BigInt(quoted.quote.expiry!),
            salt: quoted.quote.salt as Hex,
          },
        ],
      }),
    ).toBe(quoted.digest)
  })

  it("refuses the holder's quote paid with someone else's authorization", async () => {
    const nonce = await world.relayerNonce()

    const response = await world.post(
      '/relay/buy',
      await world.buyBody(quoted.quote, quoted.quoteSig, quoted.digest, stranger),
    )

    expect(response.status).toBe(400)
    expect((await json(response)).error.code).toBe('authorization_invalid')
    expect(await world.relayerNonce()).toBe(nonce)
  })

  it('relays the purchase: the holder pays the premium and no gas', async () => {
    const response = await world.post(
      '/relay/buy',
      await world.buyBody(quoted.quote, quoted.quoteSig, quoted.digest, holder),
    )
    purchase = await json(response)

    expect(response.status).toBe(200)
    expect(purchase.policyId).toBe('1')
    expect(await world.balanceOf(holder.address)).toBe(DRIP - PREMIUM)
    expect(await world.balanceOf(world.treasury)).toBe(FEE)
    expect(await world.balanceOf(world.contracts.coverPool)).toBe(DRIP + PREMIUM - FEE)
    expect(await world.lockedExposure()).toBe(MAX_PAYOUT)
    expect(await world.client.getBalance({ address: holder.address })).toBe(0n)
  })

  it('answers a replayed purchase without buying twice', async () => {
    const nonce = await world.relayerNonce()

    const replay = await world.post(
      '/relay/buy',
      await world.buyBody(quoted.quote, quoted.quoteSig, quoted.digest, holder),
    )

    expect(replay.status).toBe(200)
    expect(await json(replay)).toEqual(purchase)
    expect(await world.relayerNonce()).toBe(nonce)
    expect(await world.policyCount()).toBe(1n)
  })

  it('does not buy twice even after a restart has wiped what it remembers', async () => {
    world.restart()
    const nonce = await world.relayerNonce()

    const replay = await world.post(
      '/relay/buy',
      await world.buyBody(quoted.quote, quoted.quoteSig, quoted.digest, holder),
    )

    expect(replay.status).toBe(409)
    expect((await json(replay)).error.details.reason).toBe('QuoteUsed')
    expect(await world.relayerNonce()).toBe(nonce)
    expect(await world.policyCount()).toBe(1n)
  })

  it('pays out while it rains and closes the policy when its window is reported', async () => {
    const before = await world.balanceOf(holder.address)
    await world.chain.mineAt(window.start + 300)
    await world.sandbox('/sandbox/storm', { wet: true })

    const during = await world.tick()

    expect(during.report.status).toBe('submitted')
    expect(during.report.readings).toEqual([
      {
        key: SIMULATOR_KEY.toString(),
        from: window.start,
        to: window.start + 300,
        wetSeconds: 300,
        source: 'simulator',
      },
    ])
    expect(during.settlement.settled).toEqual([{ id: '1', paid: (300n * RATE).toString(), closed: false }])
    expect(await world.balanceOf(holder.address)).toBe(before + 300n * RATE)
    expect(await world.lockedExposure()).toBe(MAX_PAYOUT - 300n * RATE)

    await world.chain.mineAt(window.end + 60)
    const after = await world.tick()

    expect(after.report.readings[0]).toMatchObject({
      from: window.start + 300,
      to: window.end + 60,
      wetSeconds: 360,
      source: 'simulator',
    })
    expect(after.settlement.settled).toEqual([{ id: '1', paid: (300n * RATE).toString(), closed: true }])
    expect(after.settlement.failures).toEqual([])
    expect(await world.balanceOf(holder.address)).toBe(before + MAX_PAYOUT)
    expect(await world.lockedExposure()).toBe(0n)
    expect(await world.balanceOf(world.contracts.coverPool)).toBe(DRIP + PREMIUM - FEE - MAX_PAYOUT)
  })

  it('has nothing left to settle afterwards', async () => {
    const nonce = await world.relayerNonce()

    const response = await world.post('/relay/settle', { ids: [1] })

    expect(await json(response)).toEqual({ transactionHash: null, settled: [], skipped: ['1'] })
    expect(await world.relayerNonce()).toBe(nonce)
  })

  it('stops quoting once the heartbeat is stale and resumes after a report', async () => {
    await world.chain.mineAt((await world.chain.time()) + 21 * 60)
    await world.sync()

    const stale = await world.get(quotePath())
    await world.sandbox('/sandbox/storm', { wet: false })
    await world.tick()
    const fresh = await world.get(quotePath())

    expect(stale.status).toBe(503)
    expect((await json(stale)).error.code).toBe('oracle_stale')
    expect(fresh.status).toBe(200)
  })

  it('relays a cash-out the holder signed', async () => {
    await world.sync()
    const recipient = privateKeyToAddress(generatePrivateKey())
    const nonce = randomNonce()
    const before = await world.balanceOf(holder.address)
    const authorization = await signAuthorization(holder, 'TransferWithAuthorization', world.tokenDomain(), {
      to: recipient,
      value: 250_000n,
      nonce,
      validBefore: BigInt(world.clock.now + 3_600),
    })

    const response = await world.post('/relay/transfer', {
      from: holder.address,
      to: recipient,
      value: '250000',
      nonce,
      ...authorization,
    })

    expect(response.status).toBe(200)
    expect(await world.balanceOf(recipient)).toBe(250_000n)
    expect(await world.balanceOf(holder.address)).toBe(before - 250_000n)
  })

  it('keeps its nonces in order under concurrent requests', async () => {
    const recipients = Array.from({ length: 6 }, () => privateKeyToAddress(generatePrivateKey()))
    const nonce = await world.relayerNonce()

    const responses = await Promise.all(recipients.map((address) => world.sandbox('/sandbox/drip', { address })))

    expect(responses.map((response) => response.status)).toEqual([200, 200, 200, 200, 200, 200])
    expect(await world.relayerNonce()).toBe(nonce + 6)
    for (const address of recipients) expect(await world.balanceOf(address)).toBe(DRIP)
  })

  it('sent every transaction synchronously, with a gas limit of its own choosing', () => {
    expect(world.nodeMethods.has('eth_sendRawTransactionSync')).toBe(true)
    expect(world.nodeMethods.has('eth_sendRawTransaction')).toBe(false)
    expect(world.nodeMethods.has('eth_sendTransaction')).toBe(false)
    expect(world.nodeMethods.has('eth_estimateGas')).toBe(false)
  })

  it('stayed inside every gas limit it set', () => {
    for (const entry of world.gas) expect(entry.used, entry.name).toBeLessThanOrEqual(entry.limit)
    expect(new Set(world.gas.map((entry) => entry.name))).toEqual(
      new Set([
        'drip',
        'depositWithAuthorization',
        'submit',
        'buyWithAuthorization',
        'settleMany',
        'transferWithAuthorization',
      ]),
    )
    if (process.env.SHOW_GAS) {
      console.info(world.gas.map((entry) => `${entry.name.padEnd(28)} ${entry.used} / ${entry.limit}`).join('\n'))
    }
    expect(world.logger.entries.filter((entry) => entry.level === 'error')).toEqual([])
  })
})
