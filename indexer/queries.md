# Queries

The GraphQL queries the app runs against the indexer. They work unchanged against a local run
(`http://localhost:8080/v1/graphql`) and against Envio Cloud (`https://<your-endpoint>/v1/graphql`); neither needs
a key for reading.

## Conventions

- **Chain.** Every row carries `chainId` (`10143` Monad testnet, `143` Monad mainnet). An id is unique within a
  chain only, so filter lists by `chainId` and pass it to `*_by_pk`.
- **Addresses** are lowercase, in ids and in fields. Lowercase an address before using it as a variable.
- **Amounts** are token base units (six decimals for the dollar token, twelve for pool shares) and arrive as
  decimal strings. The same goes for `key`, `cellId` and `triggerId`.
- **Times and counts** are integers and arrive as numbers. Times are unix seconds.
- **Fractions** (`lat`, `lon`, `lossRatio`) arrive as strings such as `"38.725"`; pass them through `Number()`.
- **A cell's id** is its weather index key as a decimal string: `((triggerId << 64) | cellId).toString()`.
- **Totals are stored, not computed.** Envio Cloud does not expose `_aggregate` fields, so counts and sums live
  in `PoolState`, `PoolDay`, `Holder` and `Cell`.
- **Page anything that can grow** with `limit` and `offset`; an endpoint may cap the rows of one response.
- **Live updates.** Every root field below can also be read as a `subscription`, one field per subscription,
  over `wss://` on the same path.

## A holder's cover history, with payouts

`HolderCover` returns the holder's totals and their policies, newest first, each with its cell and the
settlements that paid it. `paid` on a policy is the sum of its settlements' `amount`.

```graphql
query HolderCover($chainId: Int!, $holder: String!, $limit: Int = 25, $offset: Int = 0) {
  Holder_by_pk(chainId: $chainId, id: $holder) {
    policyCount
    openPolicies
    totalPremiums
    totalPaid
    deferred
    firstPolicyAt
    lastActivityAt
  }
  Policy(
    where: { chainId: { _eq: $chainId }, holder_id: { _eq: $holder } }
    order_by: [{ boughtAt: desc }, { id: desc }]
    limit: $limit
    offset: $offset
  ) {
    id
    status
    start
    end
    ratePerSecond
    premium
    fee
    maxPayout
    paid
    settledUntil
    boughtAt
    boughtTxHash
    closedAt
    cell {
      id
      lat
      lon
      lastWetAt
      lastReadingAt
    }
    settlements(order_by: { timestamp: asc }) {
      id
      amount
      settledUntil
      closed
      txHash
      timestamp
    }
  }
}
```

```json
{ "chainId": 10143, "holder": "0x00000000000000000000000000000000000a11ce" }
```

`status` is `OPEN`, `SETTLED` (closed with the whole window settled) or `EXPIRED` (closed after the grace period
with part of the window never reported). Whether an open policy is waiting, running or over follows from `start`
and `end`. `Holder_by_pk` is `null` for an address that never held a policy. `deferred` is what the token refused
to deliver to the holder and the pool keeps for `claimDeferred`.

The payouts alone, newest first:

```graphql
query HolderPayouts($chainId: Int!, $holder: String!, $limit: Int = 25) {
  Settlement(
    where: { chainId: { _eq: $chainId }, holder_id: { _eq: $holder }, amount: { _gt: "0" } }
    order_by: { timestamp: desc }
    limit: $limit
  ) {
    id
    amount
    settledUntil
    txHash
    timestamp
    policy {
      id
      start
      end
      ratePerSecond
    }
  }
}
```

```json
{ "chainId": 10143, "holder": "0x00000000000000000000000000000000000a11ce" }
```

## Live exposure per cell, for the map

`ExposureMap` returns the cells that have open cover, with the centre of each cell and what the pool reserves
for it. `exposure` falls as policies are settled and reaches zero when the last one closes.

```graphql
query ExposureMap($chainId: Int!, $limit: Int = 500) {
  Cell(
    where: { chainId: { _eq: $chainId }, openPolicies: { _gt: 0 }, lat: { _is_null: false } }
    order_by: { exposure: desc }
    limit: $limit
  ) {
    id
    latIndex
    lonIndex
    lat
    lon
    exposure
    openPolicies
    totalPremiums
    totalPaid
    lastWetAt
    lastReadingAt
  }
  PoolState_by_pk(chainId: $chainId, id: "pool") {
    lockedExposure
    activeCells
    lastHeartbeat
  }
}
```

```json
{ "chainId": 10143 }
```

A cell covers `lat ± 0.025`, `lon ± 0.025`. Its latest reading was wet if `lastWetAt` equals `lastReadingAt`;
compare `lastHeartbeat` with the clock to tell a dry cell from a silent oracle. The contracts accept any key, so a key
whose cell id is not on the grid has `lat` and `lon` null; the filter above leaves those out.

For one viewport, every cell with a history in it:

