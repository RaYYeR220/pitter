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
| `POST` | `/relay/settle` | open, rate-limited | `{ ids }` (at most 10) → `settleMany` for the policies with something to settle; sends nothing otherwise. |
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
| `window_invalid`, `window_too_soon`, `window_too_long`, `window_too_far`, `rate_too_high`, `policy_too_large` | 422 | The cover asked for is not on offer. |
| `capacity_exhausted`, `too_many_cells` | 409 | The pool cannot back it now; `details.capacity` says how much room there is. |
| `oracle_stale` | 503 | The weather index has not reported recently; sales are paused. |
| `would_revert` | 409 | The transaction would fail on chain; `details.reason` is the contract's error. Nothing was sent. |
| `quote_expired`, `in_progress`, `reverted` | 409 | Ask for a new quote; wait for the first request; or the transaction was included and failed. |
| `relay_pending` | 504 | Sent, not confirmed in time; `details.transactionHash` can be checked later. |
| `relayer_unfunded`, `relayer_busy`, `gas_price_too_high`, `rpc_unavailable` | 502/503 | The relayer cannot send right now. A user with gas can call the contracts directly. |
| `rate_limited` | 429 | See `retry-after`. |

### What cannot be relayed

Leaving the pool is not gasless. `requestRedeem`, `cancelRedeemRequest` and `redeem` act on `msg.sender` and
the contracts offer no signed variant, so a liquidity provider sends those transactions with their own gas.

## How the pieces work

**Quotes.** A quote is signed only if the book would accept it at that moment: minute-aligned window, within
the duration bounds and the cover horizon, starting after the lead time, rate under `QUOTE_MAX_RATE_PER_SECOND`,
maximum payout within the policy limit and within what the pool has free in total and in the cell (measured on
`activeAssets`), and a fresh oracle heartbeat. The premium comes from the pricing model in `@cover/core` and is
floored at the book's `minPremium` and at `QUOTE_MIN_PREMIUM_BPS` of the maximum payout. A quote expires after
`QUOTE_TTL_SECONDS`, and never later than the last moment the book would still take it.

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
| `settleMany(n)` | cover book | 90,000 + 190,000 n | 189,525 for one payout |
| `depositWithAuthorization` | cover pool | 280,000 | 178,777 |
| `transferWithAuthorization` | token | 160,000 | 103,023 |
| `approve` (paid cover only, spender must be the book) | token | 90,000 | 52,103 |
| `drip` (sandbox only) | token | 150,000 | 109,468 |
| `submit` | weather index | 75,000 + 52,000 per reading + 40,000 more per new cell | 55,513 empty, 134,746 with one new cell |

Monad charges for the limit, not for the gas used, so the limits are measured worst cases plus headroom for
native USDC rather than round numbers. The measurements are from the integration tests below and agree with
`contracts/snapshots/Gas.json`.

**Keeper.** A tick reads the cells with open cover, asks the weather module in `@cover/core` about them and
about one reference cell, and submits readings only for cells on which enough sources agreed, chained from
each cell's last reported minute and signed by the reporter key. With no answer from any source it submits
nothing, the heartbeat ages and the book stops selling. It then settles the policies that have a payout due or
a fully reported window, in batches. Schedule it every five minutes; `KEEPER_FIRST_READING_SECONDS` should
equal the interval.

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
facilitator logic running locally. Weather and pricing are stand-ins there; nothing touches a public network.
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
- **Known limits.** A payment whose settlement call never answered stays claimed and is not retried
  automatically; it has to be reconciled by hand from the logged payment id. A payment that settled for a
  window that can no longer be bought needs a manual refund. The keeper finds open policies by scanning from
  the oldest open one, `KEEPER_SCAN_LIMIT` per tick. Policies the oracle never finished reporting are not
  expired by the keeper; `expire` is permissionless.
