# Service

The off-chain half of the product: it prices cover and signs quotes, pays the gas for users who hold only
dollars, runs the keeper that reports the weather and pushes payouts, sells cover over HTTP for an x402
payment, and stores each user's encrypted shift log.

It is a set of handlers, not a server. Every handler takes a Fetch API `Request` and returns a `Response`;
clients, keys, storage, the clock and `fetch` are passed in. A web framework mounts them as routes and tests
run them in-process.

```ts
// app/api/[...path]/route.ts with BASE_PATH=/api
import { createServiceFromEnv } from '@cover/service'

const service = createServiceFromEnv(process.env)
const handle = async (request: Request) => (await service).fetch(request)
export { handle as GET, handle as POST, handle as PUT }
```

`createService(deps)` is the same thing with every dependency supplied by hand; `service.handlers` exposes
each handler for hosts that route themselves.

## Endpoints

| Method | Path | Access | What it does |
|---|---|---|---|
| `GET` | `/quote?lat&lon&start&end&rate&holder` | open, rate-limited | Prices a window and returns `{ quote, quoteSig, digest, maxPayout, cell, inputs, capacity }`, signed by the underwriter key. |
| `POST` | `/relay/buy` | holder's signature | `{ quote, quoteSig, validAfter, validBefore, v, r, s }` → `buyWithAuthorization`. Returns the transaction and the policy id. |
| `POST` | `/relay/deposit` | provider's signature | `{ assets, receiver, nonce, validAfter, validBefore, v, r, s }` → pool `depositWithAuthorization`. |
| `POST` | `/relay/transfer` | sender's signature | `{ from, to, value, nonce, validAfter, validBefore, v, r, s }` → token `transferWithAuthorization` (cash-out). |
| `POST` | `/relay/settle` | open, rate-limited | `{ ids }` (at most 10) → one `settleMany` for the policies with something to settle, as many as fit one transaction's gas (six that close); the rest come back in `skipped` and can be asked for again. Sends nothing when nothing is due. |
| `POST`, `GET` | `/cron/tick` | `x-cron-secret` or bearer token | One keeper run: weather report, then settlements. |
| `POST` | `/v1/cover` | x402 payment | `{ lat, lon, start, end, rate, holder }`. Answers 402 with the price; with a `PAYMENT-SIGNATURE` header it settles the payment and buys the policy for `holder`. |
| `PUT`, `GET` | `/blobs/:address/:name` | owner's EIP-712 signature | Stores and returns opaque bytes. |
| `POST` | `/sandbox/drip` | `x-sandbox-secret`, test networks | `{ address }` → test dollar `drip`. |
| `POST`, `GET` | `/sandbox/storm` | `x-sandbox-secret`, test networks | `{ wet }` moves the simulator cell's storm switch; `GET` reads it. |

Integers travel as decimal strings; the `quote` object returned by `/quote` can be posted back unchanged.
Errors are `{ "error": { "code", "message", "details"? } }` with a matching status. The codes a client is
expected to handle:

| Code | Status | Meaning |
|---|---|---|
| `invalid_request`, `invalid_json` | 400 | The request failed validation; `details.issues` lists the fields. |
| `authorization_invalid`, `authorization_expired`, `quote_signature_invalid` | 400 | A signature does not match the terms it is presented with. |
| `window_invalid`, `window_too_soon`, `window_too_long`, `window_too_far`, `rate_too_high`, `policy_too_large`, `premium_too_small` | 422 | The cover asked for is not on offer. |
| `area_not_served` | 422 | The book sells only in served areas and this cell is not one of them (`AreaNotServed`). |
| `capacity_exhausted`, `too_many_cells` | 409 | The pool cannot back it now; `details.capacity` says how much room there is. |
| `oracle_stale` | 503 | The weather index has not reported recently; sales are paused. |
| `would_revert` | 409 | The transaction would fail on chain; `details.reason` is the contract's error. Nothing was sent. `AreaNotServed`, `PremiumTooSmall`, `WindowTooFar` and `CoverStillOpen` come back under their own codes instead (`area_not_served`, `premium_too_small`, `window_too_far`, `cover_still_open`), with the same `details.reason`. |
| `quote_expired`, `in_progress`, `reverted` | 409 | Ask for a new quote; wait for the first request; or the transaction was included and failed. |
| `relay_pending` | 504 | Sent, not confirmed in time; `details.transactionHash` can be checked later. |
| `relayer_unfunded`, `relayer_busy`, `gas_price_too_high`, `rpc_unavailable` | 502/503 | The relayer cannot send right now. A user with gas can call the contracts directly. |
| `rate_limited` | 429 | See `retry-after`. |

