import { coverBookAbi, coverPoolAbi, testDollarAbi, weatherIndexAbi } from '@cover/core/abi'
import { writeFileSync } from 'node:fs'
import { createWalletClient, encodeFunctionData, http, maxUint256, toHex, type Abi, type Address, type Hex } from 'viem'
import { generatePrivateKey, privateKeyToAccount, privateKeyToAddress } from 'viem/accounts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { coreCells, coreSigning } from '../../src/adapters/core'
import {
  BUY_WITH_AUTHORIZATION_GAS,
  EXPIRE_GAS,
  MAX_RELAY_GAS,
  settleManyGas,
  syncOldestOpenGas,
} from '../../src/relayer/gas'
import type { Quote, Reading } from '../../src/types'
import { CHAIN_ID, RATE as WORLD_RATE, json, startWorld, type World } from './world'

/**
 * Measures, on a local chain under the Monad gas rules, the calls whose cost the book's oldest-open mark
 * changed, and checks them against the relayer's limits. A close walks `oldestOpenId` forward over up to 32
 * closed policies, one cold storage read each; the book here is set up so that every measured close walks
 * the full 32 steps, pays an address that held nothing and frees the last slot of its cell, which is the
 * most a settlement can cost. `GAS_REPORT=<file>` writes the measurements out.
 */

const RATE = 10n
const WINDOW = 600
const PREMIUM = 1_000n
/** Policies that close ahead of the mark: enough for every measured walk. */
const CLOSED_AHEAD = 32 * 12
const FEE = 1_000_000_000_000n
const TIP = 1_000_000_000n

let world: World
const measured: Record<string, { needed: bigint; used: bigint }> = {}

beforeAll(async () => {
  world = await startWorld()
})

afterAll(() => {
  world?.stop()
})

