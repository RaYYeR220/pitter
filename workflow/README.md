# Weather oracle workflow

A [Chainlink Runtime Environment](https://docs.chain.link/cre) workflow that tells the contracts where it rains.
Every five minutes it:

1. reads the cells that have open cover from `CoverBook.activeCells()`;
2. asks independent weather sources about each cell, in at most 15 HTTP requests;
3. calls a cell wet when at least two sources answer and their median is heavy rain (1.0 mm/h or more);
4. writes one signed reading per cell to `WeatherIndex`, continuing each cell's timeline from where it ended.

A cell without two answering sources gets no reading, and when no cell has two, nothing is written at all: the
index heartbeat goes stale and the contracts stop selling cover until the sources are back. Nothing is ever
filled in.

The decision logic lives in `@cover/core` (`packages/core/src/weather`) and is the same code the service keeper
runs. This folder only connects it to the CRE capabilities.

## Layout

| File | |
|---|---|
| `main.ts` | entry point compiled to WASM |
| `workflow.ts` | cron trigger and the handler: EVM reads, HTTP in node mode, secret, report, EVM write |
| `src/oracle.ts` | one oracle run, independent of where it executes |
| `src/config.ts` | config schema |
| `src/local.ts`, `scripts/run-local.ts` | the same run outside CRE, for a local chain or a dry run |
| `workflow.yaml`, `project.yaml` | CRE targets `monad-testnet` and `monad-mainnet` and their RPC endpoints |
| `config.testnet.json`, `config.mainnet.json` | workflow config per target |
| `secrets.yaml`, `.env.example` | the secret the workflow reads and where it comes from in simulation |

## Requirements

- the CRE CLI, version 1.30.0 or newer for Monad testnet (built and tested with 1.38.0), on your `PATH` as `cre`;
- `pnpm install` at the repository root. It installs Bun, which the CRE TypeScript toolchain needs, as a dev
  dependency, so run the commands below through `pnpm` (or put `workflow/node_modules/.bin` on your `PATH`);
- for simulation only: a CRE account and `cre login`. Building, hashing and the tests need no account.

## Configuration

`config.<target>.json`:

| Field | |
|---|---|
| `schedule` | cron with seconds. `20 */5 * * * *` runs 20 s after every fifth minute, so the minute being reported is over |
| `chainSelectorName`, `isTestnet`, `chainId` | the chain the contracts are on |
| `coverBook`, `weatherIndex` | contract addresses. Leave empty to use the ones recorded in `packages/core/src/deployments/<chainId>.json` |
| `multicall3` | used to read `lastTo` for many cells in one call |
| `userAgent` | identifies you to the weather sources. Put a contact in it; MET Norway blocks anonymous callers |
| `thresholdMmPerHour` | rain intensity that counts as wet |
| `intervalSeconds` | how far back the first reading of a new cell reaches |
| `maxHttpRequests` | at most 15, the CRE limit per run |
| `heartbeatCell` | cell observed while no cover is open, so that the first cover can be sold. `null` switches it off |
| `httpTimeout`, `httpCacheMaxAge` | per request; the cache lets the nodes of a DON judge the same answers |
| `gasLimitBase`, `gasLimitPerReading` | gas limit of a write is `base + perReading x readings`. Monad charges the limit |

Secrets and keys, from `.env` in this folder (copy `.env.example`) or from the environment:

| Variable | Needed for | |
|---|---|---|
| `REPORTER_KEY` | every run | private key of the address set as `reporter` in `WeatherIndex`. It signs each report (EIP-712) |
| `CRE_ETH_PRIVATE_KEY` | `--broadcast` | pays for the transaction; 64 hex characters without `0x`; needs MON |

On-chain, before a broadcast can land:

- `WeatherIndex.reporter()` is the address of `REPORTER_KEY`;
- the forwarder of the target is allowed: `WeatherIndex.setForwarder(<forwarder>, true)`. For simulation on Monad
  testnet that is the simulation forwarder `0xB9F79d863261869B234c481D1f9A7af84AeAd192`. It relays reports from
  anyone, which is why every report also carries the reporter's signature.

## Build

```sh
pnpm --filter @cover/workflow build        # cre workflow build .
```

```
  Compiling workflow...
✓ Workflow compiled successfully
  Binary hash: <64 hex characters>
✓ Build output written to .../workflow/binary.wasm
```

`pnpm --filter @cover/workflow hash` prints the binary, config and workflow hashes of that build.

## Simulate

Run from this folder, logged in (`cre login`).

Dry run: reads the chain and the weather sources, builds and signs the report, sends nothing.

```sh
cre workflow simulate . --target monad-testnet --non-interactive --trigger-index 0
```

Broadcast: the same, and the report is sent through the simulation forwarder to `WeatherIndex.onReport`.

```sh
cre workflow simulate . --target monad-testnet --non-interactive --trigger-index 0 --broadcast
```

(`pnpm --filter @cover/workflow simulate` and `simulate:broadcast` run the same commands with Bun on the `PATH`.)

What to expect, with two cells under cover, one of them in the rain:

```
Workflow compiled
<time> [USER LOG] report issuedAt=1791874681 readings=2 wet=1 delivered tx=0x3f0c…
<time> [USER LOG] oracle run: {"outcome":"reported","now":1791874681,"activeCells":2,"observed":2,"wet":1,"dry":1,"unknown":0,"httpRequests":5,"reports":[{"issuedAt":"1791874681","readings":2,"wetReadings":1,"accepted":true,"txHash":"0x3f0c…"}]}

Workflow Simulation Result:
 "{\"outcome\":\"reported\", … }"
```

- In a dry run the transaction hash is all zeros: nothing was sent.
- `outcome` is `reported` (readings written), `heartbeat` (no cover open, or every cell already up to date: an
  empty report keeps the index alive), `no-quorum` (no cell had two answering sources: nothing written),
  `nothing-to-report` or `idle` (no cover open and no heartbeat cell).
- `accepted: false` with a transaction hash means the transaction was mined but the index refused the report:
  wrong reporter key, forwarder not allowed, or a newer report already landed.

After a broadcast, check the index:

```sh
cast call <weatherIndex> "heartbeat()(uint64)" --rpc-url https://testnet-rpc.monad.xyz
cast call <weatherIndex> "lastTo(uint256)(uint64)" <key> --rpc-url https://testnet-rpc.monad.xyz
```

`heartbeat` is the `issuedAt` of the report and `lastTo` the end of the reading, both from the log line above.

Simulation runs on one machine: there is no node consensus, and the simulation forwarder checks nothing. A
deployed workflow needs deploy access from Chainlink; nothing in the code changes for it.

## Run it without CRE

`scripts/run-local.ts` performs the same run with the chain read over JSON-RPC and the sources fetched directly.

```sh
# what would be written for these points right now (no chain needed)
pnpm --filter @cover/workflow run:local --cells "52.23,21.01;59.88,-1.296"

# the cells with open cover on a chain, dry run
pnpm --filter @cover/workflow run:local --rpc http://127.0.0.1:8545 --cover-book 0x… --weather-index 0x…

# and submit with WeatherIndex.submit (local chains only; REPORTER_KEY must be the index's reporter)
REPORTER_KEY=0x… pnpm --filter @cover/workflow run:local --rpc http://127.0.0.1:8545 --cover-book 0x… --weather-index 0x… --submit
```

It prints what every source said for every cell, the verdict, and each report with its digest, signature and
payload. `--json` prints the same as JSON. `WEATHER_USER_AGENT` overrides the `userAgent` of the config and
`SENDER_KEY` chooses who pays for `--submit` (default: the node's first unlocked account).

## Tests

```sh
pnpm --filter @cover/workflow test         # bun test
```

- `test/oracle.test.ts`: the run against a recorded snapshot of the real sources: wet, dry, sources that
  disagree, a source down, all sources down, chaining, reports of more than 20 readings, the heartbeat;
- `test/workflow.test.ts`: the CRE handler on the SDK's test runtime with the EVM, HTTP and secret capabilities
  mocked: what it reads, which requests it makes, the exact bytes it hands to the forwarder;
- `test/run-local.test.ts`: a local chain (`anvil`) with the contracts from `contracts/out`: heartbeat, sale,
  report, payout, chained report, refused reports, delivery through `onReport`. Skipped without `anvil` or the
  contract build;
- `test/wasm-signing.test.ts`: compiles the signing path with Javy and runs it in the engine the workflow runs
  in; digest, signature and payload match the ones computed outside. Skipped until `cre workflow build` has
  downloaded Javy.

## Sources

| Source | What is read | Requests |
|---|---|---|
| [Open-Meteo](https://open-meteo.com) | precipitation of the last 15 minutes from three forecast models: DWD ICON, NOAA GFS, Météo-France | one for up to 200 cells |
| [aviationweather.gov](https://aviationweather.gov/data/api/) | the latest METAR of the nearest airport within 40 km: rain, and how hard, as observed | one per area of about 6° x 10° |
| [MET Norway](https://api.met.no) | precipitation of the current hour | one per cell, while requests remain |

Each model counts as a source, and so does the airport observation and MET Norway. An observation older than 90
minutes, a model step older than an hour and a forecast older than two hours are not answers.

Open-Meteo and MET Norway data are licensed CC BY 4.0. Open-Meteo's free API is for non-commercial use; a
commercial deployment needs their paid API. MET Norway requires an identifying `User-Agent`.

## Limits

- **HTTP**: `ceil(cells / 200)` + airport areas + MET Norway for as many cells as fit, never more than 15. One
  city: 2 requests plus one per cell up to 13 cells, and 15 from there on. Cells beyond the budget are judged
  without MET Norway.
- **EVM reads**: 1 + `ceil(cells / 20)`; the CRE limit of 15 covers 280 cells.
- **Writes**: one report per 20 readings, issued a second apart so that they are accepted in order.
- **Gas**: about 0.03 MON for a heartbeat and 0.2 MON for a full report at 100 gwei, with the default limits.
- A reading covers at most three intervals (15 minutes). After a longer silence the oracle resumes one interval
  back and the time in between stays unreported, which the contracts treat as dry.
- Forecast models are estimates and an airport can be kilometres from a cell. The trigger is "the sources
  agree it rains in the cell", which is not the same as rain on one particular street.
