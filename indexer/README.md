# Indexer

Turns the events of the cover contracts into a GraphQL API: policies and their settlements, weather readings,
exposure per grid cell, the pool's totals and daily series, and redemption requests. Built with
[Envio HyperIndex](https://docs.envio.dev) 3.14.

The queries the app runs are in [queries.md](./queries.md).

## What is indexed

| Contract | Events | Rows they write |
|---|---|---|
| `CoverBook` | `PolicyBought`, `PolicySettled`, `FeeSet` | `Policy`, `Settlement`, totals on `Holder`, `Cell`, `PoolDay`, `PoolState` |
| `CoverPool` | `ExposureChanged`, `Deposit`, `Withdraw`, `RedeemRequest`, `RedeemRequestCancelled`, `RedeemNoticeSet`, `PayoutDeferred`, `DeferredClaimed` | exposure on `Cell` and `PoolState`, liquidity on `PoolDay`, `RedeemRequest`, deferred payouts on `Holder` |
| `WeatherIndex` | `WeatherReported`, `Heartbeat` | `WeatherReading`, last wet and last reading on `Cell`, the heartbeat on `PoolState` |

- `schema.graphql` describes every entity and field; the descriptions show up in the API.
- Rows are stored per chain. An id is unique within a chain and every row carries `chainId`.
- A `Cell` is one weather index key, `(triggerId << 64) | cellId`, decoded into its position on the 0.05 degree
  grid (`src/key.ts`).
- The events do not carry the protocol fee or the redemption notice. `PoolState` starts from the values the
  contracts are deployed with (500 basis points, 13 hours) and follows `FeeSet` and `RedeemNoticeSet`.
- A settlement of a policy the indexer never saw bought stops it: the start block is wrong.

```
config.yaml        contracts, events and one entry per chain
schema.graphql     entities
src/handlers/      one file per contract
src/entities.ts    defaults and helpers shared by the handlers
src/key.ts         key decoding
test/              handler tests on simulated events
```

## Requirements

Node 22.15 or newer (24 recommended), pnpm, Docker. Envio's CLI and runtime are built for Linux and macOS: on
Windows use Docker Compose as below, or work inside WSL 2.

## Environment

| Variable | | |
|---|---|---|
| `ENVIO_API_TOKEN` | required with HyperSync | HyperSync token. Not needed on Envio Cloud, nor with `ENVIO_RPC_ROLE=sync` |
| `ENVIO_RPC_ROLE` | optional | `fallback` (default): HyperSync indexes and the RPC steps in when it stalls. `sync`: index over the RPC alone |
| `ENVIO_RPC_URL_10143`, `ENVIO_RPC_URL_143` | optional | RPC endpoint per chain; defaults to the public Monad endpoints |
| `HASURA_PORT` | optional | Docker Compose only: host port of the GraphQL endpoint, default `8080` |

Copy `.env.example` to `.env` for a local run. `.env` is not committed.

### Getting the API token

1. Sign in at <https://envio.dev/app/api-tokens>.
2. Under **Tokens by package**, expand **Free package**.
3. Enter a token name and press **Create**, then copy the token into `.env` as `ENVIO_API_TOKEN`.

A personal account has one free token. Without a token, and without `ENVIO_RPC_ROLE=sync`, the indexer stops
at start with "An Envio API token is required for using HyperSync as a data-source".

## Run it locally

### Docker Compose (any system)

```sh
cp .env.example .env        # set ENVIO_API_TOKEN, or ENVIO_RPC_ROLE=sync to do without
docker compose up --build
```

This starts Postgres, Hasura and the indexer. GraphQL is at `http://localhost:8080/v1/graphql`; the Hasura
console is at `http://localhost:8080` with the admin secret `testing`. Set `HASURA_PORT` if 8080 is taken.

The image holds a copy of the sources, so pass `--build` after a change. A change to `config.yaml`,
`schema.graphql` or the handlers needs an empty database: `docker compose down -v`, then up again.

### Envio CLI (Linux, macOS, WSL 2)

```sh
pnpm install
cp .env.example .env
pnpm dev                    # starts Postgres and Hasura in Docker, then indexes
```

`pnpm envio dev -r` drops the database and indexes from the start block. `pnpm stop` removes the containers
and the data. The endpoint and the console are the same as above.

### Without a token

`ENVIO_RPC_ROLE=sync` indexes over the RPC instead of HyperSync. The public Monad endpoints answer `eth_getLogs`
for 100 blocks at a time, so this is slow over a long history; it is meant for a quick local look.

## Tests

```sh
pnpm codegen                # types from config.yaml and schema.graphql, into .envio/
pnpm test
pnpm typecheck
```

The handler tests feed simulated events to the real handlers and need neither a chain, a database nor a token.
They are skipped on Windows, where the Envio runtime does not exist. To run them there:

```sh
docker compose run --rm --build --no-deps indexer pnpm test
docker compose run --rm --no-deps -v ./.envio:/indexer/.envio indexer pnpm codegen    # types for the editor
```

Run `pnpm codegen` again after every change to `config.yaml` or `schema.graphql`.

## GraphQL endpoint

| | |
|---|---|
| Local | `http://localhost:8080/v1/graphql` |
| Envio Cloud | `https://indexer.dev.hyperindex.xyz/<deployment-id>/v1/graphql`, shown on the indexer's page |
| Subscriptions | the same address with `ws://` or `wss://` |

Reading needs no key on either.

```sh
curl http://localhost:8080/v1/graphql -H 'content-type: application/json' \
  -d '{"query":"{ PoolState { chainId lockedExposure lastHeartbeat openPolicies totalPremiums totalPayouts } }"}'
```

## Deploy to Envio Cloud

1. Sign in with GitHub at <https://envio.dev/app/login> and pick the organisation.
2. Install the **Envio Deployments** GitHub App and give it access to this repository.
3. Select the repository, press **Add Indexer** and set:
   - **Indexer Directory**: `indexer`
   - **Config File**: `config.yaml`
   - **Git Release Branch**: a branch kept for releases, for example `envio`
4. Push to that branch: `git push origin main:envio`. The build and the sync show on the indexer's page, and so
   does the endpoint once the first deployment is up.

Things to know:

- No token is needed: deployments have their own access to HyperSync. Leave `ENVIO_RPC_ROLE` unset.
- Only the `indexer` folder is uploaded, without dotfiles, and dependencies are resolved on every build without
  a lockfile. That is why nothing here imports from the rest of the repository and every version in
  `package.json` is exact.
- Every push to the release branch starts a new deployment that indexes from the start block; the previous one
  keeps answering until the new one has caught up. An indexer holds three deployments, so delete old ones.
- Environment variables are set in the indexer's **Settings**, under **Environment Variables**, and must start
  with `ENVIO_`.
- On the free development plan a deployment is deleted after 30 days, and it is wound down after 100 000
  events, 5 GB or a week without requests.

## Adding a chain

`config.yaml` has one entry per deployment under `chains`, filled in from
`contracts/deployments/<chainId>.json`. The entry for Monad mainnet (143) is already there, switched off. Once
`contracts/deployments/143.json` exists:

1. set `start_block` to its `startBlock`;
2. add `address` to the three contracts: `coverBook`, `coverPool` and `weatherIndex`;
3. delete the `skip: true` line.

Then run `pnpm codegen` and the tests, and push to the release branch. Nothing else changes: the handlers and
the queries already tell chains apart by `chainId`.