### What cannot be relayed

Leaving the pool is not gasless. `requestRedeem`, `cancelRedeemRequest` and `redeem` act on `msg.sender` and
the contracts offer no signed variant, so a liquidity provider sends those transactions with their own gas.

## How the pieces work

**Quotes.** A quote is signed only if the book would accept it at that moment: minute-aligned window, within
the duration bounds and the cover horizon, starting after the lead time, in a served area while the book sells
only there (`area_not_served` otherwise), rate under `QUOTE_MAX_RATE_PER_SECOND`, maximum payout within the
policy limit and within what the pool has free in total and in the cell (measured on `activeAssets`), and a
fresh oracle heartbeat. The premium comes from the pricing model in `@cover/core` and is floored at the book's
`minPremium` and at `QUOTE_MIN_PREMIUM_BPS` of the maximum payout. A quote expires after `QUOTE_TTL_SECONDS`, and
never later than the last moment the book would still take it. The book's `servedOnly` switch and its served
keys are read at most once a minute, so an area the owner has just added or removed can be judged by the old
list for that long; the book itself has the last word.

The pricing model reads the cell's forecast and what the settlement sources report there right now, both through
the same `@cover/core` helpers the keeper uses. While a source reports rain, the slots of the coming hour are
priced at the observation floor (90%). If the sources cannot be read within 4 seconds, or fewer than two answer,
the quote is priced as if it might be raining now: those slots get the floor too, `inputs.observation.status` is
`unavailable` and the response carries `"warnings": ["observations_unavailable"]`. A missing observation can make
cover dearer, never cheaper. Each slot in `inputs.slots` names the forecast `model` that drove it and whether the
`observationFloor` applied. Forecasts are reused for 2 minutes and observations for 1 minute per cell (15 seconds
after a failure), so a burst of quotes asks the providers once.

**Relayer.** One hot key, one gate for every transaction:

1. the target and the four-byte selector must be on the allow-list (below), and the gas limit within bounds;
2. the node must be on the configured chain, the key funded, the base fee under the cap;
3. holding the nonce, the call is simulated against the latest state; a call that would revert is refused and
   costs nothing;
4. it is signed with an explicit nonce, gas limit and fees, with no value, and sent with
   `eth_sendRawTransactionSync` where the node has it.

The nonce is held from simulation to receipt, so two relays never race: the second is simulated against what
the first left behind. The stored nonce only advances for included transactions, so it can never run ahead of
the chain and open a gap.

| Allowed call | Contract | Gas limit | Measured |
|---|---|---|---|
| `buyWithAuthorization` | cover book | 700,000 | 520,278 (first policy of a new cell) |
| `buy` (paid cover only) | cover book | 640,000 | 454,680 |
| `settleMany(n)` | cover book | 160,000 + 150,000 n + 272,000 per policy that may close | 498,113 for one payout that closes, frees its cell and walks `oldestOpenId` 32 steps; 2,398,416 for six of them; 167,930 for a payout that does not close |
| `expire` | cover book | 560,000 | 485,764 for a payout, a close and a walk of 32 steps |
| `syncOldestOpen(steps)` | cover book | 50,000 + 8,500 per step, at most 320 steps | 30,732 with nothing to walk, 166,566 for 16 steps, 432,294 for 48 |
| `depositWithAuthorization` | cover pool | 280,000 | 178,777 |
| `transferWithAuthorization` | token | 160,000 | 103,023 |
| `approve` (paid cover only, spender must be the book) | token | 90,000 | 52,103 |
| `drip` (sandbox only) | token | 150,000 | 109,468 |
| `submit` | weather index | 75,000 + 52,000 per reading + 40,000 more per new cell | 55,513 empty, 134,746 with one new cell |

Monad charges for the limit, not for the gas used, so the limits are measured worst cases plus headroom for
native USDC rather than round numbers. The measurements are from the integration tests below and agree with
`contracts/snapshots/Gas.json`.

