# API for partners and agents

A delivery platform, a fleet or a software agent can price cover for a rider and buy it with one paid HTTP
request. No account and no API key: the request pays for itself with [x402](https://www.x402.org).

The full list of service endpoints, including the ones only the app uses, is in the
[service README](../service/README.md#endpoints).

## Where it runs

| | |
|---|---|
| Base URL | `https://pitter-cover.vercel.app/api` (Monad testnet, practice mode) |
| Health | [`GET /api/health`](https://pitter-cover.vercel.app/api/health): chain, contracts, oracle freshness, relayer funding, practice mode, and whether paid cover is on |
| Price | `GET /api/quote`: works on the live app |
| Paid cover | `POST /api/v1/cover`: **switched off on the live app**. `/api/health` shows `"paidCover":{"enabled":false}` and the endpoint answers 503 `not_configured`. It is implemented in [`service/src/x402/cover.ts`](../service/src/x402/cover.ts) and tested end to end in `service/test/integration/paid-cover.test.ts`; a deployment turns it on with `X402_ENABLED=true` and a facilitator URL. |

Conventions: amounts are base units of the dollar token (six decimals, so `2000` is $0.002); times are unix
seconds on a full minute; large integers travel as decimal strings. Errors are
`{ "error": { "code", "message", "details"? } }` with a matching HTTP status.

## Ask for a price

`GET /api/quote?lat&lon&start&end&rate&holder`. Free, rate-limited per IP and per holder. Nothing is
reserved and nothing is charged.

| Parameter | |
|---|---|
| `lat`, `lon` | where the rider works; the cover is for the 0.05 degree cell around it (about 5 km) |
| `start`, `end` | the window, on full minutes; at most 12 hours long, ending at most 12 h 30 min from now; on mainnet starting at least 10 minutes from now |
| `rate` | what the cover pays per second of heavy rain, in base units. `2000` is $0.12 a minute |
| `holder` | the rider's address; payouts go there |

```sh
API=https://pitter-cover.vercel.app/api
START=$(( ($(date +%s) / 60 + 2) * 60 )); END=$(( START + 1800 ))
curl -s "$API/quote?lat=52.23&lon=21.01&start=$START&end=$END&rate=2000&holder=0x000000000000000000000000000000000000dEaD"
```

A real answer from the live app (one of the three slots shown):

```json
{
  "quote": {
    "holder": "0x000000000000000000000000000000000000dEaD",
    "key": "18446756288596545460",
    "start": "1791890940",
    "end": "1791892740",
    "ratePerSecond": "2000",
    "premium": "135000",
    "expiry": "1791890940",
    "salt": "0xead4ee429758c419108dddf5a33ab1d7ce45c40298ce69e78b350eb89cf4a71e"
  },
  "quoteSig": "0xa494dce8…501b",
  "digest": "0x2e755212…7544",
  "maxPayout": "3600000",
  "cell": { "key": "18446756288596545460", "lat": 52.225, "lon": 21.025 },
  "inputs": {
    "expectedPayout": "108000",
    "expectedWetSeconds": 54,
    "loadBps": 2500,
    "floorBps": 100,
    "models": ["icon_seamless", "gfs_seamless", "meteofrance_seamless"],
    "observation": { "status": "live", "verdict": "dry", "sources": 5, "observedAt": 1791890840 },
    "slots": [
      {
        "start": 1791891000, "end": 1791891900, "seconds": 900,
        "forecastMmPerHour": 0, "precipitationProbability": 3, "probabilityWet": 0.03,
        "basis": "hourly", "model": "gfs_seamless", "observationFloor": false
      }
    ]
  },
  "warnings": [],
  "capacity": {
    "assets": "500307500",
    "lockedExposure": "0",
    "cellExposure": "0",
    "globalLimit": "400246000",
    "cellLimit": "125076875",
    "globalRemaining": "400246000",
    "cellRemaining": "125076875",
    "maxPolicyPayout": "500000000",
    "available": "125076875"
  }
}
```

- `premium` is what the cover costs, `maxPayout` the most it can pay (`rate × seconds`).
- `inputs.slots` explains the price slot by slot; [pricing.md](pricing.md) explains the rule.
- `capacity.available` is the largest maximum payout a new cover in this area could have right now.
- The signed `quote` is what the app's own purchase path posts back to `/api/relay/buy` with the holder's
  ERC-3009 signature (nonce `digest`). A partner buying with x402 does not need it.

## Buy cover for a rider

`POST /api/v1/cover` with a JSON body:

```json
{ "lat": 52.23, "lon": 21.01, "start": "1791890940", "end": "1791892740", "rate": "2000",
  "holder": "0x000000000000000000000000000000000000dEaD" }
```

The same fields and limits as the quote. The holder does not sign anything; the partner pays.

### 1. Without a payment: 402 with the price

```sh
curl -si -X POST "$API/v1/cover" -H 'content-type: application/json' \
  -d "{\"lat\":52.23,\"lon\":21.01,\"start\":\"$START\",\"end\":\"$END\",\"rate\":\"2000\",\"holder\":\"0x000000000000000000000000000000000000dEaD\"}"
```

On the live app today this answers `503 {"error":{"code":"not_configured","message":"This endpoint is not
enabled"}}`. With paid cover on, the answer is `402 Payment Required` with a `PAYMENT-REQUIRED` header (an
x402 version 2 `PaymentRequired`, base64-encoded) and this body:

```json
{
  "error": { "code": "payment_required", "message": "Payment required" },
  "premium": "135000",
  "maxPayout": "3600000",
  "cell": { "key": "18446756288596545460", "lat": 52.225, "lon": 21.025 },
  "inputs": { "…": "as in the quote" },
  "warnings": [],
  "capacity": { "…": "as in the quote" },
  "accepts": [
    {
      "scheme": "exact",
      "network": "eip155:10143",
      "asset": "<dollar token address>",
      "amount": "135000",
      "payTo": "<relayer address>",
      "maxTimeoutSeconds": 120,
      "extra": { "name": "<token EIP-712 name>", "version": "<token EIP-712 version>" }
    }
  ]
}
```

On mainnet `network` is `eip155:143` and `asset` is native USDC.

### 2. With a payment: the cover

Sign the payment the `accepts` entry describes (the `exact` scheme on EVM: an ERC-3009 authorization of
`amount` of `asset` to `payTo`) and send the same request again with it in the `PAYMENT-SIGNATURE` header.
The service then:

1. prices the request again and signs a quote for exactly the amount paid, provided it still covers the
   price (otherwise 402 "The price has changed", and nothing is charged);
2. verifies the payment with the facilitator;
3. simulates the purchase, so a cover the book would refuse is refused before any money moves;
4. settles the payment through the facilitator;
5. buys the cover for `holder` from the relayer's balance.

The answer is `200` with a `PAYMENT-RESPONSE` header and:

```json
{
  "policyId": "42",
  "holder": "0x000000000000000000000000000000000000dEaD",
  "quote": { "…": "the signed quote" },
  "digest": "0x…",
  "transactionHash": "0x…",
  "payment": { "success": true, "transaction": "0x…", "network": "eip155:10143", "payer": "0x…", "amount": "135000" }
}
```

From then on the cover settles like any other, and payouts go to `holder`.

### Paying from an agent

The integration test pays the way an agent would, with the x402 client libraries
(`@x402/core`, `@x402/evm` 2.28):

```ts
import { x402Client } from '@x402/core/client'
import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from '@x402/core/http'
import { toClientEvmSigner } from '@x402/evm'
import { registerExactEvmScheme } from '@x402/evm/exact/client'
import { privateKeyToAccount } from 'viem/accounts'

const url = 'https://<deployment>/api/v1/cover'
const headers = { 'content-type': 'application/json' }
const body = JSON.stringify({ lat: 52.23, lon: 21.01, start, end, rate: '2000', holder })
const payer = privateKeyToAccount(process.env.PAYER_KEY as `0x${string}`)

const offer = await fetch(url, { method: 'POST', headers, body })
if (offer.status !== 402) throw new Error(await offer.text())

const required = decodePaymentRequiredHeader(offer.headers.get('payment-required')!)
const client = registerExactEvmScheme(new x402Client(), { signer: toClientEvmSigner(payer) })
const payment = await client.createPaymentPayload(required)

const bought = await fetch(url, {
  method: 'POST',
  headers: { ...headers, 'payment-signature': encodePaymentSignatureHeader(payment) },
  body,
})
console.log(bought.status, await bought.json()) // 200 { policyId, transactionHash, … }
```

The test dollar is not a default asset of x402 clients; allow it in the client's spend controls (the test
calls `setSpendControls(false)`).

### Safe to repeat

A payment is identified by its payer and its authorization nonce, and claimed in the service's ledger before
anything happens. Sending the same paid request twice, or twice at once, gives one settlement and one cover:

| Answer | Meaning | What to do |
|---|---|---|
| `200` again | this payment already bought its cover | nothing; the body is the first answer |
| `409 payment_in_progress` | the first request with this payment is still running | wait and send it again |
| `409 payment_already_used` | this payment was made for a different request | nothing; it is spent |
| `502 cover_pending` | the payment settled but the cover is not issued yet; `details.paymentId` | send the same request again; it finishes without charging again |
| `502 settlement_unknown` | the facilitator did not answer about the settlement | do not pay again; the payment is kept for reconciliation |

### Refusals

A refusal names its reason and charges nothing:

| Code | Status | Meaning |
|---|---|---|
| `invalid_request`, `invalid_json`, `invalid_payment` | 400 | the body or the payment header failed validation; `details.issues` lists fields |
| `window_invalid`, `window_too_soon`, `window_too_long`, `window_too_far`, `rate_too_high`, `policy_too_large`, `premium_too_small` | 422 | that cover is not on offer |
| `area_not_served` | 422 | the book sells only in served areas (mainnet) and this is not one |
| `capacity_exhausted`, `too_many_cells` | 409 | the pool cannot back it now; `details.capacity` says how much room there is |
| `oracle_stale` | 503 | the weather has not been reported recently; sales are paused |
| `would_revert` | 409 | the purchase would fail on chain; `details.reason` is the contract error |
| `facilitator_unavailable` | 502 | the payment facilitator is not reachable |
| `relayer_unfunded`, `relayer_busy`, `gas_price_too_high`, `rpc_unavailable` | 502/503 | the relayer cannot send right now |
| `rate_limited` | 429 | see `retry-after` |
| `not_configured` | 503 | paid cover is switched off on this deployment |

## Reading cover history

The indexer in [`indexer/`](../indexer) serves a GraphQL API over both networks: a holder's covers and
payouts, exposure per area, weather readings, pool totals. It is not hosted yet; run it locally with Docker
Compose and use the queries in [indexer/queries.md](../indexer/queries.md). Everything it shows can also be
read from the contracts directly (see the `cast` commands in [PROOF.md](../PROOF.md#6-check-it-yourself)).
