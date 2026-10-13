# Mocks

Where the line between real and simulated runs, for every part of the system. If something is not listed
as simulated here, it is the production code path.

## At a glance

| Part | Live app (Monad testnet) | Mainnet pilot | Tests |
|---|---|---|---|
| Dollars | **Simulated**: `TestDollar`, practice money with no value | Real: native USDC | Local chains deploy `TestDollar`; a fork suite runs against the real USDC |
| Weather | Real sources, **except the one simulator area**, whose rain is a switch | Real sources | Recorded answers of the real sources |
| Prices | Real pricing code, real forecasts (the simulator area too) | Real | Recorded forecasts |
| Oracle delivery | Keeper `submit` from the app, and the CRE workflow in **simulation** | CRE workflow in **simulation**, through Chainlink's MockKeystoneForwarder | Mocked CRE capabilities; a local chain |
| Contracts | Real, verified | Real, verified | Real, plus test-only mocks |
| Passkeys | Real WebAuthn through Mera | No app on mainnet yet | Chromium's virtual authenticator; one test uses a **test-only WebAuthn client** |
| Relayer, keeper, quotes | Real service code | Real service code, run by the maintainers | In-process against in-memory or local chains |
| Paid cover (x402) | Switched off | Not deployed | A local facilitator and a fake one |
| Indexer | Not hosted | Not hosted | Simulated events |

## The live app: practice mode

The live app at <https://pitter-cover.vercel.app> runs on Monad testnet with the service's sandbox switched
on. `/api/health` says so: `"practice":{"enabled":true,...}`.

- **Practice dollars.** `TestDollar` is a six-decimal token with ERC-2612 and ERC-3009 and an open,
  rate-limited `drip`. "Get practice dollars" asks the server to drip some to your account. It has no value
  and exists only on the test network: the deploy script refuses to deploy it anywhere else.
- **The simulator area.** One cell, centred on latitude 0.025, longitude 0.025 (key
  `18446751804650688016`), in the sea off West Africa. Its rain is a switch kept by the service ("Make it
  rain in the simulator area"). The keeper reports that one cell from the switch instead of the weather
  sources and marks those readings `"source": "simulator"`. Every other cell gets real weather.
- **The price of the simulator area is real**, from the real forecast for that point at sea. It does not know
  about the switch, which is why you can buy cover cheaply there and then make it rain. With real money that
  would be free money; that is why the sandbox cannot run on mainnet (below).
- **"Weather check".** Runs one keeper tick now instead of waiting for the scheduled one, at most once every
  20 seconds for everyone.
- **The heartbeat.** With the sandbox on, the keeper keeps the oracle heartbeat alive even when the real
  sources are silent, so practice never stalls. A production deployment never does this: silent sources
  stop sales.
- The switch is shared: anyone using the live app can turn the simulator area's rain on or off.

Everything else in practice mode is the production path: the contracts, the signed quotes, the caps, the
relayer, the payouts and the account layer.

**The sandbox cannot reach mainnet.** The service refuses to start with `SANDBOX_ENABLED` on chain 143,
its handlers refuse independently, the practice routes of the web app answer 404 outside practice mode, and
`drip` is on the relayer's allow-list only while the sandbox is on. `TestDollar` does not exist on mainnet.

## The oracle: CRE simulation, not a DON

The workflow in `workflow/` is built with Chainlink's CRE TypeScript SDK and compiled to WASM. Today it runs
with `cre workflow simulate --broadcast` on the maintainers' machine:

- **Real:** the compiled workflow, its cron trigger, its HTTP requests to the weather sources, its EVM reads
  of the contracts, and the transaction that delivers the report.
- **Simulated:** there is one machine, so no node consensus; and the report goes through Chainlink's
  MockKeystoneForwarder (mainnet `0x9eF6468C5f37b976E57d52054c693269479A784d`, testnet
  `0xB9F79d863261869B234c481D1f9A7af84AeAd192`), which relays reports from anyone and checks nothing.
- **What makes it trustworthy anyway:** every report carries an EIP-712 signature of the reporter key, and
  `WeatherIndex` verifies it on `onReport` exactly as on `submit`. The mock forwarder can deliver only what
  the reporter signed.
- **Not yet:** delivery by Chainlink's production DON through the KeystoneForwarder
  (`0x76c9cf548b4179F8901cda1f8623568b58215E62` on mainnet, already allowlisted). Chainlink told us that
  deploying a workflow to their production DON needs a commercial agreement. Nothing in the code changes for
  it.

On the test network the live app's keeper also reports, with `WeatherIndex.submit` and the same reporter
key. The decision logic is the same `@cover/core` code in both.

## Passkeys in tests

- **First end-to-end test:** Chromium's virtual authenticator with the PRF extension, attached over the
  DevTools protocol. The app runs its normal WebAuthn code through Mera; the authenticator answers the
  prompts automatically.
- **Second end-to-end test only:** a test-only WebAuthn client (`testPrfClientScript` in
  `web/e2e/support/authenticator.ts`). It runs the real ceremony on the virtual authenticator and computes the
  PRF output itself, because Chromium cannot carry a passkey's PRF secret into a second browser, which is
  what that test needs to show the shift log opening elsewhere.
- **Never in production builds.** The app looks for that client only when `NODE_ENV` is not `production`
  (`web/lib/account/passkey.ts`), so production bundles contain neither the switch nor a way to reach it.

## Mainnet: what is real

- The contracts, verified, owned by the deployer key.
- Native USDC. The pool holds the maintainers' 0.9 USDC seed plus the premiums paid.
- The weather: five real sources, read by the CRE workflow every five minutes.
- The quotes: signed by the production service code with the underwriter key, from real forecasts and
  observations.
- The purchases: one ERC-3009 signature by the buyer, relayed by the production relayer code. The buyer was
  the maintainers' own address.
- The refusal: the quote service refused the over-limit cover and the pool reverted the directly signed one.
- The payouts: Colombo and Davao, 0.027 USDC each, settled with one `settleMany` sent by the relayer after
  both windows were fully reported.
- Not there yet: settlement on every oracle tick on mainnet (both covers were settled once, after their
  windows), the web app pointed at mainnet, the x402 endpoint, a hosted indexer.

## Test doubles

| Where | Double | Why |
|---|---|---|
| `contracts/test/mocks` | `BlockableDollar`, `HookedDollar`, `SilentDollar`, `PermissionlessForwarder`, `ContractSigner`, `BookStub` | A token that blocks holders, one with transfer hooks, one that returns nothing, a forwarder that relays anything, a contract signer (ERC-1271) and a stand-in book |
| `contracts/test/fork` | none: the real native USDC on a Monad mainnet fork | Skipped without `MONAD_RPC_URL` |
| `packages/core/test/fixtures` | Recorded answers of Open-Meteo, aviationweather.gov and MET Norway | Deterministic oracle and pricing tests |
| `workflow/test` | The SDK's test runtime with mocked EVM, HTTP and secret capabilities; a local `anvil` chain | The CRE handler without a DON |
| `service/test/unit` | An in-memory chain, fake stores, a fake x402 facilitator | Validation, refusals, replays and races |
| `service/test/integration` | `anvil --network monad` with the real contracts; stand-in weather and pricing; the x402 facilitator logic running locally | The whole flow and the gas limits under Monad's rules; nothing touches a public network |
| `indexer/test` | Simulated events fed to the real handlers | No chain, database or token needed |
| `web/test` | Fake passkeys, a fake service, a fake market | Account, cover engine, pool and shift log logic |
| `web/e2e` | Virtual authenticator; the test-only WebAuthn client in one test | Runs against the real test network |
