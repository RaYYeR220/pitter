# Proof

Every on-chain claim this project makes, as a link you can open, and the commands to read the same facts
straight from the chain. All times are UTC on 13 October 2026.

- Explorer: MonadVision. Mainnet `https://monadvision.com/tx/<hash>`, testnet
  `https://testnet.monadvision.com/tx/<hash>`. Its pages render in the browser; the `cast` commands in the
  last section read the same data from a public RPC and need no explorer at all.
- Verified source: Monad's Sourcify instance, which MonadVision displays. Each link below returns JSON;
  `"match": "match"` means the deployed bytecode matches the source in this repository.
- Amounts: USDC and the test dollar have six decimals. `27000` base units is 0.027 USDC.

Every transaction hash below was checked against the chain over RPC (`cast receipt`) when this page was
written: status, sender, target and block are as described.

## 1. Contracts

| Network | Contract | Address | Verified source |
|---|---|---|---|
| Mainnet (143) | CoverBook | [`0x8C7f6A8b09176c893da3ee4C1cbCd2d8ec26E770`](https://monadvision.com/address/0x8C7f6A8b09176c893da3ee4C1cbCd2d8ec26E770) | [creation + runtime match](https://sourcify-api-monad.blockvision.org/v2/contract/143/0x8C7f6A8b09176c893da3ee4C1cbCd2d8ec26E770) |
| Mainnet (143) | CoverPool | [`0x58d970780565E4C064369AD80eEC2D3581d6d75D`](https://monadvision.com/address/0x58d970780565E4C064369AD80eEC2D3581d6d75D) | [creation + runtime match](https://sourcify-api-monad.blockvision.org/v2/contract/143/0x58d970780565E4C064369AD80eEC2D3581d6d75D) |
| Mainnet (143) | WeatherIndex | [`0x171CFCBAA60C9AfD267474773122293a67FbeD94`](https://monadvision.com/address/0x171CFCBAA60C9AfD267474773122293a67FbeD94) | [creation + runtime match](https://sourcify-api-monad.blockvision.org/v2/contract/143/0x171CFCBAA60C9AfD267474773122293a67FbeD94) |
| Mainnet (143) | USDC (native, not ours) | [`0x754704Bc059F8C67012fEd69BC8A327a5aafb603`](https://monadvision.com/address/0x754704Bc059F8C67012fEd69BC8A327a5aafb603) | |
| Testnet (10143) | CoverBook | [`0xE0951FC7640Da8bA5071693007607FBa31592ee4`](https://testnet.monadvision.com/address/0xE0951FC7640Da8bA5071693007607FBa31592ee4) | [runtime match](https://sourcify-api-monad.blockvision.org/v2/contract/10143/0xE0951FC7640Da8bA5071693007607FBa31592ee4) |
| Testnet (10143) | CoverPool | [`0x80375eB8BE28a7bffb274C2620E9D70Fe7E70B9f`](https://testnet.monadvision.com/address/0x80375eB8BE28a7bffb274C2620E9D70Fe7E70B9f) | [runtime match](https://sourcify-api-monad.blockvision.org/v2/contract/10143/0x80375eB8BE28a7bffb274C2620E9D70Fe7E70B9f) |
| Testnet (10143) | WeatherIndex | [`0x55F06d63A97ae82c67383cFB26B82Fda78e58664`](https://testnet.monadvision.com/address/0x55F06d63A97ae82c67383cFB26B82Fda78e58664) | [runtime match](https://sourcify-api-monad.blockvision.org/v2/contract/10143/0x55F06d63A97ae82c67383cFB26B82Fda78e58664) |
| Testnet (10143) | TestDollar | [`0x27fe944e3b7037ED9F75b17123b6e2E716DEeF10`](https://testnet.monadvision.com/address/0x27fe944e3b7037ED9F75b17123b6e2E716DEeF10) | [runtime match](https://sourcify-api-monad.blockvision.org/v2/contract/10143/0x27fe944e3b7037ED9F75b17123b6e2E716DEeF10) |

Who is who (both networks unless noted; from [`contracts/deployments/`](contracts/deployments) and the
receipts):

| Role | Address |
|---|---|
| Owner and deployer | `0x9F6D2520e195f80B84c2Bcdb383F8b1118017379` |
| Reporter (signs weather reports) | `0x79347d0f6C3b4363304bE7dD31D23C2e73459A0D` |
| Underwriter (signs quotes) | `0x806116242a61896a136b468bF702250eA9cbb27d` |
| Relayer (pays gas for buyers and the keeper; also sent the CRE simulation broadcasts) | `0xd900b658be6971fa8cf6fb2e3bcbc36cd5590c62` |
| Treasury (protocol fee, surplus of capped exits) | `0x29F9e86Cfb1A999194E4582D0810B6bFb5c89297` |
| Chainlink MockKeystoneForwarder, mainnet / testnet (simulation) | `0x9eF6468C5f37b976E57d52054c693269479A784d` / `0xB9F79d863261869B234c481D1f9A7af84AeAd192` |
| Chainlink KeystoneForwarder, mainnet (production DON, allowlisted, not yet used) | `0x76c9cf548b4179F8901cda1f8623568b58215E62` |

The forwarder addresses are the ones in Chainlink's
[CRE forwarder directory](https://docs.chain.link/cre/guides/workflow/using-evm-client/forwarder-directory-ts).

## 2. Mainnet pilot with real USDC

The pool was seeded with 0.9 USDC. Just before the purchases, the oracle logic in `@cover/core` was run over
40 cities and found heavy rain in only two of them, Colombo and Davao (that scan was off-chain and is not
itself on any chain; the oracle reports below are). Cover was bought there through the production service
code: the buyer signed one ERC-3009 `ReceiveWithAuthorization` and the relayer submitted
`buyWithAuthorization` and paid the gas. The buyer in all three purchases is the maintainers' own deployer
address.

| Time | What | Transaction | What to look for |
|---|---|---|---|
| 10:57:44 | Pool seeded with 0.9 USDC (`deposit`) | [`0xcb6c37ce…c78bd`](https://monadvision.com/tx/0xcb6c37ce00b5168b5203619d366126a89f99f5af3b093bdee3c27bd9a95c78bd) | 900,000 base units of USDC into the pool, shares minted |
| 10:58:13 | First CRE report on mainnet: a heartbeat | [`0x856b1a8c…e0508`](https://monadvision.com/tx/0x856b1a8c943052e7c16e06b1666524706e03cef1668d33dd317bad142e5e0508) | sent to the MockKeystoneForwarder, which calls `WeatherIndex.onReport`; the index emits its heartbeat |
| 10:59:19 | Policy #1, Colombo | [`0xaa4875af…8f862`](https://monadvision.com/tx/0xaa4875afe79fe404b689550bf6ef72573ef899e8fdeec031cb626b267ef8f862) | `buyWithAuthorization` from the relayer; `PolicyBought` id 1; 0.03375 USDC moves from the holder; `gasUsed` is 700,000, the limit |
| 10:59:24 | Policy #2, Davao | [`0xbaa65f19…01100`](https://monadvision.com/tx/0xbaa65f1964cc336542dcaf8ac154a73b991377891b8e2a130bd83710ccc01100) | same, id 2 |
| 11:00:02 | CRE report: both areas dry, 10:55 to 11:00 | [`0xbecafae2…d6f8e`](https://monadvision.com/tx/0xbecafae2f40bca346d55da1a426e889fb803bf38321b806751ec0d5f040d6f8e) | two `WeatherReported` events with `wetSeconds` 0 |
| 11:09:29 | CRE report: both areas wet, 11:00 to 11:09 | [`0xd60e30e6…bbf14`](https://monadvision.com/tx/0xd60e30e6ebac9a0997cf594466fb6a1ac7f0371cc1539dbdedb0ed2efe5bbf14) | two `WeatherReported` events with `wetSeconds` 540 (all nine minutes) |
| 11:13:26 | Policy #3, Warsaw | [`0xca707a0a…709cf2`](https://monadvision.com/tx/0xca707a0afd31fa8584f110c61ae63498564d29be385c305344c1a004f0709cf2) | `PolicyBought` id 3, maximum payout 0.198 USDC |
| 11:13 | Second identical request to the quote service | none | refused with HTTP 409 `capacity_exhausted`; nothing was signed, so there is no transaction (section 3) |
| 11:13:27 | The same cover with a quote signed by the underwriter key, sent straight to `CoverBook.buy` | [`0x34b79f1f…eb5d5`](https://monadvision.com/tx/0x34b79f1f31213bf11098a1b4c517527c94cff659837dda5f982a859b4e7eb5d5) | **status: failed**, reverted with `CellCapExceeded()` (section 3) |
| 11:14 to 11:39 | Later CRE reports, covering 11:09 to 11:39 | [`0xbefbf4dc…9b78a`](https://monadvision.com/tx/0xbefbf4dc4be39fdf25f8fb38deb8b4f091b0819fed0986222c8bbaa41169b78a), [`0xa5289681…4849e`](https://monadvision.com/tx/0xa52896815423f302481863a33a28b81eb335365c1f55299b26970b466ac4849e), [`0x39811d9e…51911`](https://monadvision.com/tx/0x39811d9e6bdcac77043c63988a2d4e4378fbe6ca9d1399265d79479c8e951911), [`0xd007acf1…f1698`](https://monadvision.com/tx/0xd007acf1aaecaafc80c49d0aabe5a53f2c941ec07ff16e97c93059e5e2ef1698), [`0x139936a9…8a9a4`](https://monadvision.com/tx/0x139936a938ed845487c8347e21f9b7fc2e29322a98a4c73a03834aaaa4a8a9a4) | Colombo and Davao wet for every second reported; Warsaw 0 |
| 11:44:44 | CRE report covering 11:39 to 11:44, the end of both windows | [`0xd1e2c414…28ce61`](https://monadvision.com/tx/0xd1e2c414872e6156ce6394a500191fbbe17bed5ca5e8c3da3665392e4228ce61) | Colombo and Davao 300 wet seconds out of 300; Warsaw 0. The windows of #1 and #2 are now fully reported |
| 11:44:49 | **Payouts: policies #1 and #2 settled and closed** (`settleMany([1, 2])` sent by the relayer) | [`0xfe2ef821…ec18f1d`](https://monadvision.com/tx/0xfe2ef821a04a6fa2ecd0b1f6f5b10700a3708be3912b202dc2b3aaa0fec18f1d) | two `PolicySettled` events, each paying 27,000 (0.027 USDC, the full maximum) with `closed` true; two USDC transfers from the pool to the holder, whose balance goes from 0.026104 to 0.080104 USDC; `ExposureChanged` takes both areas' reservations to zero. Five seconds after the report that completed the windows |

The policies, as `CoverBook.policies(id)` returns them:

| Id | Area (key) | Window | Pays | Maximum payout | Premium |
|---|---|---|---|---|---|
| 1 | Colombo, cell centre 6.925, 79.875 (`18446752397356176461`) | 11:11 to 11:41 | 15 base units a wet second (0.0009 USDC a minute) | 0.027 USDC | 0.03375 USDC |
| 2 | Davao, cell centre 7.075, 125.625 (`18446752410241079264`) | 11:11 to 11:41 | 15 base units a wet second | 0.027 USDC | 0.03375 USDC |
| 3 | Warsaw, cell centre 52.225, 21.025 (`18446756288596545460`) | 11:25 to 12:25 | 55 base units a wet second (0.0033 USDC a minute) | 0.198 USDC | 0.006394 USDC |

- The mainnet book requires at least ten minutes between a purchase and the start of its cover
  (`minLead` 600), which is why both windows start at 11:11.
- **Policies #1 and #2 cost more than they can pay.** The premium is exactly 1.25 times the maximum payout:
  every slot was priced at a 100% chance of heavy rain, plus the 25% margin. Rain was already being
  reported in both areas, so the price could not fall below the observation floor. The system does not sell
  cheap cover for rain that is already falling. See [docs/pricing.md](docs/pricing.md).
- **Both paid in full.** Heavy rain was reported for all 1,800 seconds of both windows
  (`wetSeconds(key, start, end)` returns 1800 for each), so each cover paid its maximum, 0.027 USDC, and
  closed: 0.054 USDC in payouts.
- **The economics, plainly:** the holder paid 0.0675 USDC in premiums for 0.054 USDC of payouts. That is
  the intended outcome. The cover was bought while rain was already being observed, the price treated it as
  certain rain, and the buyer lost money on a sure thing. A rider covering a shift before the
  rain starts pays the forecast's price instead (policy #3).
- Policy #3 in dry Warsaw cost 3.2% of its maximum payout, an average 2.6% chance of heavy rain per slot. It
  is still open at the time of writing and will close dry, or by `expire` if its window is never fully
  reported.

## 3. The refusal: no area may hold more than a quarter of the pool

The pool reserves the full maximum payout of every cover it sells, and no single area may hold more than 25%
of the capital that has not asked to leave (`maxCellBps` 2500 on `CoverPool`).

At 11:13 the pool's active capital was 970,201 base units (the 0.9 USDC seed plus the premiums of the three
covers, net of the 5% fee). Warsaw's limit was therefore 242,550. Policy #3 reserved 198,000 of it, leaving
44,550.

1. **The quote service refused.** A second request for the same 0.198 USDC cover answered HTTP 409
   `capacity_exhausted` with the room left in `details.capacity`, and signed nothing. This step leaves no
   on-chain trace; the same refusal is covered by the service's unit and integration tests.
2. **The contract refused.** A quote for the same cover, signed with the underwriter key itself, was sent
   directly to `CoverBook.buy` from the deployer account. The book accepted the signature and asked the pool
   to reserve 198,000 more in Warsaw; the pool reverted with `CellCapExceeded()` (selector `0xe1913dd2`):
   [`0x34b79f1f…eb5d5`](https://monadvision.com/tx/0x34b79f1f31213bf11098a1b4c517527c94cff659837dda5f982a859b4e7eb5d5).

Replay it yourself; `cast run` decodes the error against the verified source:

```sh
cast run 0x34b79f1f31213bf11098a1b4c517527c94cff659837dda5f982a859b4e7eb5d5 --rpc-url https://rpc.monad.xyz
```

```
    ├─ 0x58d970780565E4C064369AD80eEC2D3581d6d75D::lock(18446756288596545460, 198000)
    │   ├─ 0x754704Bc059F8C67012fEd69BC8A327a5aafb603::balanceOf(0x58d970780565E4C064369AD80eEC2D3581d6d75D) [staticcall]
    │   │   └─ ← [Return] 970201
    │   └─ ← [Revert] CellCapExceeded()
    └─ ← [Revert] CellCapExceeded()
```

The underwriter key can sign any quote, but it cannot make the pool reserve more than the caps allow.

## 4. Chainlink CRE reports

The oracle workflow in [`workflow/`](workflow) is built with Chainlink's CRE SDK and runs with
`cre workflow simulate --broadcast`, which delivers each report through Chainlink's MockKeystoneForwarder.
That forwarder relays reports from anyone, so `WeatherIndex` checks the reporter's EIP-712 signature on every
report, on both entry points; an unsigned or wrongly signed report reverts.

| Network | What | Transaction |
|---|---|---|
| Testnet | First CRE heartbeat on this deployment, 10:03:10 | [`0xe41aa168…039cb3`](https://testnet.monadvision.com/tx/0xe41aa168ce53dfee555eca1d1d9fe8a60a756c2ce88a7dcac76563553f039cb3) |
| Testnet | Heartbeat submitted by the live app's keeper with `submit(bytes)`, 10:43:59 | [`0x60a76d5a…4689dd`](https://testnet.monadvision.com/tx/0x60a76d5acb0b590bd94b31f73dc76befb80692fa4d9d15590d2d51ea344689dd) |
| Mainnet | First CRE heartbeat, 10:58:13 | [`0x856b1a8c…e0508`](https://monadvision.com/tx/0x856b1a8c943052e7c16e06b1666524706e03cef1668d33dd317bad142e5e0508) |
| Mainnet | A dry report, a wet report, then six more until both windows were fully reported | see section 2 |

What to look for: the transaction goes to the MockKeystoneForwarder, which calls `WeatherIndex.onReport`;
the index emits one `WeatherReported(key, from, to, wetSeconds, cumulative)` per area and its heartbeat, and
the forwarder logs the delivery as successful. Production delivery from Chainlink's DON goes through the
KeystoneForwarder listed in section 1, which is allowlisted on mainnet but has not delivered anything yet.

## 5. Testnet: the whole flow in a browser

One run of the app on the test network, by a passkey account created in the browser
(`0x971bff29a5a77510d46456d478120c49dbbd72ba`), with practice dollars and the simulator area (cell centre
0.025, 0.025, key `18446751804650688016`).

| Time | What | Transaction | What to look for |
|---|---|---|---|
| 11:07:56 | Gasless deposit of 500 test dollars into the pool | [`0xfeaafc39…659d2`](https://testnet.monadvision.com/tx/0xfeaafc39344acc5b1f315d2c93887bd5cc63e83f643c8a0725f5671d4bb659d2) | relayer sends `depositWithAuthorization`; the passkey account receives pool shares |
| 11:07:59 | Cover bought | [`0x37e92bba…55d67`](https://testnet.monadvision.com/tx/0x37e92bba93d0e339f715637c6c93edd52026a098c6bbb5c7f8a19d8c98b55d67) | policy 1 of this deployment, 11:09 to 11:19, 2,000 base units a wet second ($0.12 a minute), premium 0.45, maximum payout 1.20; 0.0225 fee to the treasury, 0.4275 to the pool |
| 11:10:19 | Weather report: the simulator area wet | [`0xf48935fc…6f3478`](https://testnet.monadvision.com/tx/0xf48935fccf010efa66a4acf4fe8623e60952ba143f9e9ab6975275664e6f3478) | `WeatherReported` for the simulator key, submitted by the keeper |
| 11:10:20 | Payout | [`0x4d12b534…2b5e`](https://testnet.monadvision.com/tx/0x4d12b53434ea1defa855dbf9dcfd2cc6ae70e5e82a5e9a36761bd0020a302b5e) | `PolicySettled` id 1 paying 0.12 (60 wet seconds × 2,000), and the transfer from the pool to the passkey account |

The payout landed three blocks, about one second, after the report.

## 6. Check it yourself

Install Foundry (`cast`). Nothing below needs a key.

```sh
M=https://rpc.monad.xyz
BOOK=0x8C7f6A8b09176c893da3ee4C1cbCd2d8ec26E770
POOL=0x58d970780565E4C064369AD80eEC2D3581d6d75D
INDEX=0x171CFCBAA60C9AfD267474773122293a67FbeD94

# the pool: capital, what is reserved, what the caps are measured against
cast call $POOL "totalAssets()(uint256)" --rpc-url $M
cast call $POOL "lockedExposure()(uint256)" --rpc-url $M
cast call $POOL "activeAssets()(uint256)" --rpc-url $M
cast call $POOL "maxCellBps()(uint16)" --rpc-url $M                       # 2500 = 25% per area
cast call $POOL "cellExposure(uint256)(uint256)" 18446756288596545460 --rpc-url $M   # Warsaw

# the policies: holder, key, start, end, rate, premium, max payout, paid, settled until, closed
cast call $BOOK "policyCount()(uint256)" --rpc-url $M
cast call $BOOK "policies(uint256)(address,uint256,uint64,uint64,uint128,uint128,uint256,uint256,uint64,bool)" 1 --rpc-url $M
cast call $BOOK "claimable(uint256)(uint256)" 1 --rpc-url $M

# served areas: 52 keys; Colombo is served, the testnet simulator area is not
cast call $BOOK "servedOnly()(bool)" --rpc-url $M
cast call $BOOK "servedKeys()(uint256[])" --rpc-url $M
cast call $BOOK "isServed(uint256)(bool)" 18446752397356176461 --rpc-url $M
cast call $BOOK "isServed(uint256)(bool)" 18446751804650688016 --rpc-url $M

# the oracle: last report, wet seconds of Colombo inside policy #1's window, who may report
cast call $INDEX "heartbeat()(uint64)" --rpc-url $M
cast call $INDEX "wetSeconds(uint256,uint64,uint64)(uint256)" 18446752397356176461 1791889860 1791891660 --rpc-url $M
cast call $INDEX "reporter()(address)" --rpc-url $M
cast call $INDEX "isForwarder(address)(bool)" 0x9eF6468C5f37b976E57d52054c693269479A784d --rpc-url $M

# weather reports in a block range (the public RPC answers at most 100 blocks per call);
# this range holds the wet report of 11:09:29
cast logs --address $INDEX "WeatherReported(uint256 indexed,uint64,uint64,uint32,uint256)" \
  --from-block 113025200 --to-block 113025299 --rpc-url $M

# any transaction: status, sender, target, gas used (equal to the limit on Monad)
cast receipt 0xaa4875afe79fe404b689550bf6ef72573ef899e8fdeec031cb626b267ef8f862 --rpc-url $M

# the refused purchase, decoded
cast run 0x34b79f1f31213bf11098a1b4c517527c94cff659837dda5f982a859b4e7eb5d5 --rpc-url $M

# verified source
curl -s https://sourcify-api-monad.blockvision.org/v2/contract/143/$BOOK
```

The block of any transaction above is in its receipt (`cast receipt <hash> blockNumber`). For the test network use `--rpc-url https://testnet-rpc.monad.xyz` and the addresses
in section 1. A key is `(1 << 64) | (latIndex << 32) | lonIndex` on a 0.05 degree grid;
`@cover/core/cells` (`keyFromLatLon`) computes it from a latitude and longitude.

To re-run the code rather than read the chain, see the test table in the [README](README.md#tests).
