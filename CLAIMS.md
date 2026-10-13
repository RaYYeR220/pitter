# Claims

Every public statement this project makes, with how you can check it.

| Tag | Meaning |
|---|---|
| **VERIFIED-LIVE** | Happened on a public chain or is visible in the live app now. The evidence is a link. |
| **REPRODUCIBLE** | Anyone can re-run it from this repository: a test, a script or a read-only chain call. |
| **MODELED** | Follows from the design and the tests, but has not been observed with real money at any scale. |
| **NOT-CLAIMED** | We do not claim it. Listed so that nobody reads it into the rest. |

Transaction links point at MonadVision; [PROOF.md](PROOF.md) has the full list and the `cast` commands.

## Product

| Statement | Tag | Evidence |
|---|---|---|
| Cover pays for every minute of heavy rain in your area, while it is still raining. | VERIFIED-LIVE | Testnet: the [payout](https://testnet.monadvision.com/tx/0x4d12b53434ea1defa855dbf9dcfd2cc6ae70e5e82a5e9a36761bd0020a302b5e) landed about one second after the [weather report](https://testnet.monadvision.com/tx/0xf48935fccf010efa66a4acf4fe8623e60952ba143f9e9ab6975275664e6f3478), with the simulator area's rain. Mainnet, real rain and real USDC: Colombo and Davao were reported wet for every second of both 30-minute windows and [one `settleMany`](https://monadvision.com/tx/0xfe2ef821a04a6fa2ecd0b1f6f5b10700a3708be3912b202dc2b3aaa0fec18f1d) paid each cover its full 0.027 USDC five seconds after the [last report](https://monadvision.com/tx/0xd1e2c414872e6156ce6394a500191fbbe17bed5ca5e8c3da3665392e4228ce61) ([PROOF.md §2](PROOF.md#2-mainnet-pilot-with-real-usdc)). On mainnet both covers were settled once, after their windows ended; paying during the rain there needs settlements on every oracle tick, as the testnet keeper does. |
| Heavy rain means 1 mm an hour or more: an area is wet when at least two of up to five sources answer and their median is at or above that. | REPRODUCIBLE | `packages/core/src/weather/aggregate.ts`; `pnpm --filter @cover/core test`; `pnpm --filter @cover/workflow test` runs the same decision on recorded answers of the real sources. |
| Your area is about 5 km across. | REPRODUCIBLE | 0.05 degree cells (`packages/core/src/cells.ts`): 5.5 km north to south, less east to west away from the equator. |
| Cover costs a fraction of a cent a minute while it is on. | VERIFIED-LIVE for dry forecasts; MODELED in general | Mainnet [policy #3](https://monadvision.com/tx/0xca707a0afd31fa8584f110c61ae63498564d29be385c305344c1a004f0709cf2) in dry Warsaw: 0.006394 USDC for an hour paying 0.0033 USDC a minute of heavy rain. The price follows the forecast and the payout chosen; when rain is likely it is not a fraction of a cent. |
| Cover for rain that is already falling is never cheap. | VERIFIED-LIVE; REPRODUCIBLE | Mainnet [policy #1](https://monadvision.com/tx/0xaa4875afe79fe404b689550bf6ef72573ef899e8fdeec031cb626b267ef8f862) and [#2](https://monadvision.com/tx/0xbaa65f1964cc336542dcaf8ac154a73b991377891b8e2a130bd83710ccc01100): premium 0.03375 USDC each for a maximum payout of 0.027. Both paid in full, and the buyer still paid 0.0675 USDC for 0.054 USDC of payouts. Tests: `packages/core/test/pricing*.test.ts` ("charges more than the payout while the nowcast shows rain above the trigger"). |
| One passkey signature pays for the cover and commits to its exact terms; the buyer needs no gas. | VERIFIED-LIVE; REPRODUCIBLE | The mainnet purchases are `buyWithAuthorization` calls sent by the relayer; the holder only signed an ERC-3009 authorization whose nonce is the quote's hash. Tests: `contracts/test/CoverBook.buy.t.sol`, `contracts/test/fork/NativeUsdc.fork.t.sol`. |
| Sign up with a passkey, no seed phrase, nothing to install. | VERIFIED-LIVE; REPRODUCIBLE | <https://pitter-cover.vercel.app/app>; `web/e2e/cover.spec.ts` (virtual passkey with PRF). |
| The passkey alone brings back the account and its cover on a device with no stored data. | REPRODUCIBLE | First end-to-end test: storage and cookies wiped, sign in, same account, same cover history. |
| The shift log is encrypted on the device; the server stores bytes it cannot read. | REPRODUCIBLE | `web/lib/shiftlog/crypto.ts`; the first end-to-end test checks that the uploaded body contains none of the plaintext; the second opens the log in a fresh browser with the same passkey. |
| The pool refuses cover it cannot back, in total and per area. | VERIFIED-LIVE; REPRODUCIBLE | [`CellCapExceeded()`](https://monadvision.com/tx/0x34b79f1f31213bf11098a1b4c517527c94cff659837dda5f982a859b4e7eb5d5) on mainnet for a quote signed by the underwriter key itself. Invariant `invariant_LockedExposureIsCoveredByAssets` in `contracts/test/invariant`. |
| The quote service refuses before it signs anything. | REPRODUCIBLE | The mainnet refusal (HTTP 409 `capacity_exhausted`) left no on-chain trace by design; the same refusal is tested in `service/test/unit/quote.test.ts` and the integration suite. |
| Backers earn the cover fees. | MODELED | Premiums net of the 5% fee go to the pool (visible in every purchase). Whether premiums exceed payouts over time is unknown; see NOT-CLAIMED. |
| A backer cannot leave ahead of a payout everyone can see coming. | REPRODUCIBLE | 13-hour notice, and a claim waits until every cover sold before the request has closed: `contracts/test/CoverPool.redeem.t.sol`, `contracts/test/LiquidityExit.t.sol`, invariant `invariant_CoverEndsBeforeTheCapitalBehindItCanLeave`. Not yet exercised on mainnet. |
| Mainnet sells only in 52 served areas (Warsaw grid and twelve cities). | VERIFIED-LIVE | `servedKeys()` on [CoverBook](https://monadvision.com/address/0x8C7f6A8b09176c893da3ee4C1cbCd2d8ec26E770); `contracts/deployments/143.json`. |
| Partners and agents can buy cover for a rider with one paid HTTP request (x402). | REPRODUCIBLE | `service/src/x402/cover.ts`; `service/test/integration/paid-cover.test.ts` pays with the x402 client and settles with the facilitator logic running locally. Switched off on the live app (`/api/health` shows `"paidCover":{"enabled":false}`). |

## Chain and oracle

| Statement | Tag | Evidence |
|---|---|---|
| The contracts are deployed on Monad mainnet with native USDC and on Monad testnet, with verified source. | VERIFIED-LIVE | [PROOF.md §1](PROOF.md#1-contracts) |
| The oracle is a Chainlink CRE workflow built with the official SDK, and its reports reach the chain. | VERIFIED-LIVE (simulation delivery) | Reports through the MockKeystoneForwarder: [testnet](https://testnet.monadvision.com/tx/0xe41aa168ce53dfee555eca1d1d9fe8a60a756c2ce88a7dcac76563553f039cb3), [mainnet](https://monadvision.com/tx/0x856b1a8c943052e7c16e06b1666524706e03cef1668d33dd317bad142e5e0508), and the dry and wet reports in PROOF.md §2. Delivered with `cre workflow simulate --broadcast`, not by a DON. |
| Every report must carry the reporter's signature, on both entry points, so the permissionless simulation forwarder cannot inject one. | REPRODUCIBLE | `WeatherIndex._ingest`; `contracts/test/WeatherIndex.t.sol` with `test/mocks/PermissionlessForwarder.sol`; invariant `invariant_ForgedReportsAreNeverAccepted`. |
| With fewer than two answering sources nothing is reported, the heartbeat ages and sales stop. | REPRODUCIBLE | `workflow/test/oracle.test.ts`; `OracleStale` tests in `contracts/test`. |
| The payout lands seconds after the report. | VERIFIED-LIVE | Testnet report at 11:10:19, payout at 11:10:20, three blocks apart ([PROOF.md §5](PROOF.md#5-testnet-the-whole-flow-in-a-browser)). |
| Monad bills the gas limit, so each relayed call carries a measured limit. | VERIFIED-LIVE; REPRODUCIBLE | Receipts show `gasUsed` equal to the limit (700,000 for `buyWithAuthorization`). Limits measured in `service/test/integration/gas.test.ts` on `anvil --network monad`. |
| The relayer uses `eth_sendRawTransactionSync`. | REPRODUCIBLE | `service/src/relayer/rpc.ts`, falling back to a normal send where the node lacks it. |
| Accounts are Mera passkey accounts with PRF-derived keys; a second PRF namespace encrypts the shift log. | REPRODUCIBLE | `web/lib/account/derive.ts`, `web/lib/shiftlog/crypto.ts`, `web/test/*`. |

## Engineering

| Statement | Tag | Evidence |
|---|---|---|
| Contracts: 412 tests pass, 10 fork tests skipped without an RPC (422 with one), including 16 fuzz tests and 12 invariants over 8,192 calls each. | REPRODUCIBLE | `cd contracts && forge test` |
| core 154, service 434 (+1 skipped), workflow 45, indexer 37, web 258 plus 2 end-to-end tests. | REPRODUCIBLE | Commands in the [README](README.md#tests). |
| An independent review before the mainnet deployment found no critical or high-severity issues; three medium and two low ones were fixed with regression tests. | REPRODUCIBLE (the fixes) | The behaviours and their tests are in [docs/security.md](docs/security.md). The review report is not published in this repository. |

## NOT-CLAIMED

- **Not insurance.** Pitter is parametric cover. There is no insurer, no regulator's approval and no claims process.
- **Not delivered by Chainlink's production DON.** The workflow runs in the CRE CLI simulator on the maintainers' machine. Chainlink told us that deploying to their production DON needs a commercial agreement; that is the next step. There is no node consensus today.
- **Not a decentralised oracle.** One reporter key decides what was wet, bounded only by the caps on open cover.
- **No claim that the price is right.** The pricing model has not been assessed against real loss data. We do not claim premiums cover payouts over time, or that backers make money.
- **No commercial weather licence.** Open-Meteo's free tier is for non-commercial use. Three of the five sources are models from that one provider.
- **No claim about rain on a particular street.** The trigger is the sources agreeing about a 0.05 degree cell.
- **Not live: paid cover over x402** (switched off on the deployed app) **and a hosted indexer** (the indexer runs locally; the app reads the chain directly).
- **No real riders yet.** The three mainnet covers were bought by the maintainers' own address, for cents.
- **No mainnet payout during the rain yet.** The two mainnet covers were each settled once, in full, after their windows had ended.
- **No multisig or timelock.** The owner of every contract, on both networks, is the deployer key.
- **No gasless exit from the pool.** Leaving needs MON for gas.
- **No support for passkey managers without PRF** (Bitwarden, Dashlane, a local Chrome profile, Windows Hello before 25H2).
- **No claim about MIP-8 or page-based storage.** Each `WeatherIndex` checkpoint packs into one storage slot and a key's checkpoints are contiguous, but the layout was not designed or measured against MIP-8.
- **No named auditor and no published audit report.**
