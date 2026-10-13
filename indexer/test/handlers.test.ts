import { describe, expect, it } from 'vitest'
import {
  CHAIN_ID,
  bought,
  deferredClaimed,
  deposited,
  exposureChanged,
  feeSet,
  heartbeat,
  rescued,
  servedOnlySet,
  servedSet,
  sharesRescued,
  surplusToTreasury,
  treasurySet,
  payoutDeferred,
  redeemNoticeSet,
  redeemRequestCancelled,
  redeemRequested,
  settled,
  startChain,
  weatherReported,
  withdrawn,
  type Purchase,
} from './chain'

const HOUR = 3_600
const DAY = 86_400
const OCT_12 = Date.UTC(2026, 9, 12) / 1000
const OCT_13 = OCT_12 + DAY
const OCT_14 = OCT_13 + DAY
const T0 = OCT_12 + 10 * HOUR
const NOTICE = 13 * HOUR

const LISBON = 18446755128955374937n
const NEW_YORK = 18446755300754065479n
const ALICE = '0x00000000000000000000000000000000000a11ce'
const BOB = '0x0000000000000000000000000000000000000b0b'
const TREASURY = '0x00000000000000000000000000000000000ca5e5'
/** The pool's address on the test network, as config.yaml records it. */
const COVER_POOL = '0x80375eb8be28a7bffb274c2620e9d70fe7e70b9f'
const SHARE_UNIT = 1_000_000_000_000n

/** Ten minutes of cover over Lisbon at 1000 units a second: at most 600 000, for a premium of 60 000. */
const tenMinutes = (overrides: Partial<Purchase> = {}): Purchase => ({
  id: 1n,
  holder: ALICE,
  key: LISBON,
  start: T0 + 600,
  end: T0 + 1_200,
  ratePerSecond: 1_000n,
  premium: 60_000n,
  ...overrides,
})

