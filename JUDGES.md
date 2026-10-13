# For judges: five minutes

Pitter is rain cover for couriers, switched on for one shift, that pays for every minute of heavy rain
(1 mm an hour or more) in your area (about 5 km). Here is the shortest path through what is real.

No time to click through? Watch the [three-minute demo](https://youtu.be/aJwJBe9ZqO0), the
[CRE workflow run](https://youtu.be/mxlncr7Q8_0) and [one passkey, two keys](https://youtu.be/BcW8xL5A6fc).

## Minute 1: use it

Open <https://pitter-cover.vercel.app/app> (Monad testnet, practice mode). You need a passkey manager with
PRF: iCloud Keychain, Google Password Manager, 1Password, or Windows Hello on 25H2 or newer.

1. **Sign up.** One passkey prompt. No seed phrase, no extension, no gas.
2. **Get practice dollars.**
3. **Use the simulator area**, then **turn cover on**.
4. **Make it rain in the simulator area**, wait until your cover has run for a minute, then **run a weather
   check**.

What to look for:

- The offer states what cover costs a minute and what it pays you a minute of heavy rain. "Why this price"
  lists every 15-minute slot with the weather model that set its price and its chance of heavy rain.
- After the weather check the payout lands in your balance within seconds. Each step has a link to its
  transaction.
- **A refusal.** Choose the highest payout ($0.30 a minute), then lock a shift of 12 hours in the simulator
  area and ask for its price. That is cover paying up to $216 in one area, more than the quarter of the pool
  one area may hold (the test pool held about 500 practice dollars when this was written, so about 125). The
  app refuses before anything is signed: the area is full, with the room left and the area's limit. Nothing
  is charged. If the test pool has grown since, its limit has too; the mainnet refusal in minute 3 does not
  depend on it.

## Minute 2: real money on mainnet

On 13 October the oracle logic found heavy rain in Colombo and Davao, and cover was bought there with real
USDC. Open these on MonadVision:

| | Transaction | Look for |
|---|---|---|
| Purchase, Colombo | [`0xaa4875af…`](https://monadvision.com/tx/0xaa4875afe79fe404b689550bf6ef72573ef899e8fdeec031cb626b267ef8f862) | The sender is the relayer, not the buyer: the buyer signed one ERC-3009 authorization and paid no gas. 0.03375 USDC leaves the buyer, 5% to the treasury, the rest to the pool. `gasUsed` is exactly the 700,000 limit, because Monad bills the limit. |
| Wet report | [`0xd60e30e6…`](https://monadvision.com/tx/0xd60e30e6ebac9a0997cf594466fb6a1ac7f0371cc1539dbdedb0ed2efe5bbf14) | Sent through Chainlink's MockKeystoneForwarder by the CRE workflow; `WeatherReported` with 540 wet seconds for each area. |
| Payouts | [`0xfe2ef821…`](https://monadvision.com/tx/0xfe2ef821a04a6fa2ecd0b1f6f5b10700a3708be3912b202dc2b3aaa0fec18f1d) | Two `PolicySettled`, 0.027 USDC each, the full maximum, both closed. |

Then the honest part: each cover cost 0.03375 USDC for a maximum payout of 0.027. Rain was already falling
when it was bought, so it was priced as certain rain plus the 25% margin. The buyer paid 0.0675 USDC
for 0.054 USDC of payouts. The system does not sell cheap cover for rain that is already falling.

## Minute 3: the system says no, even to its own key

| | Transaction | Look for |
|---|---|---|
| Warsaw cover | [`0xca707a0a…`](https://monadvision.com/tx/0xca707a0afd31fa8584f110c61ae63498564d29be385c305344c1a004f0709cf2) | Maximum payout 0.198 USDC. The pool held 0.970201 USDC, so Warsaw's limit (25%) was 0.24255. |
| The same again | none | The quote service answered HTTP 409 `capacity_exhausted` and signed nothing. |
| Signed by the underwriter key, sent straight to the book | [`0x34b79f1f…`](https://monadvision.com/tx/0x34b79f1f31213bf11098a1b4c517527c94cff659837dda5f982a859b4e7eb5d5) | **Failed.** The pool reverted with `CellCapExceeded()`. |

Decode it yourself:

```sh
cast run 0x34b79f1f31213bf11098a1b4c517527c94cff659837dda5f982a859b4e7eb5d5 --rpc-url https://rpc.monad.xyz
```

The trace ends in `CoverPool::lock(18446756288596545460, 198000)` and `[Revert] CellCapExceeded()`.

## Minute 4: the code that holds it together

| Where | What it guarantees |
|---|---|
| [`WeatherIndex._ingest`](contracts/src/WeatherIndex.sol#L193) | Every report carries the reporter's EIP-712 signature and it is checked on both entry points, so the permissionless simulation forwarder cannot inject one. |
| [`CoverPool.lock`](contracts/src/CoverPool.sol#L182) | The maximum payout is reserved at sale, against at most 80% of the capital in total and 25% per area, measured without capital that has asked to leave. |
| [`CoverBook.buyWithAuthorization`](contracts/src/CoverBook.sol#L249) | The buyer's signature has the quote's hash as its nonce and the book as payee: it buys exactly that cover, once, whoever submits it. |
| [`quotePremium`](packages/core/src/pricing/quote.ts) | The wettest of three models per 15-minute slot, never below 1%, at least 90% for the coming hour while any source reports rain, plus 25%. |
| [`web/lib/shiftlog/crypto.ts`](web/lib/shiftlog/crypto.ts) | A second PRF namespace of the same passkey derives the key that encrypts the rider's shift log, unrelated to the key that moves money. |

## Minute 5: what is not true yet

- [CLAIMS.md](CLAIMS.md) tags every statement and ends with what we do not claim: not insurance, no
  production Chainlink DON delivery yet (it needs a commercial agreement), one reporter key, pricing not
  checked against real loss data, the weather data on a non-commercial free tier.
- [MOCKS.md](MOCKS.md) draws the line between practice mode and the real thing.
- [docs/security.md](docs/security.md) lists every key, what bounds it on chain, and the residual risks.

To re-run the tests: `cd contracts && forge test` (412 passing, 10 fork tests skipped without an RPC) and
`pnpm --filter @cover/core test` (154). The full table is in the [README](README.md#tests); every transaction
above, and the commands to read the same state from the chain, are in [PROOF.md](PROOF.md).
