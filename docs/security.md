# Security

Who is trusted with what, what bounds each of them on chain, what was found and fixed before mainnet, and
what risk remains. The contract-level detail is in the [contracts README](../contracts/README.md#trust-and-limits)
and the service's in the [service README](../service/README.md#security-notes).

## Keys and what bounds them

| Key | Held by | Can | Bounded by |
|---|---|---|---|
| **Owner** of every contract (`0x9F6D…7379`, the deployer, on both networks) | the maintainers, one externally owned account | Set the underwriter and reporter keys, the caps, the fee, the per-cover limit, the premium floor, the served areas, the notice, the horizon, the grace period and both treasuries; recover tokens sent to the contracts by mistake. An owner that installs its own underwriter and reporter can do whatever those keys can. | Fee at most 20%; caps at most 100%; the notice at least the cover horizon plus 30 minutes and at most seven days; the book wired to the pool once. It cannot mint or move shares, touch the exit escrow or deferred payouts, change a cover, or rewrite the weather record. Nothing delays its actions. |
| **Underwriter** (`0x8061…b27d`) | the service, as an environment secret | Sign any quote: any holder, any rate, any premium down to the floor. Alone it can give cover away; turning that into money needs real rain or the reporter. | Per cover at most `maxPolicyPayout` (0.20 USDC on mainnet); per area 25% and in total 80% of the capital that has not asked to leave; windows of at most 12 hours ending within the horizon; the lead time; served areas; a quote is usable once and dies when the key is rotated. |
| **Reporter** (`0x7934…9A0D`) | the CRE workflow's secrets on the maintainers' machine, and the service's keeper | Decide what was wet. One report can make every open cover pay its maximum; silence lets covers expire unpaid. An accepted reading cannot be corrected. | Only past time; never more wet seconds than seconds; only open covers pay, so at most `lockedExposure`, which the caps held to 80% of active capital when it was reserved. Free capital is out of its reach. A report issued more than 30 minutes ago, or more than a minute ahead of the chain clock, is refused. |
| **Relayer** (`0xd900…0c62`) | the service | Pay gas; hold paid-cover premiums in passing, with an allowance to the book only. | Every transaction it sends is on an allow-list of contract and selector, simulated first, and either signed by someone else or open to anyone, paying only the signed or recorded party. It cannot redirect a payment or change a cover. Rate limits cap what it spends per minute. Its loss is its MON balance and premiums in transit. |
| **Forwarders** (Chainlink) | Chainlink; the simulation forwarder relays from anyone | Deliver reports. | The reporter's signature is checked on every report, so a forwarder can deliver only what the reporter signed. |
| **Treasury** (`0x29F9…9297`) | the maintainers | Receive the 5% fee and the surplus of capped exits. | If the token blocks the book's treasury, purchases revert until the owner sets another; the pool's surplus is set aside instead. |
| **Service secrets** (`CRON_SECRET`, `SANDBOX_SECRET`) | the service | Trigger a keeper tick; on the test network, drip practice dollars and flip the simulator's rain. | A tick only does what anyone may do on chain. The sandbox refuses to run on chain 143. Secrets are at least 24 characters and compared in constant time. |
| **A rider's passkey** | the rider's passkey manager | Everything the account can do. | A sign-in signs without a prompt only cover payments to the book, at most $5 in any 60 minutes, for at most four hours and 20 idle minutes. Anything else takes a fresh prompt. |

**The main trust assumption.** Whoever controls the reporter and the underwriter together (or the owner,
who can install both) can sell itself cover and report it wet, and so take up to 80% of the pool's active
capital. On the mainnet pilot that is under one USDC. Production delivery from Chainlink's DON removes the
single reporter key from the path; until then this is stated as a limit, not hidden.

## What an independent review found

An independent review before the mainnet deployment found no critical or high-severity issues. It found three
medium and two low ones. All five are fixed, each with regression tests. The three medium issues, described
as the behaviour the contracts have now:

1. **Cell-slot squatting.** At most 64 areas can have open cover at once, so someone could buy tiny covers in
   many areas to take every slot and shut real riders out. Now, when the book sells only in served areas
   (as on mainnet), there can be no more served areas than slots, so cover can be held only in areas that
   always have one; and the premium floor makes holding slots cost money.
   Tests: `test_DustCannotShutOutAServedArea`, `test_ServedAreas_MayNotOutnumberTheActiveCellSlots`
   (`CoverBook.served.t.sol`), `test_Buy_AFloorMakesHoldingEveryCellSlotCostly` (`CoverBook.buy.t.sol`).
2. **An exit claimed before confirmed payouts were settled.** A backer whose notice had ended could collect
   while a payout for rain already reported was still unsettled, leaving the backers who stayed to carry it.
   Now a request can be collected only after every cover sold before it has closed
   (`book.oldestOpenId() > lastPolicyAtRequest`), and `claimBlockedByCover` says when it is waiting.
   Tests: `test_Claim_WaitsUntilTheCoverSoldBeforeTheRequestIsClosed` (`CoverPool.redeem.t.sol`),
   `test_ALeaverCarriesItsShareOfALossConfirmedBeforeItsClaim` (`LiquidityExit.t.sol`).
3. **Capital in notice as a free option.** Capital waiting to leave could keep the upside of the premiums
   while preparing to step out of the losses. Now, from the request on, that capital does not count toward
   the caps, earns nothing further (a claim pays the lower of what the shares were worth at the request and
   at the claim; the difference goes to the treasury rather than to the backers who stay, so a buyer who
   holds pool shares cannot collect a leaver's share of its own premium), and still bears losses until it
   is claimed.
   Tests: `test_RetiringCapital_DoesNotCollectThePremiumsOfNewCover`, `test_RetiringCapital_BacksNoNewCover`
   (`LiquidityExit.t.sol`), `test_Caps_ShrinkWhileCapitalIsRetiring`,
   `test_Claim_AOneDollarDepositCannotCollectTheSurplus` (`CoverPool.redeem.t.sol`).

The two low-severity issues are fixed with regression tests as well. The review did not assess the pricing
model against real loss data, and neither have we.

Across all of it, the invariant suite (`contracts/test/invariant`) drives 64 runs of 128 random calls
(8,192 calls) and checks after every call that pool exposure equals the open covers, the pool holds what it owes, payouts follow the index
and the maximum, forged reports are never accepted, a quote is used once, nothing is claimed early or beyond
free capital, and cover ends before the capital behind it can leave.

## Residual risks

- **An exit between a report and its settlement.** A request waits only for cover sold before it. Once
  collectable, it can be claimed at any moment, including between a report of rain and the settlement of
  cover sold after the request. That cover was sold against the active capital alone, so the backers who stay
  carry its payout; the leaving capital never backed it.
- **One reporter key** decides what was wet, bounded by the caps above, until Chainlink's DON delivers.
- **One provider behind three sources.** Three of the five sources are models served by Open-Meteo. If that
  provider is wrong, down or tampered with, it can decide the median on its own. A second commercial data
  provider is the fix; it needs a licence.
- **The pilot shares keys with the test network.** The reporter and underwriter addresses are the same in
  [`10143.json`](../contracts/deployments/10143.json) and [`143.json`](../contracts/deployments/143.json), so
  the live testnet app's server holds keys that also act on mainnet. Bounded by the mainnet caps on a pool of
  under one USDC; separate keys come before the pool holds more than cents.
- **The owner is one key with no delay.** It should be a multisig behind a timelock before the pilot grows.
- **Hot keys on a hosted server.** The underwriter, reporter and relayer keys are environment secrets of the
  web deployment. Each is bounded as above; none can take free capital.
- **The token.** The pool assumes a USDC-like token: no transfer fees, no rebasing, no callbacks. The issuer
  can block an address; a payout to a blocked holder is set aside in `deferred[holder]`, not lost, and the
  cover still closes.
- **The account key lives in page memory during a sign-in.** A script injected into the page could ask the
  session for what its scope allows: cover payments up to $5 an hour. The Content Security Policy allows
  scripts from the app's own origin only (inline scripts included). Nothing about the key is written to
  storage.
- **Passkey loss.** The account is derived from the passkey. A synced passkey (iCloud Keychain, Google Password
  Manager, 1Password) survives a lost phone; a passkey that exists on one device only does not.
- **The blob store can withhold what it cannot read.** The shift log is encrypted on the device; the server
  can delete or withhold the ciphertext but not read or alter it unnoticed.
- **An x402 payment is a bearer instrument** until it is used: whoever presents it first decides which holder
  and window it buys. It must travel over TLS only. (Paid cover is switched off on the live app.)
- **Rate limits by IP** trust one proxy header, configured to what the hosting platform guarantees.
- **Leaving the pool needs MON.** Requests and claims act on the sender; there is no gasless exit.

## Reporting a problem

Open an issue at <https://github.com/RaYYeR220/pitter/issues>. For anything that puts money at risk, ask
there for a private channel first and leave the details out of the public issue.
