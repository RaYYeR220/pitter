# Contracts

Pay-as-you-go weather cover that switches on and off by the minute. A policy covers one grid cell over a
minute-aligned window and pays a fixed rate for every second the oracle confirms as wet in that cell, up to
`rate x duration`. That maximum is reserved in the pool when the policy is sold, so a sale the pool cannot back
reverts instead of creating an unbacked promise.

Solidity 0.8.30, OpenZeppelin Contracts 5.7, Foundry 1.8 or newer (the project selects the Monad network
family, which older releases do not know). Dependencies are git submodules: `git submodule update --init`.

## What each contract does

| Contract | Role |
|---|---|
| `WeatherIndex` | Record of wet seconds per key `(triggerId << 64) \| cellId`. Stores checkpoints `(timestamp, cumulative wet seconds)` and answers `wetSeconds(key, a, b)`, interpolating inside a reported interval. Accepts reports through an allowlisted Chainlink forwarder (`onReport`) or directly (`submit`); on both paths every report must carry the reporter's EIP-712 signature, and each is accepted once. |
| `CoverPool` | ERC-4626 vault over the dollar token. Reserves the remaining maximum payout of every open policy (`lockedExposure`, `cellExposure`) and enforces the global and per-cell caps when exposure is locked. Deposits are immediate; leaving takes notice (`requestRedeem`, then `redeem` or `withdraw`), and capital that has asked to leave is no longer sold against. Only the book can lock, release and pay. |
| `CoverBook` | Sells policies against quotes signed by the underwriter (`buy`, `buyWithAuthorization`), optionally only in served areas; settles them against the index (`settle`, `settleMany`); closes policies the oracle never finished reporting (`expire`); and keeps `oldestOpenId`, below which every policy is closed. |
| `TestDollar` | Six-decimal test token with EIP-2612 and ERC-3009 and an open, rate-limited `drip`. Test networks only. |

### Behaviour worth knowing

- **One signature pays and binds.** In `buyWithAuthorization` the holder's ERC-3009 `ReceiveWithAuthorization`
  uses `hashQuote(quote)` as its nonce and the book as payee. It can only be spent by the book, only on those
  terms, and only once. Whoever submits it, the result is the policy the holder signed for.
- **No refunds, no cancellations.** A refundable policy would be a free option on the forecast.
- **Sales fail closed.** `OracleStale` stops sales when the index heartbeat is older than `maxOracleAge`; the
  cap errors stop sales the pool cannot back. Open policies are unaffected.
- **Served areas.** With `servedOnly` on, cover is sold only for keys the owner has marked with `setServed`
  (`isServed`, `servedKeys`); anything else is refused with `AreaNotServed`. While it is on there can be no
  more served keys than `maxActiveCells`, so the cap on active cells never shuts out a served area: a buyer
  can hold slots only in cells that stay open to everyone. A key that stops being served keeps its open cover,
  which settles as usual.