```graphql
query CellsInView($chainId: Int!, $south: float8!, $north: float8!, $west: float8!, $east: float8!) {
  Cell(
    where: {
      chainId: { _eq: $chainId }
      lat: { _gte: $south, _lte: $north }
      lon: { _gte: $west, _lte: $east }
    }
    limit: 1000
  ) {
    id
    lat
    lon
    exposure
    openPolicies
    policyCount
    totalPaid
    lastWetAt
    lastReadingAt
  }
}
```

```json
{ "chainId": 10143, "south": 38.5, "north": 39.0, "west": -9.5, "east": -9.0 }
```

## Pool totals and the daily series

```graphql
query Pool($chainId: Int!, $days: Int = 30) {
  PoolState_by_pk(chainId: $chainId, id: "pool") {
    lockedExposure
    lastHeartbeat
    policyCount
    openPolicies
    holderCount
    activeCells
    settlementCount
    readingCount
    openRedeemRequests
    totalPremiums
    totalFees
    totalPayouts
    totalDeposits
    totalWithdrawals
    escrowedShares
    totalDeferred
    totalSurplus
    treasury
    servedOnly
    servedCells
    lossRatio
    feeBps
    redeemNotice
    updatedAt
  }
  PoolDay(where: { chainId: { _eq: $chainId } }, order_by: { startsAt: desc }, limit: $days) {
    id
    startsAt
    premiums
    fees
    payouts
    deposits
    withdrawals
    surplus
    policiesBought
    settlements
    lossRatio
  }
}
```

```json
{ "chainId": 10143 }
```

`PoolState_by_pk` is `null` until the first indexed event. A `PoolDay` id is the UTC date (`2026-10-13`); days
without activity have no row, so fill the gaps on the client. `premiums` include the protocol fee: the pool
received `premiums - fees`. `lossRatio` is `payouts / premiums` and is `null` when no premium was paid. Payouts
are counted on the day they are settled, which can be a later day than the premium. Balances the events do not
carry (total assets, share price, free assets) come from the pool contract.

## Served areas

While the book sells only in served areas (`servedOnly`), cover is sold only in the cells marked `served`.

```graphql
query ServedAreas($chainId: Int!) {
  Cell(where: { chainId: { _eq: $chainId }, served: { _eq: true } }, limit: 1000) {
    id
    lat
    lon
    openPolicies
  }
  PoolState_by_pk(chainId: $chainId, id: "pool") {
    servedOnly
    servedCells
  }
}
```

```json
{ "chainId": 10143 }
```

With `servedOnly` false every cell is on sale and the list only says where the owner intends to sell.

## Latest weather readings for a cell

```graphql
query CellWeather($chainId: Int!, $cell: String!, $limit: Int = 48) {
  Cell_by_pk(chainId: $chainId, id: $cell) {
    lat
    lon
    wetSeconds
    lastWetAt
    lastReadingAt
    exposure
    openPolicies
  }
  WeatherReading(
    where: { chainId: { _eq: $chainId }, cell_id: { _eq: $cell } }
    order_by: { to: desc }
    limit: $limit
  ) {
    id
    from
    to
    wetSeconds
    cumulative
    txHash
    timestamp
  }
}
```

```json
{ "chainId": 10143, "cell": "18446755128955374937" }
```

A reading says that `wetSeconds` of the interval `[from, to)` were wet; `cumulative` is the running total for
the key. Readings never overlap, and time between one reading and the next was recorded as dry.

## Open redemption requests of an address

A controller has one request at a time, and its id is the controller's address.

```graphql
query RedeemRequests($chainId: Int!, $controller: String!) {
  RedeemRequest(where: { chainId: { _eq: $chainId }, id: { _eq: $controller }, status: { _eq: OPEN } }) {
    id
    owner
    shares
    claimedShares
    claimedAssets
    requestedAt
    claimableAt
    lastPolicyAtRequest
    surplus
    status
    txHash
  }
  PoolState_by_pk(chainId: $chainId, id: "pool") {
    redeemNotice
    escrowedShares
    openRedeemRequests
  }
}
```

```json
{ "chainId": 10143, "controller": "0x0000000000000000000000000000000000000b0b" }
```

The request can be claimed once the clock passes `claimableAt` and every policy up to `lastPolicyAtRequest` has
closed; until then it is pending. The second condition depends on the book's `oldestOpenId`, which no event
carries, so ask the pool: `claimBlockedByCover(controller)` is true while older cover holds the request back. `shares` are the shares
still in escrow. What they are worth is priced at the claim, so read `maxWithdraw(controller)` from the pool for
the amount. Drop the `id` filter to list every open request, for example ordered by `claimableAt`.

## How far the index has got

```graphql
query IndexProgress {
  _meta {
    chainId
    progressBlock
    sourceBlock
    eventsProcessed
    isReady
    readyAt
  }
}
```

`isReady` turns true when the backfill has reached the head. `sourceBlock - progressBlock` is the lag in blocks.