// The Envio runtime has no Windows build. Under WSL or in a Linux container the platform is linux.
describe.skipIf(process.platform === 'win32')('handlers', () => {
  describe('a purchase', () => {
    it('opens a policy and counts it for the holder, the cell and the pool', async () => {
      const { indexer, mine } = await startChain()
      const hash = await mine(T0, bought(tenMinutes()), exposureChanged(LISBON, 600_000n, 600_000n))

      expect(await indexer.Policy.getOrThrow('1')).toEqual({
        id: '1',
        holder_id: ALICE,
        cell_id: LISBON.toString(),
        key: LISBON,
        cellId: (2574n << 32n) | 3417n,
        triggerId: 1n,
        start: T0 + 600,
        end: T0 + 1_200,
        ratePerSecond: 1_000n,
        premium: 60_000n,
        fee: 3_000n,
        maxPayout: 600_000n,
        paid: 0n,
        settledUntil: T0 + 600,
        status: 'OPEN',
        boughtAt: T0,
        boughtTxHash: hash,
        closedAt: undefined,
        chainId: CHAIN_ID,
      })
      expect(await indexer.Holder.getOrThrow(ALICE)).toMatchObject({
        policyCount: 1,
        openPolicies: 1,
        totalPremiums: 60_000n,
        totalPaid: 0n,
        firstPolicyAt: T0,
        lastActivityAt: T0,
      })
      expect(await indexer.Cell.getOrThrow(LISBON.toString())).toMatchObject({
        latIndex: 2574,
        lonIndex: 3417,
        lat: 38.725,
        lon: -9.125,
        exposure: 600_000n,
        openPolicies: 1,
        policyCount: 1,
        totalPremiums: 60_000n,
        totalPaid: 0n,
      })
      expect(await indexer.PoolState.getOrThrow('pool')).toMatchObject({
        lockedExposure: 600_000n,
        policyCount: 1,
        openPolicies: 1,
        holderCount: 1,
        activeCells: 1,
        totalPremiums: 60_000n,
        totalFees: 3_000n,
        totalPayouts: 0n,
        lossRatio: 0,
        updatedAt: T0,
      })
    })

    it('counts a returning holder and a busy cell once', async () => {
      const { indexer, mine } = await startChain()
      await mine(T0, bought(tenMinutes()))
      await mine(T0 + 60, bought(tenMinutes({ id: 2n, premium: 45_000n })))
      await mine(T0 + 120, bought(tenMinutes({ id: 3n, holder: BOB, key: NEW_YORK })))

      expect(await indexer.Holder.getOrThrow(ALICE)).toMatchObject({
        policyCount: 2,
        openPolicies: 2,
        totalPremiums: 105_000n,
        firstPolicyAt: T0,
        lastActivityAt: T0 + 60,
      })
      expect(await indexer.Cell.getOrThrow(LISBON.toString())).toMatchObject({ policyCount: 2, openPolicies: 2 })
      expect(await indexer.PoolState.getOrThrow('pool')).toMatchObject({
        policyCount: 3,
        openPolicies: 3,
        holderCount: 2,
        activeCells: 2,
      })
    })

    it('takes the fee in force when the policy is bought', async () => {
      const { indexer, mine } = await startChain()
      await mine(T0, bought(tenMinutes()))
      await mine(T0 + 60, feeSet(1_000n))
      await mine(T0 + 120, bought(tenMinutes({ id: 2n })))

      expect((await indexer.Policy.getOrThrow('1')).fee).toBe(3_000n)
      expect((await indexer.Policy.getOrThrow('2')).fee).toBe(6_000n)
      expect(await indexer.PoolState.getOrThrow('pool')).toMatchObject({ feeBps: 1_000, totalFees: 9_000n })
    })

    it('accepts a key that is not on the grid', async () => {
      const { indexer, mine } = await startChain()
      const offGrid = (1n << 64n) | (3_600n << 32n)
      await mine(T0, bought(tenMinutes({ key: offGrid })))

      const cell = await indexer.Cell.getOrThrow(offGrid.toString())
      expect(cell).toMatchObject({ triggerId: 1n, cellId: 3_600n << 32n, openPolicies: 1 })
      expect([cell.latIndex, cell.lonIndex, cell.lat, cell.lon]).toEqual([undefined, undefined, undefined, undefined])
    })
  })

  describe('a settlement', () => {
    it('pays a wet report in part, then closes the policy once its window is settled', async () => {
      const { indexer, mine } = await startChain()
      const policy = tenMinutes()
      const halfway = policy.start + 300
      await mine(T0, bought(policy), exposureChanged(LISBON, 600_000n, 600_000n))

      const report = await mine(
        halfway + 20,
        weatherReported(LISBON, policy.start, halfway, 120, 120n),
        heartbeat(halfway + 10),
      )
      const partial = await mine(
        halfway + 40,
        settled(policy, 120_000n, halfway, false),
        exposureChanged(LISBON, 480_000n, 480_000n),
      )

      expect(await indexer.Policy.getOrThrow('1')).toMatchObject({
        paid: 120_000n,
        settledUntil: halfway,
        status: 'OPEN',
        closedAt: undefined,
      })
      expect(await indexer.Cell.getOrThrow(LISBON.toString())).toMatchObject({
        exposure: 480_000n,
        openPolicies: 1,
        totalPaid: 120_000n,
        wetSeconds: 120n,
        lastWetAt: halfway,
        lastReadingAt: halfway,
      })
      expect(await indexer.PoolState.getOrThrow('pool')).toMatchObject({
        lockedExposure: 480_000n,
        lastHeartbeat: halfway + 10,
        openPolicies: 1,
        activeCells: 1,
        settlementCount: 1,
        readingCount: 1,
        totalPayouts: 120_000n,
        lossRatio: 2,
      })

      await mine(policy.end + 20, weatherReported(LISBON, halfway, policy.end, 0, 120n), heartbeat(policy.end + 10))
      const closing = await mine(
        policy.end + 40,
        settled(policy, 0n, policy.end, true),
        exposureChanged(LISBON, 0n, 0n),
      )

      expect(await indexer.Policy.getOrThrow('1')).toMatchObject({
        paid: 120_000n,
        settledUntil: policy.end,
        status: 'SETTLED',
        closedAt: policy.end + 40,
      })
      expect(await indexer.Settlement.getOrThrow(`${partial}-0`)).toEqual({
        id: `${partial}-0`,
        policy_id: '1',
        holder_id: ALICE,
        cell_id: LISBON.toString(),
        amount: 120_000n,
        settledUntil: halfway,
        closed: false,
        txHash: partial,
        timestamp: halfway + 40,
        chainId: CHAIN_ID,
      })
      expect(await indexer.Settlement.getOrThrow(`${closing}-0`)).toMatchObject({
        amount: 0n,
        settledUntil: policy.end,
        closed: true,
        timestamp: policy.end + 40,
      })
      expect(await indexer.WeatherReading.getOrThrow(`${report}-0`)).toEqual({
        id: `${report}-0`,
        cell_id: LISBON.toString(),
        key: LISBON,
        from: policy.start,
        to: halfway,
        wetSeconds: 120,
        cumulative: 120n,
        txHash: report,
        timestamp: halfway + 20,
        chainId: CHAIN_ID,
      })
      expect(await indexer.Holder.getOrThrow(ALICE)).toMatchObject({
        openPolicies: 0,
        totalPaid: 120_000n,
        lastActivityAt: policy.end + 40,
      })
      expect(await indexer.Cell.getOrThrow(LISBON.toString())).toMatchObject({
        exposure: 0n,
        openPolicies: 0,
        totalPaid: 120_000n,
        wetSeconds: 120n,
        lastWetAt: halfway,
        lastReadingAt: policy.end,
      })
      expect(await indexer.PoolState.getOrThrow('pool')).toMatchObject({
        lockedExposure: 0n,
        lastHeartbeat: policy.end + 10,
        policyCount: 1,
        openPolicies: 0,
        activeCells: 0,
        settlementCount: 2,
        readingCount: 2,
        totalPayouts: 120_000n,
        lossRatio: 2,
      })
    })

    it('marks a policy closed before the end of its window as expired', async () => {
      const { indexer, mine } = await startChain()
      const policy = tenMinutes()
      await mine(T0, bought(policy), exposureChanged(LISBON, 600_000n, 600_000n))
      await mine(policy.end + DAY, settled(policy, 0n, policy.start, true), exposureChanged(LISBON, 0n, 0n))

      expect(await indexer.Policy.getOrThrow('1')).toMatchObject({
        paid: 0n,
        settledUntil: policy.start,
        status: 'EXPIRED',
        closedAt: policy.end + DAY,
      })
    })

    it('keeps a cell active until its last policy closes', async () => {
      const { indexer, mine } = await startChain()
      const first = tenMinutes()
      const second = tenMinutes({ id: 2n, holder: BOB })
      await mine(T0, bought(first))
      await mine(T0 + 60, bought(second))

      await mine(first.end + 60, settled(first, 0n, first.end, true))
      expect(await indexer.Cell.getOrThrow(LISBON.toString())).toMatchObject({ openPolicies: 1 })
      expect(await indexer.PoolState.getOrThrow('pool')).toMatchObject({ openPolicies: 1, activeCells: 1 })

      await mine(second.end + 120, settled(second, 0n, second.end, true))
      expect(await indexer.Cell.getOrThrow(LISBON.toString())).toMatchObject({ openPolicies: 0 })
      expect(await indexer.PoolState.getOrThrow('pool')).toMatchObject({ openPolicies: 0, activeCells: 0 })
    })

    it('refuses a settlement of a policy it never saw bought', async () => {
      const { mine } = await startChain()
      await expect(mine(T0, settled(tenMinutes(), 0n, T0 + 600, false))).rejects.toThrow()
    })
  })

  describe('a weather report', () => {
    it('remembers the last wet reading through the dry ones', async () => {
      const { indexer, mine } = await startChain()
      await mine(T0 + 300, weatherReported(NEW_YORK, T0, T0 + 300, 300, 300n))
      await mine(T0 + 600, weatherReported(NEW_YORK, T0 + 300, T0 + 600, 0, 300n))
      await mine(T0 + 900, weatherReported(NEW_YORK, T0 + 600, T0 + 900, 0, 300n))

      expect(await indexer.Cell.getOrThrow(NEW_YORK.toString())).toMatchObject({
        latIndex: 2614,
        lonIndex: 2119,
        wetSeconds: 300n,
        lastWetAt: T0 + 300,
        lastReadingAt: T0 + 900,
        openPolicies: 0,
      })
      expect(await indexer.WeatherReading.getAll()).toHaveLength(3)
      expect(await indexer.PoolState.getOrThrow('pool')).toMatchObject({ readingCount: 3 })
    })

    it('moves the heartbeat even when nothing was read', async () => {
      const { indexer, mine } = await startChain()
      await mine(T0 + 5, heartbeat(T0))

      expect(await indexer.PoolState.getOrThrow('pool')).toMatchObject({
        lastHeartbeat: T0,
        readingCount: 0,
        updatedAt: T0 + 5,
      })
    })
  })

  describe('exposure', () => {
    it('follows the pool for each cell and in total', async () => {
      const { indexer, mine } = await startChain()
      await mine(T0, exposureChanged(LISBON, 600_000n, 600_000n))
      await mine(T0 + 1, exposureChanged(NEW_YORK, 250_000n, 850_000n))
      await mine(T0 + 2, exposureChanged(LISBON, 480_000n, 730_000n))

      expect((await indexer.Cell.getOrThrow(LISBON.toString())).exposure).toBe(480_000n)
      expect((await indexer.Cell.getOrThrow(NEW_YORK.toString())).exposure).toBe(250_000n)
      expect(await indexer.PoolState.getOrThrow('pool')).toMatchObject({ lockedExposure: 730_000n, updatedAt: T0 + 2 })
    })
  })

  describe('liquidity', () => {
    const SHARE = 1_000_000_000_000n

    it('records a deposit', async () => {
      const { indexer, mine } = await startChain()
      await mine(T0, deposited(BOB, 1_000_000_000n, 1_000n * SHARE))
      await mine(T0 + 60, deposited(ALICE, 250_000_000n, 250n * SHARE))

      expect(await indexer.PoolState.getOrThrow('pool')).toMatchObject({ totalDeposits: 1_250_000_000n })
      expect(await indexer.PoolDay.getOrThrow('2026-10-12')).toMatchObject({ deposits: 1_250_000_000n })
    })

    it('opens a redemption request that matures after the notice', async () => {
      const { indexer, mine } = await startChain()
      const hash = await mine(T0, redeemRequested(BOB, 400n * SHARE))

      expect(await indexer.RedeemRequest.getOrThrow(BOB)).toEqual({
        id: BOB,
        owner: BOB,
        shares: 400n * SHARE,
        claimedShares: 0n,
        claimedAssets: 0n,
        requestedAt: T0,
        claimableAt: T0 + NOTICE,
        lastPolicyAtRequest: 0n,
        surplus: 0n,
        status: 'OPEN',
        closedAt: undefined,
        txHash: hash,
        chainId: CHAIN_ID,
      })
      expect(await indexer.PoolState.getOrThrow('pool')).toMatchObject({
        escrowedShares: 400n * SHARE,
        openRedeemRequests: 1,
      })
    })

    it('restarts the notice for the whole request when shares are added', async () => {
      const { indexer, mine } = await startChain()
      await mine(T0, redeemRequested(BOB, 400n * SHARE))
      await mine(T0 + HOUR, redeemRequested(BOB, 100n * SHARE))

      expect(await indexer.RedeemRequest.getOrThrow(BOB)).toMatchObject({
        shares: 500n * SHARE,
        requestedAt: T0 + HOUR,
        claimableAt: T0 + HOUR + NOTICE,
        status: 'OPEN',
      })
      expect(await indexer.PoolState.getOrThrow('pool')).toMatchObject({
        escrowedShares: 500n * SHARE,
        openRedeemRequests: 1,
      })
    })

    it('uses the notice in force when the request is made', async () => {
      const { indexer, mine } = await startChain()
      await mine(T0, redeemNoticeSet(BigInt(2 * HOUR)))
      await mine(T0 + 60, redeemRequested(BOB, 400n * SHARE))

      expect((await indexer.RedeemRequest.getOrThrow(BOB)).claimableAt).toBe(T0 + 60 + 2 * HOUR)
      expect((await indexer.PoolState.getOrThrow('pool')).redeemNotice).toBe(2 * HOUR)
    })

    it('closes the request when its last share is claimed', async () => {
      const { indexer, mine } = await startChain()
      const matured = T0 + NOTICE
      await mine(T0, redeemRequested(BOB, 400n * SHARE))

      await mine(matured, withdrawn(BOB, 100_000_000n, 100n * SHARE))
      expect(await indexer.RedeemRequest.getOrThrow(BOB)).toMatchObject({
        shares: 300n * SHARE,
        claimedShares: 100n * SHARE,
        claimedAssets: 100_000_000n,
        status: 'OPEN',
        closedAt: undefined,
      })
      expect(await indexer.PoolState.getOrThrow('pool')).toMatchObject({
        totalWithdrawals: 100_000_000n,
        escrowedShares: 300n * SHARE,
        openRedeemRequests: 1,
      })

      await mine(matured + 60, withdrawn(BOB, 299_000_000n, 300n * SHARE))
      expect(await indexer.RedeemRequest.getOrThrow(BOB)).toMatchObject({
        shares: 0n,
        claimedShares: 400n * SHARE,
        claimedAssets: 399_000_000n,
        status: 'CLAIMED',
        closedAt: matured + 60,
      })
      expect(await indexer.PoolState.getOrThrow('pool')).toMatchObject({
        totalWithdrawals: 399_000_000n,
        escrowedShares: 0n,
        openRedeemRequests: 0,
      })
    })

    it('remembers the cover a request waits for: every policy bought before it', async () => {
      const { indexer, mine } = await startChain()
      await mine(T0, bought(tenMinutes()))
      await mine(T0 + 60, bought(tenMinutes({ id: 2n })), redeemRequested(BOB, 400n * SHARE))
      expect((await indexer.RedeemRequest.getOrThrow(BOB)).lastPolicyAtRequest).toBe(2n)

      await mine(T0 + 120, bought(tenMinutes({ id: 3n })))
      expect((await indexer.RedeemRequest.getOrThrow(BOB)).lastPolicyAtRequest).toBe(2n)

      // Adding to the request makes all of it wait for the cover sold until then.
      await mine(T0 + 180, redeemRequested(BOB, 100n * SHARE))
      expect((await indexer.RedeemRequest.getOrThrow(BOB)).lastPolicyAtRequest).toBe(3n)
    })

    it('counts what a capped claim sends to the treasury, for the request, the day and the pool', async () => {
      const { indexer, mine } = await startChain()
      const matured = T0 + NOTICE
      await mine(T0, redeemRequested(BOB, 400n * SHARE))
      await mine(matured, withdrawn(BOB, 400_000_000n, 400n * SHARE), surplusToTreasury(BOB, TREASURY, 7_000n))

      expect(await indexer.RedeemRequest.getOrThrow(BOB)).toMatchObject({
        status: 'CLAIMED',
        claimedAssets: 400_000_000n,
        surplus: 7_000n,
      })
      expect((await indexer.PoolDay.getOrThrow('2026-10-12')).surplus).toBe(7_000n)
      expect(await indexer.PoolState.getOrThrow('pool')).toMatchObject({
        totalWithdrawals: 400_000_000n,
        totalSurplus: 7_000n,
      })

      // A new request starts its own count.
      await mine(matured + HOUR, redeemRequested(BOB, 10n * SHARE))
      expect((await indexer.RedeemRequest.getOrThrow(BOB)).surplus).toBe(0n)
    })

    it('returns the shares on a cancellation and starts over on the next request', async () => {
      const { indexer, mine } = await startChain()
      await mine(T0, redeemRequested(BOB, 400n * SHARE))
      await mine(T0 + HOUR, redeemRequestCancelled(BOB, 400n * SHARE))

      expect(await indexer.RedeemRequest.getOrThrow(BOB)).toMatchObject({
        shares: 0n,
        status: 'CANCELLED',
        closedAt: T0 + HOUR,
      })
      expect(await indexer.PoolState.getOrThrow('pool')).toMatchObject({ escrowedShares: 0n, openRedeemRequests: 0 })

      await mine(T0 + 2 * HOUR, redeemRequested(BOB, 50n * SHARE))
      expect(await indexer.RedeemRequest.getOrThrow(BOB)).toMatchObject({
        shares: 50n * SHARE,
        claimedShares: 0n,
        requestedAt: T0 + 2 * HOUR,
        claimableAt: T0 + 2 * HOUR + NOTICE,
        status: 'OPEN',
        closedAt: undefined,
      })
      expect(await indexer.PoolState.getOrThrow('pool')).toMatchObject({
        escrowedShares: 50n * SHARE,
        openRedeemRequests: 1,
      })
    })
  })

  describe('deferred payouts', () => {
    it('holds what the token refused for the holder until it is claimed', async () => {
      const { indexer, mine } = await startChain()
      const policy = tenMinutes()
      await mine(T0, bought(policy), exposureChanged(LISBON, 600_000n, 600_000n))
      await mine(
        policy.end + 60,
        settled(policy, 120_000n, policy.end, true),
        exposureChanged(LISBON, 480_000n, 480_000n),
        payoutDeferred(ALICE, 120_000n),
        exposureChanged(LISBON, 0n, 0n),
      )

      expect(await indexer.Holder.getOrThrow(ALICE)).toMatchObject({ totalPaid: 120_000n, deferred: 120_000n })
      expect(await indexer.PoolState.getOrThrow('pool')).toMatchObject({
        totalPayouts: 120_000n,
        totalDeferred: 120_000n,
      })

      await mine(policy.end + HOUR, deferredClaimed(ALICE, 120_000n))
      expect(await indexer.Holder.getOrThrow(ALICE)).toMatchObject({ totalPaid: 120_000n, deferred: 0n })
      expect(await indexer.PoolState.getOrThrow('pool')).toMatchObject({ totalPayouts: 120_000n, totalDeferred: 0n })
    })
  })

  describe('served areas', () => {
    it('marks the cells the owner serves and counts them', async () => {
      const { indexer, mine } = await startChain()
      await mine(T0, servedSet(LISBON, true), servedSet(NEW_YORK, true), servedOnlySet(true))

      expect(await indexer.Cell.getOrThrow(LISBON.toString())).toMatchObject({
        served: true,
        lat: 38.725,
        lon: -9.125,
        openPolicies: 0,
      })
      expect(await indexer.PoolState.getOrThrow('pool')).toMatchObject({ servedOnly: true, servedCells: 2 })

      await mine(T0 + 60, servedSet(NEW_YORK, false), servedOnlySet(false))
      expect((await indexer.Cell.getOrThrow(NEW_YORK.toString())).served).toBe(false)
      expect(await indexer.PoolState.getOrThrow('pool')).toMatchObject({ servedOnly: false, servedCells: 1 })
    })

    it('keeps the open cover of a cell that stops being served', async () => {
      const { indexer, mine } = await startChain()
      await mine(T0, servedSet(LISBON, true), bought(tenMinutes()))
      await mine(T0 + 60, servedSet(LISBON, false))

      expect(await indexer.Cell.getOrThrow(LISBON.toString())).toMatchObject({ served: false, openPolicies: 1 })
    })

    it('starts every cell unserved', async () => {
      const { indexer, mine } = await startChain()
      await mine(T0, bought(tenMinutes()))

      expect((await indexer.Cell.getOrThrow(LISBON.toString())).served).toBe(false)
      expect(await indexer.PoolState.getOrThrow('pool')).toMatchObject({ servedOnly: false, servedCells: 0 })
    })
  })

  describe('the treasury and recoveries', () => {
    it('follows the pool treasury', async () => {
      const { indexer, mine } = await startChain()
      await mine(T0, treasurySet(TREASURY))
      expect((await indexer.PoolState.getOrThrow('pool')).treasury).toBe(TREASURY)

      await mine(T0 + 60, treasurySet(BOB))
      expect((await indexer.PoolState.getOrThrow('pool')).treasury).toBe(BOB)
    })

    it('sets aside a surplus the token refused the treasury, like a payout', async () => {
      const { indexer, mine } = await startChain()
      await mine(T0, redeemRequested(BOB, 400n * SHARE_UNIT))
      await mine(
        T0 + NOTICE,
        withdrawn(BOB, 400_000_000n, 400n * SHARE_UNIT),
        surplusToTreasury(BOB, TREASURY, 7_000n),
        payoutDeferred(TREASURY, 7_000n),
      )

      expect(await indexer.PoolState.getOrThrow('pool')).toMatchObject({ totalSurplus: 7_000n, totalDeferred: 7_000n })
      expect((await indexer.Holder.getOrThrow(TREASURY)).deferred).toBe(7_000n)
    })

    it('records tokens and shares the owner sent back', async () => {
      const { indexer, mine } = await startChain()
      const book = await mine(T0, rescued(ALICE, BOB, 5_000n))
      const pool = await mine(T0 + 60, sharesRescued(BOB, 3n * SHARE_UNIT))

      expect(await indexer.Recovery.getOrThrow(`${book}-0`)).toEqual({
        id: `${book}-0`,
        contract: 'CoverBook',
        token: ALICE,
        to: BOB,
        amount: 5_000n,
        txHash: book,
        timestamp: T0,
        chainId: CHAIN_ID,
      })
      expect(await indexer.Recovery.getOrThrow(`${pool}-0`)).toMatchObject({
        contract: 'CoverPool',
        token: COVER_POOL,
        to: BOB,
        amount: 3n * SHARE_UNIT,
        timestamp: T0 + 60,
      })
    })
  })

  describe('the daily roll-up', () => {
    it('splits premiums, fees, payouts and liquidity by UTC day', async () => {
      const { indexer, mine } = await startChain()
      const first = tenMinutes()
      const second = tenMinutes({
        id: 2n,
        holder: BOB,
        key: NEW_YORK,
        start: OCT_13 + 600,
        end: OCT_13 + 1_200,
        premium: 40_000n,
      })

      await mine(T0, bought(first))
      await mine(T0 + 60, deposited(BOB, 5_000_000n, 5_000_000_000_000n))
      await mine(first.end + 60, settled(first, 90_000n, first.end, true))

      await mine(OCT_13 + 30, bought(second))
      await mine(OCT_13 + 60, redeemRequested(BOB, 2_000_000_000_000n))
      await mine(OCT_13 + 120, withdrawn(BOB, 2_000_000n, 2_000_000_000_000n))

      await mine(OCT_14 + 10, settled(second, 30_000n, second.end, true))

      const days = (await indexer.PoolDay.getAll()).sort((a, b) => a.startsAt - b.startsAt)
      expect(days).toEqual([
        {
          id: '2026-10-12',
          startsAt: OCT_12,
          premiums: 60_000n,
          fees: 3_000n,
          payouts: 90_000n,
          deposits: 5_000_000n,
          withdrawals: 0n,
          surplus: 0n,
          policiesBought: 1,
          settlements: 1,
          lossRatio: 1.5,
          chainId: CHAIN_ID,
        },
        {
          id: '2026-10-13',
          startsAt: OCT_13,
          premiums: 40_000n,
          fees: 2_000n,
          payouts: 0n,
          deposits: 0n,
          withdrawals: 2_000_000n,
          surplus: 0n,
          policiesBought: 1,
          settlements: 0,
          lossRatio: 0,
          chainId: CHAIN_ID,
        },
        {
          id: '2026-10-14',
          startsAt: OCT_14,
          premiums: 0n,
          fees: 0n,
          payouts: 30_000n,
          deposits: 0n,
          withdrawals: 0n,
          surplus: 0n,
          policiesBought: 0,
          settlements: 1,
          lossRatio: undefined,
          chainId: CHAIN_ID,
        },
      ])
      expect(await indexer.PoolState.getOrThrow('pool')).toMatchObject({
        totalPremiums: 100_000n,
        totalFees: 5_000n,
        totalPayouts: 120_000n,
        totalDeposits: 5_000_000n,
        totalWithdrawals: 2_000_000n,
        lossRatio: 1.2,
      })
    })

    it('turns the day at midnight UTC', async () => {
      const { indexer, mine } = await startChain()
      await mine(OCT_13 - 1, deposited(BOB, 1n, 1n))
      await mine(OCT_13, deposited(BOB, 2n, 2n))

      expect((await indexer.PoolDay.getOrThrow('2026-10-12')).deposits).toBe(1n)
      expect((await indexer.PoolDay.getOrThrow('2026-10-13')).deposits).toBe(2n)
    })
  })
})
