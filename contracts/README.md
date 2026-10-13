# Contracts

Pay-as-you-go weather cover that switches on and off by the minute. A policy covers one grid cell over a
minute-aligned window and pays a fixed rate for every second the oracle confirms as wet in that cell, up to
`rate x duration`. That maximum is reserved in the pool when the policy is sold, so a sale the pool cannot back
reverts instead of creating an unbacked promise.

Solidity 0.8.30, Foundry, OpenZeppelin Contracts 5.7.

## What each contract does

| Contract | Role |
|---|---|
| `WeatherIndex` | Record of wet seconds per key `(triggerId << 64) \| cellId`. Stores checkpoints `(timestamp, cumulative wet seconds)` and answers `wetSeconds(key, a, b)`, interpolating inside a reported interval. Accepts reports through an allowlisted Chainlink forwarder (`onReport`) or directly (`submit`); every report is authenticated by the reporter's EIP-712 signature and accepted once. |
| `CoverPool` | ERC-4626 vault over the dollar token. Reserves the remaining maximum payout of every open policy (`lockedExposure`, `cellExposure`), enforces the global and per-cell caps when exposure is locked, and limits withdrawals to assets that back nothing. Only the book can lock, release and pay. |
| `CoverBook` | Sells policies against quotes signed by the underwriter (`buy`, `buyWithAuthorization`), settles them against the index (`settle`, `settleMany`) and closes policies the oracle never finished reporting (`expire`). |
| `TestDollar` | Six-decimal test token with EIP-2612 and ERC-3009 and an open, rate-limited `drip`. Test networks only. |

### Behaviour worth knowing

- **One signature pays and binds.** In `buyWithAuthorization` the holder's ERC-3009 `ReceiveWithAuthorization`
  uses `hashQuote(quote)` as its nonce and the book as payee. It can only be spent by the book, only on those
  terms, and only once. Whoever submits it, the result is the policy the holder signed for.
- **No refunds, no cancellations.** A refundable policy would be a free option on the forecast.
- **Sales fail closed.** `OracleStale` stops sales when the index heartbeat is older than `maxOracleAge`; the
  cap errors stop sales the pool cannot back. Open policies are unaffected.
- **Settlement is permissionless and incremental.** `settle` pays what the index has confirmed since the last
  settlement and closes the policy when its window is fully reported. Time the oracle never reports pays
  nothing; after `end + expiryGrace` anyone can `expire` the policy and free its exposure.
- **Rounding favours the pool.** Wet seconds round down at the end of a range and up at its start, fees round
  down, caps round down. Splitting a settlement into several never pays more than settling once.
- **Undeliverable payouts are set aside.** If the token refuses a transfer to a holder, the amount moves to
  `deferred[holder]` in the pool and the policy still closes; `claimDeferred(holder)` retries it.

### Refusals

`CoverBook`: `QuoteExpired`, `BadQuoteSignature`, `QuoteUsed`, `WindowInvalid`, `LeadTooShort`, `PolicyTooLarge`,
`OracleStale`, `TooManyCells` (checked in this order), `PolicyUnknown`, `ExpiryNotReached`.
`CoverPool`: `GlobalCapExceeded`, `CellCapExceeded`, `ExposureLocked`.
`WeatherIndex`: `NotForwarder`, `BadReporterSignature`, `StaleReport`, `ReportFromFuture`, `ReportTooOld`.

## Signing

| What | EIP-712 domain | Primary type |
|---|---|---|
| Quote (underwriter) | `Cover`, version `1`, `CoverBook` | `Quote(address holder,uint256 key,uint64 start,uint64 end,uint128 ratePerSecond,uint128 premium,uint64 expiry,bytes32 salt)` |
| Report (reporter) | `WeatherIndex`, version `1`, `WeatherIndex` | `Report(Reading[] readings,uint64 issuedAt)` with `Reading(uint256 key,uint64 from,uint64 to,uint32 wetSeconds)` |
| Premium (holder) | the token's own domain | ERC-3009 `ReceiveWithAuthorization`, `to` = `CoverBook`, `nonce` = `hashQuote(quote)` |
| LP deposit (provider) | the token's own domain | ERC-3009 `ReceiveWithAuthorization`, `to` = `CoverPool` |

A report travels as `abi.encode(Reading[] readings, uint64 issuedAt, bytes signature)`. `issuedAt` must be
greater than the last accepted one, at most 60 seconds ahead of the chain clock and at most `maxReportAge` behind
it. A reading must end after the key's last reported time and not in the future; start each reading where the
previous one ended (`lastTo(key)`), because a gap is recorded as dry.

## Tests

```sh
forge test
```

- unit tests for every contract and every revert path, including the deploy script;
- fuzz tests of the interpolation, the payout bounds, the caps and the withdrawal limits;
- an invariant suite (`test/invariant`) that drives purchases, replays, genuine and forged reports, settlements,
  expiries, deposits, withdrawals and issuer blocks, and checks after every call that pool exposure equals the
  open policies, the pool holds what it owes, payouts follow the index and the maximum, withdrawal limits stay
  within free assets, and a quote is used once;
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
| `TREASURY` | required | recipient of the protocol fee |
| `TOKEN` | optional | dollar token; when unset a `TestDollar` is deployed, on chain 10143 or a local chain only |
| `FORWARDERS` | optional | comma-separated Chainlink forwarders allowed to call `onReport`; may be empty |
| `OWNER` | optional | final owner of every contract; defaults to the deployer |
| `MIN_LEAD` | optional | seconds between a purchase and its window; defaults to 600 on chain 143, otherwise 0 |
| `MAX_POLICY_PAYOUT` | optional | largest payout of one policy, in token base units; defaults to `500e6` |
| `SHARE_NAME`, `SHARE_SYMBOL` | optional | pool share token metadata |

The script deploys `WeatherIndex`, `CoverPool` and `CoverBook`, allowlists the forwarders, points the pool at the
book and writes `deployments/<chainId>.json` (addresses, parameters, start block). A run without `--broadcast`
only prints the addresses. When `OWNER` is not the deployer, ownership is offered to it and it must call
`acceptOwnership()` on each contract.

## Trust and limits

- The **owner** sets caps, fees, limits and the underwriter and reporter keys. The **underwriter** key prices
  cover and the **reporter** key decides what was wet; each can cost the pool up to its caps if misused.
- With `requireReporterSig` switched off, every allowlisted forwarder is trusted on its own. Keep it on unless
  each forwarder authenticates the workflow behind a report.
- The caps bind when exposure is locked. Later withdrawals and payouts can leave utilization above them, up to
  every asset being reserved; they cannot touch reserved assets.
- Premiums raise the share price when they arrive and payouts lower it when they are made, so the timing of a
  deposit or withdrawal relative to them matters to a liquidity provider.
- The dollar token is assumed to behave like USDC: no transfer fees, no rebasing, no transfer callbacks.
