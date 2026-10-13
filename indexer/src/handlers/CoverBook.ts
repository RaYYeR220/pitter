import { indexer } from 'envio'
import { feeOf, loadCell, loadDay, loadHolder, loadPool, lossRatio } from '../entities'

indexer.onEvent({ contract: 'CoverBook', event: 'PolicyBought' }, async ({ event, context }) => {
  const { id, holder, key, ratePerSecond, premium, maxPayout } = event.params
  const start = Number(event.params.start)
  const end = Number(event.params.end)
  const now = event.block.timestamp

  const [pool, day, cell, account] = await Promise.all([
    loadPool(context),
    loadDay(context, now),
    loadCell(context, key),
    loadHolder(context, holder, now),
  ])
  const fee = feeOf(premium, pool.feeBps)

  context.Policy.set({
    id: id.toString(),
    holder_id: account.id,
    cell_id: cell.id,
    key,
    cellId: cell.cellId,
    triggerId: cell.triggerId,
    start,
    end,
    ratePerSecond,
    premium,
    fee,
    maxPayout,
    paid: 0n,
    settledUntil: start,
    status: 'OPEN',
    boughtAt: now,
    boughtTxHash: event.transaction.hash,
    closedAt: undefined,
  })

  context.Holder.set({
    ...account,
    policyCount: account.policyCount + 1,
    openPolicies: account.openPolicies + 1,
    totalPremiums: account.totalPremiums + premium,
    firstPolicyAt: account.firstPolicyAt ?? now,
    lastActivityAt: now,
  })

  context.Cell.set({
    ...cell,
    policyCount: cell.policyCount + 1,
    openPolicies: cell.openPolicies + 1,
    totalPremiums: cell.totalPremiums + premium,
  })

  const dayPremiums = day.premiums + premium
  context.PoolDay.set({
    ...day,
    premiums: dayPremiums,
    fees: day.fees + fee,
    policiesBought: day.policiesBought + 1,
    lossRatio: lossRatio(day.payouts, dayPremiums),
  })

  const totalPremiums = pool.totalPremiums + premium
  context.PoolState.set({
    ...pool,
    policyCount: pool.policyCount + 1,
    openPolicies: pool.openPolicies + 1,
    holderCount: pool.holderCount + (account.policyCount === 0 ? 1 : 0),
    activeCells: pool.activeCells + (cell.openPolicies === 0 ? 1 : 0),
    totalPremiums,
    totalFees: pool.totalFees + fee,
    lossRatio: lossRatio(pool.totalPayouts, totalPremiums),
    updatedAt: now,
  })
})

indexer.onEvent({ contract: 'CoverBook', event: 'PolicySettled' }, async ({ event, context }) => {
  const { id, paid, closed } = event.params
  const settledUntil = Number(event.params.settledUntil)
  const now = event.block.timestamp

  const policy = await context.Policy.getOrThrow(id.toString())
  const [pool, day, cell, account] = await Promise.all([
    loadPool(context),
    loadDay(context, now),
    loadCell(context, policy.key),
    loadHolder(context, policy.holder_id, now),
  ])
  const closing = closed ? 1 : 0

  context.Settlement.set({
    id: `${event.transaction.hash}-${event.logIndex}`,
    policy_id: policy.id,
    holder_id: account.id,
    cell_id: cell.id,
    amount: paid,
    settledUntil,
    closed,
    txHash: event.transaction.hash,
    timestamp: now,
  })

  context.Policy.set({
    ...policy,
    paid: policy.paid + paid,
    settledUntil,
    status: closed ? (settledUntil === policy.end ? 'SETTLED' : 'EXPIRED') : 'OPEN',
    closedAt: closed ? now : undefined,
  })

  context.Holder.set({
    ...account,
    openPolicies: account.openPolicies - closing,
    totalPaid: account.totalPaid + paid,
    lastActivityAt: now,
  })

  const cellOpenPolicies = cell.openPolicies - closing
  context.Cell.set({ ...cell, openPolicies: cellOpenPolicies, totalPaid: cell.totalPaid + paid })

  const dayPayouts = day.payouts + paid
  context.PoolDay.set({
    ...day,
    payouts: dayPayouts,
    settlements: day.settlements + 1,
    lossRatio: lossRatio(dayPayouts, day.premiums),
  })

  const totalPayouts = pool.totalPayouts + paid
  context.PoolState.set({
    ...pool,
    openPolicies: pool.openPolicies - closing,
    activeCells: pool.activeCells - (closed && cellOpenPolicies === 0 ? 1 : 0),
    settlementCount: pool.settlementCount + 1,
    totalPayouts,
    lossRatio: lossRatio(totalPayouts, pool.totalPremiums),
    updatedAt: now,
  })
})

indexer.onEvent({ contract: 'CoverBook', event: 'FeeSet' }, async ({ event, context }) => {
  const pool = await loadPool(context)
  context.PoolState.set({ ...pool, feeBps: Number(event.params.feeBps), updatedAt: event.block.timestamp })
})

// The book emits `ServedSet` only when a key's mark actually changes.
indexer.onEvent({ contract: 'CoverBook', event: 'ServedSet' }, async ({ event, context }) => {
  const { key, served } = event.params
  const [pool, cell] = await Promise.all([loadPool(context), loadCell(context, key)])
  const change = cell.served === served ? 0 : served ? 1 : -1

  context.Cell.set({ ...cell, served })
  context.PoolState.set({ ...pool, servedCells: pool.servedCells + change, updatedAt: event.block.timestamp })
})

indexer.onEvent({ contract: 'CoverBook', event: 'ServedOnlySet' }, async ({ event, context }) => {
  const pool = await loadPool(context)
  context.PoolState.set({ ...pool, servedOnly: event.params.servedOnly, updatedAt: event.block.timestamp })
})

indexer.onEvent({ contract: 'CoverBook', event: 'Rescued' }, async ({ event, context }) => {
  const { token, to, amount } = event.params
  context.Recovery.set({
    id: `${event.transaction.hash}-${event.logIndex}`,
    contract: 'CoverBook',
    token,
    to,
    amount,
    txHash: event.transaction.hash,
    timestamp: event.block.timestamp,
  })
})
