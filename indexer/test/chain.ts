import type { TestIndexer } from 'envio'

export const CHAIN_ID = 10143
const START_BLOCK = 70_624_410

type ChainRun = NonNullable<Parameters<TestIndexer['process']>[0]['chains'][typeof CHAIN_ID]>
type Simulated = NonNullable<ChainRun['simulate']>[number]

/** The block and transaction an event is emitted in. */
type Mined = { block: { number: number; timestamp: number }; transaction: { hash: string } }
type Emitted = (mined: Mined) => Simulated

/**
 * A test indexer with a chain to feed it. `mine` processes the given events as one transaction in a new block
 * at `timestamp` and returns the transaction hash.
 *
 * Envio is imported here rather than at the top so that a platform without its runtime can still load the file.
 */
export async function startChain() {
  const { createTestIndexer } = await import('envio')
  const indexer = createTestIndexer()
  let height = START_BLOCK

  async function mine(timestamp: number, ...events: Emitted[]): Promise<string> {
    height += 1
    const mined = {
      block: { number: height, timestamp },
      transaction: { hash: `0x${height.toString(16).padStart(64, '0')}` },
    }
    await indexer.process({ chains: { [CHAIN_ID]: { simulate: events.map((emit) => emit(mined)) } } })
    return mined.transaction.hash
  }

  return { indexer, mine }
}

export type Purchase = {
  id: bigint
  holder: `0x${string}`
  key: bigint
  start: number
  end: number
  ratePerSecond: bigint
  premium: bigint
}

export const maxPayoutOf = (p: Purchase) => p.ratePerSecond * BigInt(p.end - p.start)

export const bought =
  (p: Purchase): Emitted =>
  ({ block, transaction }) => ({
    contract: 'CoverBook',
    event: 'PolicyBought',
    block,
    transaction,
    params: {
      id: p.id,
      holder: p.holder,
      key: p.key,
      start: BigInt(p.start),
      end: BigInt(p.end),
      ratePerSecond: p.ratePerSecond,
      premium: p.premium,
      maxPayout: maxPayoutOf(p),
    },
  })

export const settled =
  (p: Purchase, paid: bigint, settledUntil: number, closed: boolean): Emitted =>
  ({ block, transaction }) => ({
    contract: 'CoverBook',
    event: 'PolicySettled',
    block,
    transaction,
    params: { id: p.id, holder: p.holder, paid, settledUntil: BigInt(settledUntil), closed },
  })

export const feeSet =
  (feeBps: bigint): Emitted =>
  ({ block }) => ({ contract: 'CoverBook', event: 'FeeSet', block, params: { feeBps } })

export const exposureChanged =
  (key: bigint, cellExposure: bigint, lockedExposure: bigint): Emitted =>
  ({ block }) => ({
    contract: 'CoverPool',
    event: 'ExposureChanged',
    block,
    params: { key, cellExposure, lockedExposure },
  })

export const deposited =
  (owner: `0x${string}`, assets: bigint, shares: bigint): Emitted =>
  ({ block }) => ({ contract: 'CoverPool', event: 'Deposit', block, params: { sender: owner, owner, assets, shares } })

export const withdrawn =
  (controller: `0x${string}`, assets: bigint, shares: bigint): Emitted =>
  ({ block, transaction }) => ({
    contract: 'CoverPool',
    event: 'Withdraw',
    block,
    transaction,
    params: { sender: controller, receiver: controller, owner: controller, assets, shares },
  })

export const redeemRequested =
  (controller: `0x${string}`, shares: bigint, owner: `0x${string}` = controller): Emitted =>
  ({ block, transaction }) => ({
    contract: 'CoverPool',
    event: 'RedeemRequest',
    block,
    transaction,
    params: { controller, owner, requestId: 0n, sender: controller, shares },
  })

export const redeemRequestCancelled =
  (controller: `0x${string}`, shares: bigint): Emitted =>
  ({ block, transaction }) => ({
    contract: 'CoverPool',
    event: 'RedeemRequestCancelled',
    block,
    transaction,
    params: { controller, shares },
  })

export const redeemNoticeSet =
  (notice: bigint): Emitted =>
  ({ block }) => ({ contract: 'CoverPool', event: 'RedeemNoticeSet', block, params: { notice } })

export const payoutDeferred =
  (to: `0x${string}`, amount: bigint): Emitted =>
  ({ block }) => ({ contract: 'CoverPool', event: 'PayoutDeferred', block, params: { to, amount } })

export const deferredClaimed =
  (to: `0x${string}`, amount: bigint): Emitted =>
  ({ block }) => ({ contract: 'CoverPool', event: 'DeferredClaimed', block, params: { to, amount } })

export const weatherReported =
  (key: bigint, from: number, to: number, wetSeconds: number, cumulative: bigint): Emitted =>
  ({ block, transaction }) => ({
    contract: 'WeatherIndex',
    event: 'WeatherReported',
    block,
    transaction,
    params: { key, from: BigInt(from), to: BigInt(to), wetSeconds: BigInt(wetSeconds), cumulative },
  })

export const heartbeat =
  (timestamp: number): Emitted =>
  ({ block }) => ({ contract: 'WeatherIndex', event: 'Heartbeat', block, params: { timestamp: BigInt(timestamp) } })
