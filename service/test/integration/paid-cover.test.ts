import { coverBookAbi } from '@cover/core/abi'
import { generatePrivateKey, privateKeyToAccount, privateKeyToAddress } from 'viem/accounts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomNonce, signAuthorization } from '../helpers/signing'
import { payFor } from '../helpers/x402'
import { DRIP, FEE, MAX_PAYOUT, PREMIUM, RATE, SIMULATOR, json, startWorld, type World } from './world'

const agent = privateKeyToAccount(generatePrivateKey())
const provider = privateKeyToAccount(generatePrivateKey())
const holder = privateKeyToAddress(generatePrivateKey())

let world: World

beforeAll(async () => {
  world = await startWorld()
  await world.fund([agent.address, provider.address])

  const nonce = randomNonce()
  const authorization = await signAuthorization(provider, 'ReceiveWithAuthorization', world.tokenDomain(), {
    to: world.contracts.coverPool,
    value: DRIP,
    nonce,
    validBefore: BigInt(world.clock.now + 3_600),
  })
  const deposit = await world.post('/relay/deposit', {
    assets: DRIP.toString(),
    receiver: provider.address,
    nonce,
    ...authorization,
  })
  if (deposit.status !== 200) throw new Error(`the deposit answered ${deposit.status}`)
  await world.tick()
})

afterAll(() => {
  world?.stop()
})

describe('paid cover on a local Monad chain', () => {
  let order: Record<string, string | number>
  let payment: string
  let first: Record<string, unknown>

  it('names its price when no payment is attached', async () => {
    await world.sync()
    order = { ...SIMULATOR, ...world.nextWindow(), rate: RATE.toString(), holder }

    const response = await world.post('/v1/cover', order)
    payment = await payFor(response, agent)

    expect(response.status).toBe(402)
    expect((await json(response)).accepts[0]).toMatchObject({
      scheme: 'exact',
      network: 'eip155:31337',
      asset: world.contracts.token,
      amount: PREMIUM.toString(),
      payTo: world.relayerAddress,
      extra: { name: 'Test Dollar', version: '1' },
    })
    expect(await world.policyCount()).toBe(0n)
  })

  it('settles the payment through the facilitator, then buys the policy for the holder', async () => {
    const pool = await world.balanceOf(world.contracts.coverPool)

    const response = await world.post('/v1/cover', order, { 'payment-signature': payment })
    first = await json(response)

    expect(response.status, JSON.stringify(first.error)).toBe(200)
    expect(first.policyId).toBe('1')
    expect(first.payment).toMatchObject({ success: true, payer: agent.address, amount: PREMIUM.toString() })
    expect(response.headers.get('payment-response')).toBeTruthy()

    expect(await world.balanceOf(agent.address)).toBe(DRIP - PREMIUM)
    expect(await world.balanceOf(world.relayerAddress)).toBe(0n)
    expect(await world.balanceOf(world.treasury)).toBe(FEE)
    expect(await world.balanceOf(world.contracts.coverPool)).toBe(pool + PREMIUM - FEE)
    expect(await world.lockedExposure()).toBe(MAX_PAYOUT)

    const policy = await world.client.readContract({
      address: world.contracts.coverBook,
      abi: coverBookAbi,
      functionName: 'policies',
      args: [1n],
    })
    expect(policy[0]).toBe(holder)
    expect(policy[5]).toBe(PREMIUM)
    expect(policy[6]).toBe(MAX_PAYOUT)
  })

  it('answers the same payment again with the same policy and charges nothing more', async () => {
    const nonce = await world.relayerNonce()

    const again = await world.post('/v1/cover', order, { 'payment-signature': payment })

    expect(again.status).toBe(200)
    expect(await json(again)).toEqual(first)
    expect(await world.balanceOf(agent.address)).toBe(DRIP - PREMIUM)
    expect(await world.policyCount()).toBe(1n)
    expect(await world.relayerNonce()).toBe(nonce)
  })

  it('does not sell a second policy for a spent payment after a restart has wiped what it remembers', async () => {
    world.restart()
    const nonce = await world.relayerNonce()

    const response = await world.post('/v1/cover', order, { 'payment-signature': payment })

    expect(response.status).toBe(402)
    expect((await json(response)).error.message).toMatch(/not valid/)
    expect(await world.policyCount()).toBe(1n)
    expect(await world.balanceOf(agent.address)).toBe(DRIP - PREMIUM)
    expect(await world.relayerNonce()).toBe(nonce)
  })

  it('stayed inside the gas limits of the approval and the purchase', () => {
    const used = world.gas.filter((entry) => entry.name === 'approve' || entry.name === 'buy')

    expect(used.map((entry) => entry.name)).toEqual(['approve', 'buy'])
    for (const entry of used) expect(entry.used, entry.name).toBeLessThanOrEqual(entry.limit)
    if (process.env.SHOW_GAS) {
      console.info(world.gas.map((entry) => `${entry.name.padEnd(28)} ${entry.used} / ${entry.limit}`).join('\n'))
    }
    expect(world.logger.entries.filter((entry) => entry.level === 'error')).toEqual([])
  })
})