Closing a policy walks the book's `oldestOpenId` forward over up to 32 closed policies, a cold storage read
(8,304 gas) each, so every policy that may close (its window is over, or ends within two minutes) is budgeted
272,000 for that walk. Six such closes fit under the 3,000,000 a relay may ask for; a longer batch is cut into
several transactions, so no batch is refused on every tick for its gas. `test/integration/gas.test.ts` builds
the worst case on a local Monad chain (every close walks 32 steps, pays an address that held nothing and
frees its cell) and checks it against these limits; `GAS_REPORT=<file>` writes the measurements out. Leaving
the pool is not relayed; for reference, `requestRedeem` measures 181,266, a claim (`redeem`) 121,557,
`cancelRedeemRequest` 70,641, and the reads behind it 30,806 to 58,544 (`claimBlockedByCover` the most).

**Keeper.** A tick reads the cells with open cover, asks the weather module in `@cover/core` about them and
about one reference cell, and submits readings only for cells on which enough sources agreed, chained from
each cell's last reported minute and signed by the reporter key. With no answer from any source it submits
nothing, the heartbeat ages and the book stops selling. Then, when policies closed out of order have left the
book's `oldestOpenId` behind the oldest policy the keeper has seen open, it walks the mark up with
`syncOldestOpen` (at most `KEEPER_SYNC_STEPS` steps per tick): a provider's exit waits for that mark to pass the
cover sold before the request. It then settles the policies that have a payout due or a fully reported window,
in batches, and closes with `expire` the policies whose window ended more than the book's `expiryGrace` ago
without the oracle reporting all of it (`expire` pays what was reported, then releases the rest of the
exposure). Schedule it every five minutes; `KEEPER_FIRST_READING_SECONDS` should equal the interval.

