# @cover/core

Shared code for the contracts' off-chain side: the oracle workflow, the service and the app import it. It has no
platform dependencies, so it also bundles into the oracle's WASM runtime.

| Import | |
|---|---|
| `@cover/core/cells` | the grid of cells and the index keys the contracts use |
| `@cover/core/abi`, `@cover/core/chains` | contract ABIs synced from the Foundry build, chain config, deployment records |
| `@cover/core/eip712` | hashing and signing of quotes and reports, byte-for-byte what the contracts verify |
| `@cover/core/weather` | the oracle: asking the sources, judging each cell, building and signing reports |
| `@cover/core/pricing` | the premium for a window of cover |
| `@cover/core/testing` | a replay of recorded answers from the real sources, for tests |

## Price and payout use the same sources

Cover pays out for the seconds the oracle reports a cell wet. The oracle settles from five sources: three
forecast models served by Open-Meteo (DWD ICON, NOAA GFS and Météo-France: `icon_seamless`, `gfs_seamless`,
`meteofrance_seamless`), the nearest airport's METAR within 40 km, and MET Norway. A cell is wet when at least
two of them answer and their median is 1.0 mm/h or more.

The price is taken from those same sources, and from the wettest of them, not an average:

- `fetchForecast` asks Open-Meteo for the 15-minute and hourly forecast of the three settlement models in one
  request (about 4.6 KB per cell).
- `quotePremium` cuts the window into 15-minute slots. Every model gives an estimate per slot: its intensity
  relative to the 1.0 mm/h trigger (the 15-minute forecast for the next two hours, the hourly amount after
  that), but never less than its chance of rain in that hour. The slot is priced at the **highest** of the
  three estimates, and never below 1%.
- Pass what the sources report right now as `observed` (the readings the oracle aggregates, or its
  observation of the cell). If any of them is at or above the trigger, or the airport reports rain, every slot
  that starts within the next hour is priced at 90% or more.

So a buyer who watches the settlement sources cannot pick a moment when one of them already points to rain and
the price does not. What the price cannot see ahead is MET Norway's forecast and the airport's next report: they
count only through the observation floor, while they report rain.

```
premium = rate x sum over slots of P(wet) x seconds x 1.25
```

Each slot of the quote says why it costs what it does: `model` (the model that drove it), `basis` (`nowcast`,
`hourly` or `floor`), the forecast values it was priced from, `probabilityWet`, and `observationFloor` when a
current report of rain lifted it. A forecast that names no models, such as an answer for Open-Meteo's default
model, is still accepted and priced as one model (`best_match`).

Defaults are in `PRICING_DEFAULTS`: 25% load, 1% floor, 1.0 mm/h trigger, two-hour nowcast horizon, 90%
observation floor over one hour. Every one of them can be passed to `quotePremium`.

## Tests

```sh
pnpm --filter @cover/core test
pnpm --filter @cover/core typecheck
```

The tests read recorded answers of the real sources in `test/fixtures`. To record new ones:

```sh
# the pricing forecasts only (Open-Meteo); leaves the weather snapshot as it is
pnpm --filter @cover/core record:fixtures --forecast-only

# everything; aviationweather.gov and MET Norway require an identifying User-Agent
WEATHER_USER_AGENT="cover-weather-oracle/0.1 (+https://github.com/<owner>/<repo>)" pnpm --filter @cover/core record:fixtures
```

Use a neutral project string as the User-Agent, never a personal address: the recorder refuses one with `@`.
Re-recording the weather snapshot changes the values the oracle and workflow tests expect.

`pnpm --filter @cover/core sync:contracts` refreshes the ABIs and deployment records after the contracts change.
