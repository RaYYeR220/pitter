# Pitter

Rain cover you switch on for one shift. It costs a fraction of a cent a minute while it is on, and when heavy rain hits the area you are working in, it pays you for every minute of it — while it is still raining.

Pitter is built for people who work outdoors by the shift, starting with bike and scooter couriers. Sign in with Face ID or a fingerprint, add dollars, turn cover on. There is nothing to install and no claim to file.

## How it works

1. **Price.** The forecast for your area (about 5 km across) sets the price of the next block of cover: the chance of heavy rain from three weather models — taking the wettest of them — times what you would be paid, plus a margin. If any source already sees rain, the next hour is priced as likely wet.
2. **Buy.** One passkey signature authorises the payment and commits to the exact terms of the quote. A relayer submits it, so you never need anything but dollars.
3. **Check.** Every five minutes an oracle reads several independent weather sources, decides per area whether it rained 1 mm an hour or more, signs the result and writes it on chain.
4. **Pay.** Anyone can settle a cover: it pays `wet seconds × your rate`, capped at the maximum you bought, straight to your balance.

Payouts come from a shared pool of dollars put in by backers, who earn the cover fees. The pool refuses to sell more cover than it can pay — in total and per area — and backers leave through a notice period, so capital cannot run ahead of a forecast storm.

## Repository

| Path | What it is |
|---|---|
| [`contracts/`](contracts) | Solidity (Foundry): `CoverBook` (cover, quotes, settlement), `CoverPool` (ERC-4626 pool with exposure caps and ERC-7540-style exits), `WeatherIndex` (signed weather reports, Chainlink CRE receiver), `TestDollar` (practice dollars for the test network) |
| [`packages/core`](packages/core) | Shared TypeScript: ABIs, deployments, EIP-712 types, the area grid, weather sources and aggregation, pricing |
| [`workflow/`](workflow) | The oracle as a Chainlink Runtime Environment workflow |
| [`service/`](service) | Quotes, gasless relaying, the keeper, a pay-per-request endpoint for partners (x402), encrypted blob storage |
| [`indexer/`](indexer) | Envio HyperIndex: cover history, exposure per area, pool statistics |
| [`web/`](web) | The app: cover for riders, the backers' desk, docs |

Each folder has its own README with setup and test instructions.

## Deployments

Monad testnet (chain 10143), verified on MonadVision:

| Contract | Address |
|---|---|
| CoverBook | `0xE0951FC7640Da8bA5071693007607FBa31592ee4` |
| CoverPool | `0x80375eB8BE28a7bffb274C2620E9D70Fe7E70B9f` |
| WeatherIndex | `0x55F06d63A97ae82c67383cFB26B82Fda78e58664` |
| TestDollar | `0x27fe944e3b7037ED9F75b17123b6e2E716DEeF10` |

The full record, including the reporter, underwriter and limits, is in [`contracts/deployments/10143.json`](contracts/deployments/10143.json).

## Run it

```bash
pnpm install
pnpm --filter @cover/core test
cd contracts && forge test
```

See [`web/README.md`](web) for running the app against the test network.

## Development

AI coding tools were used in building this project, as the Metropolis hackathon rules require us to disclose.

## License

[MIT](LICENSE)