- **Cover ends well before the capital behind it can leave.** A window may end at most `maxHorizon` after its
  purchase (12 hours 30 minutes by default), and the pool's `redeemNotice` must be at least `maxHorizon +
  NOTICE_MARGIN` (30 minutes). Both setters check the other contract.
- **Settlement is permissionless and incremental.** `settle` pays what the index has confirmed since the last
  settlement and closes the policy when its window is fully reported. Time the oracle never reports pays
  nothing; after `end + expiryGrace` anyone can `expire` the policy and free its exposure.
- **Rounding favours the pool.** Wet seconds round down at the end of a range and up at its start, fees round
  down, caps round down. Splitting a settlement into several never pays more than settling once.
- **Reports are always signed.** There is no switch that trusts a forwarder on its own: a forwarder proves only
  that some workflow produced the bytes, so the reporter's signature is checked on `onReport` exactly as on
  `submit`. The forwarder allowlist stays as a second gate on `onReport`.
- **Oracle liveness is when the reporter spoke.** The heartbeat is the `issuedAt` of the last accepted report
  (or its landing time, if it was issued ahead of the chain clock), so a report held back and delivered late
  does not make a silent oracle look alive.
- **Undeliverable payouts are set aside.** If the token refuses a transfer to a holder, the amount moves to
  `deferred[holder]` in the pool and the policy still closes; `claimDeferred(holder)` retries it.

### Leaving the pool

Capital that could leave at will could arrive, lift the caps for one oversized sale and be gone in the same
transaction, or step out ahead of a payout everyone can see coming. So a liquidity provider gives notice:

1. `requestRedeem(shares, controller, owner)` moves the shares into escrow. The caller is the owner or holds an
   allowance over the owner's shares; the controller, who will hold the claim, is the owner or the caller. The
   request records the book's `policyCount` as `lastPolicyAtRequest`.
2. The request can be collected once both of these hold:
   - its notice is over: `redeemNotice` (13 hours by default) has passed since the request;
   - every policy sold before it is closed: `book.oldestOpenId() > lastPolicyAtRequest`. A request made before
     any policy was sold never waits for cover. `claimBlockedByCover(controller)` says whether it is waiting.

   Each controller has one request; adding to it restarts the notice, re-marks it at the current price and
   makes all of it wait for the policies sold until then.
3. The controller then calls `redeem(shares, receiver, controller)` or `withdraw(assets, receiver,
   controller)`, in one go or in parts. `cancelRedeemRequest()` returns the escrowed shares instead, at any
   time.

A claim never waits on the keeper alone: `settle` and `expire` are open to anyone, the provider included, and
`syncOldestOpen(maxSteps)` walks `oldestOpenId` forward when policies closed out of order (each close moves it
over at most 32 closed policies). At worst, for a cell the oracle never reports, the claim waits until the last
policy sold before the request can be expired: `maxHorizon + expiryGrace` after the request.

From the request on, the capital is retiring:

- it does not count towards the caps (`activeAssets()` leaves it out), so no new cover is sold against it;
- it earns nothing further: a claim pays the lower of what the shares were worth at the request and what they
  are worth at the claim. When the claim is capped, the rest of what the shares are worth goes to the pool's
  `treasury` (`SurplusToTreasury`), not to the providers who stay, so a buyer who holds the active shares
  cannot collect a retiring provider's share of its own premium. If the token refuses the treasury, the amount
  is set aside under `deferred[treasury]`;
- it bears every loss until it is claimed, including on cover sold after its request.

A claim takes everything its shares are worth out of `freeAssets()`, surplus included; `maxRedeem` and
`maxWithdraw` are sized so that it fits, and are zero while the notice runs or older cover is open.

`pendingRedeemRequest`, `claimableRedeemRequest` and the `RedeemRequest` event follow ERC-7540, and the pool
reports the asynchronous-redemption interface (`0x620ee8e4`) through ERC-165. A request is pending until it
can be collected. Three things differ from that standard: a request matures with time and with the closing of
older cover rather than through an operator's fulfilment, it is priced at the claim, and there are no
operators, so only the controller itself can claim. `previewRedeem` and `previewWithdraw` revert.
`redeemRequests(controller)` returns the escrowed shares, their value at the request, the time the notice ends
and `lastPolicyAtRequest`.

### Recovery

- `CoverBook.rescue(token, to, amount)` (owner) sends tokens sent to the book by mistake. The book holds nothing
  at rest: a gasless premium passes through it inside the purchase, which the reentrancy guard keeps `rescue`
  out of.
- `CoverPool.rescueShares(to, shares)` (owner) returns pool shares transferred to the pool by mistake, up to
  `balanceOf(pool) - escrowedShares`. The escrow cannot be touched, and dollars sent to the pool are a
  donation to its providers.
- A payout deferred for a holder whom the token issuer blocks stays in `deferred[holder]`, outside
  `totalAssets()`, until the issuer unblocks the holder and someone calls `claimDeferred(holder)`. Nobody else
  can take it.

### Refusals

`CoverBook`, at purchase in this order: `QuoteExpired`, `BadQuoteSignature`, `QuoteUsed`, `WindowInvalid`,
`WindowTooFar`, `LeadTooShort`, `PolicyTooLarge`, `PremiumTooSmall`, `AreaNotServed`, `OracleStale`,
`TooManyCells`; afterwards `PolicyUnknown`, `ExpiryNotReached`; `ConfigInvalid` from the setters.
`CoverPool`: `GlobalCapExceeded`, `CellCapExceeded` for a sale; `NotController`, `InsufficientRequest`,
`NoticeNotOver`, `CoverStillOpen`, `ExposureLocked` for a claim, in this order; `ControllerNotAllowed`,
`NoRedeemRequest` around a request; `NoticeInvalid`, `ExceedsStrayShares` from the owner's calls.
`WeatherIndex`: `NotForwarder`, `BadReporterSignature`, `StaleReport`, `ReportFromFuture`, `ReportTooOld`.

## Signing

| What | EIP-712 domain | Primary type |
|---|---|---|
| Quote (underwriter) | `Cover`, version `1`, `CoverBook` | `Quote(address holder,uint256 key,uint64 start,uint64 end,uint128 ratePerSecond,uint128 premium,uint64 expiry,bytes32 salt)` |
| Report (reporter) | `WeatherIndex`, version `1`, `WeatherIndex` | `Report(Reading[] readings,uint64 issuedAt)` with `Reading(uint256 key,uint64 from,uint64 to,uint32 wetSeconds)` |
| Premium (holder) | the token's own domain | ERC-3009 `ReceiveWithAuthorization`, `to` = `CoverBook`, `nonce` = `hashQuote(quote)` |
| LP deposit (provider) | the token's own domain | ERC-3009 `ReceiveWithAuthorization`, `to` = `CoverPool` |

A report travels as `abi.encode(Reading[] readings, uint64 issuedAt, bytes signature)`, on both entry points.
`issuedAt` must be greater than the last accepted one, at most 60 seconds ahead of the chain clock and at most
`maxReportAge` behind it. A reading must end after the key's last reported time and not in the future; start
each reading where the previous one ended (`lastTo(key)`), because a gap is recorded as dry.

## Tests

```sh
forge test
```

- unit tests for every contract and every revert path, including the deploy script;
- fuzz tests of the interpolation, the payout bounds, the caps, the withdrawal limits, the claim valuation and
  the oldest-open mark;
- an invariant suite (`test/invariant`) that drives purchases inside, at and beyond the cover horizon, replays,
  genuine and forged reports, settlements, expiries, deposits, redemption requests, cancellations, claims
  (also while older cover is open), catch-ups of the oldest-open mark and issuer blocks, and checks after every
  call that pool exposure equals the open policies, the pool holds what it owes, payouts follow the index and
  the maximum, every policy below `oldestOpenId` is closed, nothing is claimed before its notice, while older
  cover is open or beyond free assets, a claim takes out what its shares are worth (paid or sent to the
  treasury) and no more, the escrow matches the requests, no policy ends beyond the horizon it was bought
  under, no request made after a sale matures within the margin after that cover ends, and a quote is used
  once;
- a fork suite (`test/fork`) against native USDC on Monad mainnet, skipped unless an RPC is given:

```sh
MONAD_RPC_URL=https://rpc.monad.xyz forge test --match-path "test/fork/*"
```

The suite runs under the Monad execution rules (`network = "monad"` in `foundry.toml`). `snapshots/Gas.json`
records the gas of the calls a relayer, a keeper and the oracle make.

## Deploy

```sh
forge script script/Deploy.s.sol --rpc-url monad_testnet --broadcast --account <keystore>
```

| Variable | | |
|---|---|---|
| `REPORTER` | required | key that signs oracle reports |
| `UNDERWRITER` | required | key that signs quotes |
| `TREASURY` | required | recipient of the protocol fee and of the surplus of capped claims |
| `TOKEN` | optional | dollar token; when unset a `TestDollar` is deployed, on chain 10143 or a local chain only |
| `FORWARDERS` | optional | comma-separated Chainlink forwarders allowed to call `onReport`; may be empty |
| `OWNER` | required on chain 143 | final owner of every contract; elsewhere defaults to the deployer. On chain 143 it must be stated, even when it is the deployer |
| `MIN_LEAD` | optional | seconds between a purchase and its window; defaults to 600 on chain 143, otherwise 0 |
| `MAX_POLICY_PAYOUT` | optional | largest payout of one policy, in token base units; defaults to `500e6` |
| `MIN_PREMIUM` | required on chain 143 | smallest premium of one policy, in token base units; non-zero on chain 143, elsewhere defaults to none |
| `SERVED_ONLY` | optional | sell only in served areas; defaults to `true` on chain 143, otherwise `false` |
| `SERVED_KEYS` | optional | comma-separated keys to mark as served; at most `maxActiveCells` (64) while `SERVED_ONLY` is on |
| `REDEEM_NOTICE` | optional | seconds a liquidity provider waits between asking to leave and leaving, at least `MAX_HORIZON` + 30 minutes; defaults to 13 hours |
| `MAX_HORIZON` | optional | seconds ahead of its purchase a policy may end: at least the longest window (12 hours), at most `REDEEM_NOTICE` - 30 minutes; defaults to 12 hours 30 minutes |
| `SHARE_NAME`, `SHARE_SYMBOL` | optional | pool share token metadata |

The script deploys `WeatherIndex`, `CoverPool` and `CoverBook`, allowlists the forwarders, points the pool at the
book, applies the parameters, fails unless the notice outlasts the horizon by the margin, and writes
`deployments/<chainId>.json` (addresses, parameters, start block, and `owner` and `pendingOwner` as read from
the chain). A run without `--broadcast` only prints the addresses. With `SERVED_ONLY` on and no `SERVED_KEYS`,
nothing can be sold until the owner calls `setServed`.

**Hand-over.** When `OWNER` is not the deployer, the script starts a two-step transfer of every contract
(`WeatherIndex`, `CoverPool`, `CoverBook`, and `TestDollar` when it deploys one). Until `OWNER` calls
`acceptOwnership()` on each of them, the deployer key still owns them and `owner` in the record is the
deployer. Accept straight after the deployment and check that `owner()` is `OWNER` on all of them.

## Trust and limits

Each key, what it can do, and what bounds it on chain:

| Key | Can | Bounded by |
|---|---|---|
| **Owner** (each contract) | Set the underwriter and reporter keys, the caps, the fee, the policy size, the premium floor, the served areas, the notice, the horizon, the grace period and both treasuries; recover stray tokens and shares. An owner that installs its own underwriter and reporter keys can do everything those keys can: sell itself cover up to the caps and report it wet. | Fee at most 20%; caps at most 100%; notice between one minute and seven days and at least the horizon plus 30 minutes; horizon at least the longest window; grace at least one hour; served areas no more than the cell slots; the book is wired once. It cannot mint or move shares, touch the escrow or deferred payouts, change a policy, or rewrite the index. Nothing delays its actions: hold it in a multisig. |
| **Underwriter** | Sign any quote: any holder, rate and premium down to `minPremium`. Alone it can give cover away; turning that into money needs real rain or the reporter. | Per policy `maxPolicyPayout`; per cell 25% and in total 80% of active assets; windows of at most 12 hours ending within the horizon; `minLead`; served areas; a quote is used once and dies with a key rotation. |
| **Reporter** | Decide what was wet: one report can make every open policy pay its maximum, and silence lets them expire unpaid. An accepted reading cannot be corrected. | Only time in the past, never more wet seconds than seconds, only open policies, so at most `lockedExposure`, which the caps held to 80% of active assets when it was locked. Free assets are out of reach. |
| **Forwarders** | Deliver reports the reporter signed, which anyone can do through `submit`. | The signature is always checked. |
| **Relayer, keeper** | Nothing beyond submitting: `buyWithAuthorization`, `depositWithAuthorization`, `settle`, `settleMany`, `expire`, `submit`, `syncOldestOpen` and `claimDeferred` are open to anyone and pay only the signed or recorded party. | |
| **Treasuries** | Receive the fee (book) and the surplus of capped claims (pool). | If the token blocks the book's treasury, purchases revert until the owner sets another; the pool's surplus is set aside instead. |
| **Deployer** | Everything the owner can, until `acceptOwnership()`. | The hand-over above. |

Other limits:

- The caps bind when exposure is locked, against the capital that has not asked to leave. Later requests,
  claims and payouts can leave utilization above them; a claim can never take reserved assets.
- The horizon and the notice bind at the moment of each sale and each request. An owner who shortens the
  horizon and then the notice while cover sold under the longer horizon is open lets later requests mature
  earlier; such a request still waits for that cover to close. Before the book is wired the pool has nothing
  to compare its notice with, which is why the deploy script checks the two afterwards.
- A notice shorter than twelve and a half hours needs shorter windows first: `setDurationBounds`, then
  `setMaxHorizon`, then `setRedeemNotice`. The deploy script takes only the last two from the environment.
- A request waits only for cover sold before it. Once collectable, it can be claimed at any moment, also
  between a report and the settlement of cover sold after the request; that cover was sold against the
  active capital alone, and the providers who stay carry its payout.
- Retiring capital carries losses on cover sold after its request without sharing in that cover's premium,
  which goes to the providers who stay and, for the retiring part, to the treasury. A provider who never
  claims a collectable request keeps carrying losses until it does.
- Leaving needs two transactions from the provider (or a spender for the request); there is no gasless path.
- A served key removed while it has open cover keeps its active-cell slot until that cover closes.
- The dollar token is assumed to behave like USDC: no transfer fees, no rebasing, no transfer callbacks.
