# Pricing

What a cover costs, why, and what the model does not know. The code is
[`packages/core/src/pricing/quote.ts`](../packages/core/src/pricing/quote.ts); the service adds floors and
signs ([`service/src/quote/engine.ts`](../service/src/quote/engine.ts)).

## The rule

```
premium = rate × Σ over slots ( P(wet in slot) × slot seconds ) × 1.25        rounded up
```

`rate` is what the cover pays per wet second; `rate × window seconds` is its maximum payout. `P(wet)` is the
chance that the oracle will call the area wet, estimated per 15-minute slot from the same sources that settle
the cover:

1. **Cut the window into slots** along the forecast's 15-minute grid (the first and last may be shorter).
2. **Ask each of the three settlement models** (DWD ICON, NOAA GFS, Météo-France, served by Open-Meteo) for an
   estimate:
   - within the next two hours, the model's 15-minute precipitation as an hourly rate, divided by the trigger
     (1.0 mm an hour), capped at 1: rain at or above the trigger counts as certain;
   - beyond two hours, the model's hourly amount, the same way;
   - in both cases never less than the model's own chance of rain in that hour, so a dry nowcast with rain
     likely within the hour does not make cover cheap.
3. **Take the wettest model**, not an average.
4. **Apply the observation floor.** If any settlement source reports rain at or above the trigger right now,
   or the nearest airport reports rain of any strength, every slot that starts within the next hour is priced
   at 90% or more.
5. **Apply the floor.** No slot is priced below 1%.
6. **Add the margin**: 25% on top of the expected payout.

Each slot in a quote says why it costs what it does: the model that drove it, the basis (`nowcast`, `hourly`
or `floor`), the forecast values, `probabilityWet` and whether the observation floor applied. The app shows
this as "why this price".

**Service floors.** The service signs a premium no lower than the book's `minPremium` (0.0001 test dollars on
testnet, 0.001 USDC on mainnet) and no lower than `QUOTE_MIN_PREMIUM_BPS` of the maximum payout (1% by
default). If the weather sources cannot be
read within 4 seconds, or fewer than two answer, the quote is priced as if it might be raining now: the
coming hour gets the observation floor and the answer carries `"warnings": ["observations_unavailable"]`. A
missing observation can make cover dearer, never cheaper.

**Where the premium goes.** 5% to the treasury (`feeBps` 500), the rest to the pool, where it belongs to the
backers.

## Why the wettest model, and why the observation floor

A buyer can read the same public sources the oracle reads. If the price averaged the models, a buyer could
wait for the moment one model shows heavy rain and the average does not, and buy cheap cover that is likely
to pay. Taking the wettest model closes that gap for the models. The observation floor closes it for rain
that is already falling: once any source reports rain, the next hour is priced as likely wet.

What the price cannot see ahead is MET Norway's forecast and the airport's next report: they count only
through the observation floor, once they report rain.

## Worked examples

All three are real quotes; the first two are on chain.

**Rain already falling: mainnet policies #1 and #2, Colombo and Davao.** 30 minutes paying 15 base units a
wet second (0.0009 USDC a minute), maximum payout 0.027 USDC. Rain was being reported in both areas when the
cover was bought. The premium was 0.03375 USDC, exactly 1.25 times the maximum: every slot was priced at a
100% chance of heavy rain, plus the margin. Heavy rain was then reported for all 1,800 seconds of both
windows, and each cover paid its full 0.027 USDC. The buyer paid 0.0675 USDC for 0.054 USDC of payouts. Cover
for rain that is already falling cannot be bought at a profit; that is the point of the floor.
([purchase](https://monadvision.com/tx/0xaa4875afe79fe404b689550bf6ef72573ef899e8fdeec031cb626b267ef8f862),
[payout](https://monadvision.com/tx/0xfe2ef821a04a6fa2ecd0b1f6f5b10700a3708be3912b202dc2b3aaa0fec18f1d))

**A dry hour: mainnet policy #3, Warsaw.** 60 minutes paying 55 base units a wet second (0.0033 USDC a
minute), maximum payout 0.198 USDC, premium 0.006394 USDC: 3.2% of the maximum, an average 2.6% chance of
heavy rain per slot before the margin. About 0.0001 USDC a minute of cover.
([purchase](https://monadvision.com/tx/0xca707a0afd31fa8584f110c61ae63498564d29be385c305344c1a004f0709cf2))

**A testnet quote for Warsaw.** 30 minutes at the app's default payout, 2,000 base units a wet second ($0.12
a minute), maximum payout $3.60. All five sources answered and said dry; every slot was priced from GFS's 3%
hourly chance of rain:

```
expected wet seconds = 0.03 × 1,800 = 54
expected payout      = 54 × 2,000 = 108,000 base units  ($0.108)
premium              = 108,000 × 1.25 = 135,000          ($0.135, under half a cent a minute)
```

## What keeps a pricing mistake from becoming a missed payout

The pool reserves the full maximum payout of every cover when it sells it, and sells at most 80% of its
capital in total and 25% in one area. A premium that is too low therefore costs the backers money; it cannot
leave a rider unpaid. The contract invariants check after every call that the pool holds what it owes.

## What the model does not know

- **It has not been tested against real loss data.** The 25% margin, the 1% floor and the 90% observation
  floor are chosen, not fitted. Whether premiums cover payouts over time is not known.
- **Correlated rain.** Each area is priced on its own. One storm over the Warsaw grid hits many areas at
  once; only the caps bound that, not the price.
- **Free forecast data.** Open-Meteo's free API is for non-commercial use; a commercial deployment needs a
  commercial weather licence. Three of the five sources are models from that one provider.
- **Cell, not street.** The trigger is "the sources agree it rains in the 0.05 degree cell". A rider can be
  rained on while the cell stays dry, and the other way round.

Every parameter (`loadBps`, `floorBps`, `thresholdMmPerHour`, `nowcastHorizonSeconds`, `observedWetBps`,
`observationWindowSeconds`) can be passed to `quotePremium`; the defaults are in `PRICING_DEFAULTS`. Tests:
`packages/core/test/pricing.test.ts` and `pricing.models.test.ts`, on recorded forecasts.