describe('gas of a close that walks the oldest-open mark, on a local Monad chain', () => {
  const owner = () => privateKeyToAccount(world.keys.deployer)
  let signer: ReturnType<typeof createWalletClient>
  let nonce = 0

  const call = (to: Address, abi: Abi, functionName: string, args: readonly unknown[] = []) => ({
    to,
    data: encodeFunctionData({ abi, functionName, args }),
  })
  const book = (functionName: string, args: readonly unknown[] = []) =>
    call(world.contracts.coverBook, coverBookAbi as Abi, functionName, args)
  const pool = (functionName: string, args: readonly unknown[] = []) =>
    call(world.contracts.coverPool, coverPoolAbi as Abi, functionName, args)

  /** Sends from the owner without waiting for the receipt. */
  function fire(target: { to: Address; data: Hex }, gas = 3_000_000n): Promise<Hex> {
    return signer.sendTransaction({
      ...target,
      gas,
      nonce: nonce++,
      maxFeePerGas: FEE,
      maxPriorityFeePerGas: TIP,
      account: owner(),
      chain: null,
    })
  }

  /** Sends what `send` fires in one block instead of one block each, which keeps the set-up quick. */
  async function inOneBlock(send: () => Promise<Hex[]>): Promise<void> {
    const rpc = world.client.request as (args: { method: string; params: unknown[] }) => Promise<unknown>
    await rpc({ method: 'evm_setAutomine', params: [false] })
    try {
      const hashes = await send()
      await rpc({ method: 'evm_mine', params: [] })
      for (const hash of hashes) await confirmed(hash)
    } finally {
      await rpc({ method: 'evm_setAutomine', params: [true] })
    }
  }

  async function confirmed(hash: Hex) {
    const receipt = await world.client.waitForTransactionReceipt({ hash, pollingInterval: 50 })
    expect(receipt.status).toBe('success')
    return receipt
  }

  /** Finds the least gas limit that succeeds, then sends with exactly that limit. */
  async function measure(name: string, target: { to: Address; data: Hex }): Promise<void> {
    const needed = await world.client.estimateGas({ account: owner().address, ...target })
    const receipt = await confirmed(await fire(target, needed))
    measured[name] = { needed, used: receipt.gasUsed }
  }

  async function report(readings: Reading[]) {
    const [time, last] = await Promise.all([
      world.chain.time(),
      world.client.readContract({
        address: world.contracts.weatherIndex,
        abi: weatherIndexAbi,
        functionName: 'lastIssuedAt',
      }),
    ])
    const issuedAt = BigInt(Math.max(time, Number(last) + 1))
    const digest = coreSigning.reportDigest(readings, issuedAt, CHAIN_ID, world.contracts.weatherIndex)
    const signature = await privateKeyToAccount(world.keys.reporter).sign({ hash: digest })
    const bytes = coreSigning.encodeReport(readings, issuedAt, signature)
    await confirmed(await fire(call(world.contracts.weatherIndex, weatherIndexAbi as Abi, 'submit', [bytes])))
  }

  /** Buys cover in `key` for a fresh holder, paid by the owner. */
  async function buy(key: bigint, start: number, end: number): Promise<Hex> {
    const quote: Quote = {
      holder: privateKeyToAddress(generatePrivateKey()),
      key,
      start: BigInt(start),
      end: BigInt(end),
      ratePerSecond: RATE,
      premium: PREMIUM,
      expiry: BigInt(start),
      salt: toHex(crypto.getRandomValues(new Uint8Array(32))),
    }
    const digest = coreSigning.quoteDigest(quote, CHAIN_ID, world.contracts.coverBook)
    const quoteSig = await world.underwriter.sign({ hash: digest })
    return fire(book('buy', [quote, quoteSig]), 1_000_000n)
  }

  const cell = (i: number) => ({ lat: 20.025 + i * 0.05, lon: 20.025 })
  const keyOf = (i: number) => coreCells.keyAt(cell(i).lat, cell(i).lon)
  const oldestOpenId = () =>
    world.client.readContract({ address: world.contracts.coverBook, abi: coverBookAbi, functionName: 'oldestOpenId' })

  let start = 0
  let end = 0
  const LONG = 1n
  const FIRST_MEASURED = BigInt(CLOSED_AHEAD + 2)
  const BATCH = Array.from({ length: 6 }, (_, i) => FIRST_MEASURED + 1n + BigInt(i))
  const SINGLE = FIRST_MEASURED + 7n
  const PAYOUT_ONLY = FIRST_MEASURED + 8n
  const EXPIRING = FIRST_MEASURED + 9n

  it('builds a book whose mark has many closed policies ahead of it', async () => {
    signer = createWalletClient({ account: owner(), transport: http(world.chain.url) })
    nonce = await world.client.getTransactionCount({ address: owner().address })
    const token = world.contracts.token
    await fire(call(token, testDollarAbi as Abi, 'drip', [owner().address]))
    await fire(call(token, testDollarAbi as Abi, 'approve', [world.contracts.coverPool, maxUint256]))
    await fire(call(token, testDollarAbi as Abi, 'approve', [world.contracts.coverBook, maxUint256]))
    await confirmed(await fire(pool('deposit', [600_000_000n, owner().address])))
    await report([])

    start = Math.ceil(((await world.chain.time()) + 1_200) / 60) * 60
    end = start + WINDOW

    // 1 holds the mark: it ends a window later than the policies sold after it.
    await buy(keyOf(0), start, end + WINDOW)
    for (let i = 0; i < CLOSED_AHEAD; i += 64) {
      await inOneBlock(async () => {
        const hashes: Hex[] = []
        for (let j = i; j < Math.min(i + 64, CLOSED_AHEAD); j++) hashes.push(await buy(keyOf(0), start, end))
        return hashes
      })
    }
    // The measured policies, each in a cell of its own and paying an address that holds nothing.
    for (let i = 1; i <= 9; i++) await buy(keyOf(i), start, end)
    await confirmed(await buy(keyOf(10), start, end))
    expect(await world.policyCount()).toBe(EXPIRING)

    // Close 2..CLOSED_AHEAD+1 while 1 is open: the mark cannot move.
    await world.chain.mineAt(end + 60)
    await report([{ key: keyOf(0), from: BigInt(start - 60), to: BigInt(end + 60), wetSeconds: 0 }])
    const closing = Array.from({ length: CLOSED_AHEAD }, (_, i) => BigInt(i + 2))
    await inOneBlock(async () => {
      const hashes: Hex[] = []
      for (let i = 0; i < closing.length; i += 10)
        hashes.push(await fire(book('settleMany', [closing.slice(i, i + 10)])))
      return hashes
    })
    expect(await oldestOpenId()).toBe(1n)

    await world.chain.mineAt(end + WINDOW + 60)
    const readings: Reading[] = [
      { key: keyOf(0), from: BigInt(end + 60), to: BigInt(end + WINDOW + 60), wetSeconds: 300 },
    ]
    for (let i = 1; i <= 8; i++) {
      readings.push({ key: keyOf(i), from: BigInt(start - 60), to: BigInt(end + 60), wetSeconds: 300 })
    }
    for (const i of [9, 10]) {
      readings.push({ key: keyOf(i), from: BigInt(start - 60), to: BigInt(start + 300), wetSeconds: 300 })
    }
    await report(readings)
  })

  it('settles a policy that pays, closes, frees its cell and walks 32 steps', async () => {
    await measure('settle: payout, close, walk 32', book('settle', [LONG]))
    expect(await oldestOpenId()).toBe(33n)
    await measure('settleMany(1): payout, close, walk 32', book('settleMany', [[FIRST_MEASURED]]))
    expect(await oldestOpenId()).toBe(65n)
    await measure('settleMany(1) again', book('settleMany', [[SINGLE]]))
    expect(await oldestOpenId()).toBe(97n)
  })

  it('settles the largest batch of closes the relayer sends, every one walking 32 steps', async () => {
    await measure('settleMany(6): payout, close, walk 32 each', book('settleMany', [BATCH]))
    expect(await oldestOpenId()).toBe(97n + 6n * 32n)
  })

  it('settles a payout that does not close', async () => {
    await measure('settleMany(1): payout, no close', book('settleMany', [[PAYOUT_ONLY]]))
  })

  it('expires a policy with a payout, a close and a walk of 32 steps', async () => {
    const grace = await world.client.readContract({
      address: world.contracts.coverBook,
      abi: coverBookAbi,
      functionName: 'expiryGrace',
    })
    await world.chain.mineAt(end + Number(grace) + 60)
    const before = await oldestOpenId()
    await measure('expire: payout, close, walk 32', book('expire', [EXPIRING]))
    expect(await oldestOpenId()).toBe(before + 32n)
  })

  it('walks the mark on its own', async () => {
    const before = await oldestOpenId()
    await measure('syncOldestOpen(16)', book('syncOldestOpen', [16n]))
    await measure('syncOldestOpen(48)', book('syncOldestOpen', [48n]))
    expect(await oldestOpenId()).toBe(before + 64n)
  })

  it('has the keeper catch the mark up, then expire what the oracle never finished', async () => {
    const before = await oldestOpenId()
    expect(before).toBeLessThan(PAYOUT_ONLY)

    const outcome = (await world.tick()) as Awaited<ReturnType<World['tick']>> & {
      settlement: { synced: { from: string; to: string } | null }
    }

    expect(outcome.settlement.synced).toEqual({ from: before.toString(), to: PAYOUT_ONLY.toString() })
    expect(outcome.settlement.expired).toEqual([{ id: PAYOUT_ONLY.toString(), paid: '0' }])
    expect(outcome.settlement.failures).toEqual([])
    expect(await oldestOpenId()).toBe(EXPIRING + 1n)
  })

  it('measures leaving the pool', async () => {
    const me = owner().address
    const shares = await world.client.readContract({
      address: world.contracts.coverPool,
      abi: coverPoolAbi,
      functionName: 'balanceOf',
      args: [me],
    })
    await measure('requestRedeem', pool('requestRedeem', [shares / 2n, me, me]))
    for (const [name, args] of [
      ['claimBlockedByCover', [me]],
      ['maxRedeem', [me]],
      ['claimableRedeemRequest', [0n, me]],
      ['redeemRequests', [me]],
    ] as const) {
      const needed = await world.client.estimateGas({ account: me, ...pool(name, args) })
      measured[`read ${name}`] = { needed, used: needed }
    }
    const notice = await world.client.readContract({
      address: world.contracts.coverPool,
      abi: coverPoolAbi,
      functionName: 'redeemNotice',
    })
    await world.chain.mineAt((await world.chain.time()) + Number(notice) + 60)
    const claimable = await world.client.readContract({
      address: world.contracts.coverPool,
      abi: coverPoolAbi,
      functionName: 'maxRedeem',
      args: [me],
    })
    expect(claimable).toBeGreaterThan(0n)
    await measure('redeem: claim a matured request', pool('redeem', [claimable / 2n, me, me]))
    await measure('cancelRedeemRequest', pool('cancelRedeemRequest'))
  })

  it('sells only in served areas once the owner says so, and measures the first sale in one', async () => {
    const me = owner().address
    await confirmed(await fire(book('setServed', [[keyOf(20)], true])))
    await confirmed(await fire(book('setServedOnly', [true])))
    await world.tick()

    const window = world.nextWindow()
    const path = (i: number) =>
      `/quote?lat=${cell(i).lat}&lon=${cell(i).lon}&start=${window.start}&end=${window.end}` +
      `&rate=${WORLD_RATE}&holder=${me}`
    const refused = await world.get(path(21))
    const offered = await world.get(path(20))

    expect(refused.status).toBe(422)
    expect((await json(refused)).error.code).toBe('area_not_served')
    expect(offered.status).toBe(200)
    const offer = await json(offered)
    const bought = await world.post(
      '/relay/buy',
      await world.buyBody(offer.quote, offer.quoteSig, offer.digest, owner()),
    )
    expect(bought.status).toBe(200)
    const entry = world.gas.filter((item) => item.name === 'buyWithAuthorization').at(-1)!
    measured['buyWithAuthorization: first policy of a served cell'] = { needed: entry.used, used: entry.used }
  })

  it('stays within the limits the relayer uses', () => {
    if (process.env.GAS_REPORT) {
      const lines = Object.entries(measured).map(([name, { needed, used }]) => `${name.padEnd(52)} ${needed} ${used}`)
      writeFileSync(process.env.GAS_REPORT, lines.join('\n') + '\n')
    }
    const need = (name: string) => measured[name]!.needed
    expect(need('settleMany(1): payout, close, walk 32')).toBeLessThanOrEqual(settleManyGas(1, 1))
    expect(need('settleMany(1) again')).toBeLessThanOrEqual(settleManyGas(1, 1))
    expect(need('settleMany(6): payout, close, walk 32 each')).toBeLessThanOrEqual(settleManyGas(6, 6))
    expect(settleManyGas(6, 6)).toBeLessThanOrEqual(MAX_RELAY_GAS)
    expect(need('settleMany(1): payout, no close')).toBeLessThanOrEqual(settleManyGas(1, 0))
    expect(need('expire: payout, close, walk 32')).toBeLessThanOrEqual(EXPIRE_GAS)
    expect(need('syncOldestOpen(16)')).toBeLessThanOrEqual(syncOldestOpenGas(16))
    expect(need('syncOldestOpen(48)')).toBeLessThanOrEqual(syncOldestOpenGas(48))
    expect(need('buyWithAuthorization: first policy of a served cell')).toBeLessThanOrEqual(BUY_WITH_AUTHORIZATION_GAS)
    for (const entry of world.gas) expect(entry.used, entry.name).toBeLessThanOrEqual(entry.limit)
    expect(world.gas.map((entry) => entry.name)).toEqual(expect.arrayContaining(['syncOldestOpen', 'expire']))
    expect(world.logger.entries.filter((entry) => entry.level === 'error')).toEqual([])
  })
})
