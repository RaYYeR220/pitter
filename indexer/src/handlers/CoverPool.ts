import { indexer } from 'envio'
import { loadCell, loadDay, loadHolder, loadPool } from '../entities'

indexer.onEvent({ contract: 'CoverPool', event: 'ExposureChanged' }, async ({ event, context }) => {
  const { key, cellExposure, lockedExposure } = event.params
  const [pool, cell] = await Promise.all([loadPool(context), loadCell(context, key)])

  context.Cell.set({ ...cell, exposure: cellExposure })
  context.PoolState.set({ ...pool, lockedExposure, updatedAt: event.block.timestamp })
})

indexer.onEvent({ contract: 'CoverPool', event: 'Deposit' }, async ({ event, context }) => {
  const { assets } = event.params
  const now = event.block.timestamp
  const [pool, day] = await Promise.all([loadPool(context), loadDay(context, now)])

  context.PoolDay.set({ ...day, deposits: day.deposits + assets })
  context.PoolState.set({ ...pool, totalDeposits: pool.totalDeposits + assets, updatedAt: now })
})

indexer.onEvent({ contract: 'CoverPool', event: 'RedeemRequest' }, async ({ event, context }) => {
  const { controller, owner, shares } = event.params
  const now = event.block.timestamp
  const [pool, previous] = await Promise.all([loadPool(context), context.RedeemRequest.get(controller)])
  const current = previous?.status === 'OPEN' ? previous : undefined

  context.RedeemRequest.set({
    id: controller,
    owner,
    shares: (current?.shares ?? 0n) + shares,
    claimedShares: current?.claimedShares ?? 0n,
    claimedAssets: current?.claimedAssets ?? 0n,
    requestedAt: now,
    claimableAt: now + pool.redeemNotice,
    status: 'OPEN',
    closedAt: undefined,
    txHash: event.transaction.hash,
  })

  context.PoolState.set({
    ...pool,
    escrowedShares: pool.escrowedShares + shares,
    openRedeemRequests: pool.openRedeemRequests + (current ? 0 : 1),
    updatedAt: now,
  })
})

indexer.onEvent({ contract: 'CoverPool', event: 'RedeemRequestCancelled' }, async ({ event, context }) => {
  const { controller, shares } = event.params
  const now = event.block.timestamp
  const [pool, request] = await Promise.all([loadPool(context), context.RedeemRequest.getOrThrow(controller)])

  context.RedeemRequest.set({
    ...request,
    shares: 0n,
    status: 'CANCELLED',
    closedAt: now,
    txHash: event.transaction.hash,
  })

  context.PoolState.set({
    ...pool,
    escrowedShares: pool.escrowedShares - shares,
    openRedeemRequests: pool.openRedeemRequests - 1,
    updatedAt: now,
  })
})

indexer.onEvent({ contract: 'CoverPool', event: 'Withdraw' }, async ({ event, context }) => {
  const { owner: controller, assets, shares } = event.params
  const now = event.block.timestamp
  const [pool, day, request] = await Promise.all([
    loadPool(context),
    loadDay(context, now),
    context.RedeemRequest.getOrThrow(controller),
  ])
  const remaining = request.shares - shares
  const claimed = remaining === 0n

  context.RedeemRequest.set({
    ...request,
    shares: remaining,
    claimedShares: request.claimedShares + shares,
    claimedAssets: request.claimedAssets + assets,
    status: claimed ? 'CLAIMED' : 'OPEN',
    closedAt: claimed ? now : undefined,
    txHash: event.transaction.hash,
  })

  context.PoolDay.set({ ...day, withdrawals: day.withdrawals + assets })

  context.PoolState.set({
    ...pool,
    totalWithdrawals: pool.totalWithdrawals + assets,
    escrowedShares: pool.escrowedShares - shares,
    openRedeemRequests: pool.openRedeemRequests - (claimed ? 1 : 0),
    updatedAt: now,
  })
})

indexer.onEvent({ contract: 'CoverPool', event: 'RedeemNoticeSet' }, async ({ event, context }) => {
  const pool = await loadPool(context)
  context.PoolState.set({ ...pool, redeemNotice: Number(event.params.notice), updatedAt: event.block.timestamp })
})

indexer.onEvent({ contract: 'CoverPool', event: 'PayoutDeferred' }, async ({ event, context }) => {
  const { to, amount } = event.params
  const now = event.block.timestamp
  const [pool, account] = await Promise.all([loadPool(context), loadHolder(context, to, now)])

  context.Holder.set({ ...account, deferred: account.deferred + amount, lastActivityAt: now })
  context.PoolState.set({ ...pool, totalDeferred: pool.totalDeferred + amount, updatedAt: now })
})

indexer.onEvent({ contract: 'CoverPool', event: 'DeferredClaimed' }, async ({ event, context }) => {
  const { to, amount } = event.params
  const now = event.block.timestamp
  const [pool, account] = await Promise.all([loadPool(context), loadHolder(context, to, now)])

  context.Holder.set({ ...account, deferred: account.deferred - amount, lastActivityAt: now })
  context.PoolState.set({ ...pool, totalDeferred: pool.totalDeferred - amount, updatedAt: now })
})