The keeper walks the book with a cursor kept in the state store: every policy below its low mark is closed,
and each tick reads the next `KEEPER_SCAN_LIMIT` ids, wrapping back to the low mark at the end. A policy that
stays open holds the low mark back but not the walk, so every open policy is read at least once every
`ceil((policyCount - low + 1) / KEEPER_SCAN_LIMIT)` ticks. Per tick the keeper reads at most
`KEEPER_SCAN_LIMIT` policies and sends one report per `KEEPER_MAX_READINGS_PER_REPORT` readings, at most one
`syncOldestOpen`, one `settleMany` per `KEEPER_SETTLE_BATCH` due policies (fewer when their closes would not fit
one transaction's gas), and at most `KEEPER_EXPIRE_PER_TICK` expiries.

**Paid cover (x402).** `exact` scheme on `eip155:<chainId>` in the dollar token, paid to the relayer address.
The order is: price → verify with the facilitator → check the book would sell → settle → buy. A payment is
identified by payer and authorization nonce and is claimed in the ledger before anything happens, so the same
payment sent twice, or twice at once, yields one settlement and one policy. Once settled, the purchase is
recorded with its signed quote and every retry reuses that quote, so the book itself rejects a duplicate. If
the purchase fails after settlement the answer is `cover_pending` with the payment id, and the same request
finishes it without charging again. Agents paying with a token that is not a default asset of their x402
client (the test dollar) must allow it in the client's spend controls.

**Blob store.** The service keeps bytes it cannot read. A write signs `BlobWrite(owner, name, contentHash,
issuedAt)` and a read signs `BlobRead(owner, name, issuedAt)` under the domain `{ name: "Cover Blob Store",
version: "1", chainId }`, sent in `x-blob-signature` and `x-blob-issued-at`. A write must match the bytes
exactly and be newer than the stored version, so a captured request can neither be pointed at other content
nor used to roll back. The typed data builders are exported from `@cover/service/blob-auth`.

**Sandbox.** Off unless `SANDBOX_ENABLED=true`, never on chain 143: the configuration is rejected and the
handlers refuse independently. With it on, the keeper reports the one simulator cell from the storm switch
instead of the weather sources and marks those readings `"source": "simulator"`; it also keeps the heartbeat
alive when the real sources are silent, which a production deployment never does.

## Storage

Every store is an interface with two implementations.

| Store | In memory | Postgres |
|---|---|---|
| Relayer nonce | mutex per signer | `cover_relayer_nonces`, row lock |
| Rate limits | counters | `cover_rate_limits`, atomic upsert |
| Ledger (idempotency) | map | `cover_ledger`, single-statement claim |
| State (keeper cursor, storm switch) | map | `cover_state` |
| Blobs | map | `cover_blobs` |

Set `DATABASE_URL` to use Postgres; the tables are created on start (`migrate`, `SCHEMA`). In-memory stores
coordinate nothing between processes and suit a single long-running server or development only.

The nonce lock is one row per signer:

```sql
CREATE TABLE cover_relayer_nonces (
  chain_id   bigint      NOT NULL,
  address    text        NOT NULL,
  next_nonce bigint,                -- NULL: read it from the chain on next use
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chain_id, address)
);
```

A relay opens a transaction, takes the row `FOR UPDATE`, simulates, signs, sends, waits for the receipt, writes
`next_nonce` and commits. Other instances block on the row for at most 20 seconds and then answer
`relayer_busy`. If an instance dies its connection drops and the lock is released with the nonce unchanged;
had its transaction been broadcast, the next relay meets "nonce too low", re-reads the chain and continues. A
row lock inside a transaction also works through a transaction-mode pooler, where session advisory locks do
not.

## Configuration

Everything comes from environment variables, parsed once in `src/config.ts`. [`.env.example`](.env.example)
lists every variable with its default; a test keeps that file and the parser in step. Required: `CHAIN_ID`,
`RPC_URL`, the four contract addresses, `UNDERWRITER_PRIVATE_KEY` and `RELAYER_PRIVATE_KEY`. A missing or
malformed variable stops the service with a message that names the variable and never prints its value.

## Tests

```sh
pnpm --filter @cover/service test              # everything
pnpm --filter @cover/service test:unit         # no chain needed
pnpm --filter @cover/service test:integration  # needs Foundry 1.8 or newer
pnpm --filter @cover/service typecheck
```

The unit tests run the handlers against an in-memory chain and cover validation, the refusals, replays and
races. The store tests run the same assertions against the in-memory and the Postgres implementations; Postgres
is an embedded instance unless `TEST_DATABASE_URL` points at a server, which also exercises the row lock across
connections.

The integration tests start `anvil --network monad`, deploy the contracts with `contracts/script/Deploy.s.sol`
(test dollar included) and run the service in-process against it: faucet → gasless deposit → heartbeat → quote
→ relayed purchase → signed weather report → payouts and close, checking every balance; the over-cap sale and
the stale heartbeat are refused; and a cover purchase is paid with the x402 client and settled by the x402
facilitator logic running locally. A third suite builds a book of about 400 policies whose oldest-open mark
lags far behind, measures the worst-case settlement, expiry and catch-up against the gas limits, has the keeper
catch the mark up, measures leaving the pool, and turns on served areas to see a quote refused and a purchase
made in one. Weather and pricing are stand-ins there; nothing touches a public network.
`anvil` is looked up on `PATH` and under `~/.foundry`; set `ANVIL_BIN` or `FORGE_BIN` to choose one.

## Security notes

- **Three keys, three powers.** The underwriter key can commit pool capital up to the on-chain caps; the
  reporter key decides what was wet; the relayer key only holds gas and, in passing, paid-cover premiums. The
  configuration refuses to reuse one key for two roles.
- **The relayer cannot be steered.** Callers supply arguments, never targets, selectors, gas limits or value.
  The allow-list is built from signatures in `src/relayer/allowlist.ts` alone and checked against the ABIs at
  start. Every payment signature is bound on chain to its payee and, for purchases, to the quote digest, so
  the relayer cannot redirect or re-purpose it either.
- **Signatures are checked before gas is at stake**, and a holder's rate limit is counted only after their
  signature verifies, so a stranger cannot use it up. `/quote` is unauthenticated: its per-holder limit can be
  consumed by anyone who knows the address, within their own per-IP limit.
- **What the relayer will pay for anyone:** a signed token transfer (`/relay/transfer`) and a settlement that
  changes something. Both are bounded by the per-IP, per-address and global limits; `RATE_RELAY_GLOBAL` times
  the gas limits is the most the relayer can spend per minute.
- **Rate limits by IP trust one header.** Set `CLIENT_IP_HEADER` and `TRUSTED_PROXY_HOPS` to what the hosting
  platform guarantees; requests without a usable address share one bucket.
- **Secrets.** Shared secrets must be at least 24 characters and are compared in constant time. Responses never
  carry keys, stack traces or node URLs: unexpected failures return a reference and are logged under it, with
  the node URL masked.
- **An x402 payment names a payee and an amount, not an order.** Whoever presents it first decides which
  holder and window it buys, as with any x402 resource, so it must only ever travel over TLS.
- **Known limits.** A payment whose settlement call never answered stays claimed and is not retried
  automatically; it has to be reconciled by hand from the logged payment id. A payment that settled for a
  window that can no longer be bought needs a manual refund. A book with many open policies is walked over
  several ticks, so a payout can wait up to one full pass of the scan cursor.
