// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Quote, Reading} from "../src/Types.sol";
import {CoverFixture} from "./utils/CoverFixture.sol";

/// @dev Gas ledger for the calls a relayer, a keeper and the oracle make. Every test prepares nothing itself:
/// the state comes from `setUp`, and the test body sends exactly one transaction, so storage and accounts are
/// as cold as they are on chain. Results are written to `snapshots/Gas.json`; they include the intrinsic
/// transaction cost and follow the Monad gas schedule selected in `foundry.toml`.
/// forge-config: default.isolate = true
contract GasTest is CoverFixture {
    address internal forwarder = makeAddr("forwarder");
    address internal newcomer;
    uint256 internal newcomerKey;
    address internal leaver = makeAddr("leaver");

    uint256 internal constant WET_BASE = (uint256(1) << 64) | (uint256(2000) << 32);
    uint256 internal constant DRY_BASE = (uint256(1) << 64) | (uint256(3000) << 32);
    uint256 internal constant NEW_BASE = (uint256(1) << 64) | (uint256(4000) << 32);

    uint64 internal constant NOW = T0 + 20 minutes;
    uint256 internal partialId;
    uint256 internal closingId;
    uint256 internal dryId;

    function setUp() public override {
        super.setUp();
        (newcomer, newcomerKey) = makeAddrAndKey("newcomer");
        vm.startPrank(owner);
        index.setForwarder(forwarder, true);
        dollar.mint(newcomer, HOLDER_FUNDS);
        dollar.mint(leaver, 2_000e6);
        pool.setRedeemNotice(10 minutes);
        vm.stopPrank();

        // A provider whose redemption request will have matured by the time the tests run.
        vm.startPrank(leaver);
        dollar.approve(address(pool), type(uint256).max);
        pool.requestRedeem(pool.deposit(1_000e6, leaver), leaver, leaver);
        vm.stopPrank();

        // Ten cells that have seen rain and ten that have only ever been dry.
        vm.warp(T0 + 5 minutes);
        _submitReport(_tenReadings(WET_BASE, T0, T0 + 5 minutes, 100));
        _submitReport(_tenReadings(DRY_BASE, T0, T0 + 4 minutes, 0));
        _submitReport(_tenReadings(DRY_BASE, T0 + 4 minutes, T0 + 5 minutes, 0));

        // Three open policies over [T0 + 10 min, T0 + 20 min).
        partialId = _buy(_quote(holder, WET_BASE, T0 + 10 minutes, NOW, RATE, PREMIUM));
        closingId = _buy(_quote(holder, WET_BASE + 1, T0 + 10 minutes, NOW, RATE, PREMIUM));
        dryId = _buy(_quote(holder, DRY_BASE, T0 + 10 minutes, NOW, RATE, PREMIUM));

        // The first is reported halfway, the other two to the end of their window.
        vm.warp(T0 + 15 minutes);
        _report(WET_BASE, T0 + 5 minutes, T0 + 15 minutes, 300);
        vm.warp(NOW);
        _submitReport(
            _readings(Reading(WET_BASE + 1, T0 + 5 minutes, NOW, 400), Reading(DRY_BASE, T0 + 5 minutes, NOW, 0))
        );
    }

    function _tenReadings(uint256 base, uint64 from, uint64 to, uint32 wet) internal pure returns (Reading[] memory r) {
        r = new Reading[](10);
        for (uint256 i = 0; i < 10; ++i) {
            r[i] = Reading(base + i, from, to, wet);
        }
    }

    function _forward(Reading[] memory readings) internal {
        bytes memory payload = _signedReport(reporterKey, indexDomain, readings, _nextIssuedAt());
        vm.prank(forwarder);
        index.onReport("", payload);
    }

    // ───────────────────────────── purchases ─────────────────────────────

    function test_Gas_BuyWithAuthorization_FirstPolicyInANewCell() public {
        _buyWithAuthorization(_quote(newcomer, NEW_BASE, NOW, NOW + 10 minutes, RATE, PREMIUM), newcomerKey, relayer);
        vm.snapshotGasLastFrame("Gas", "buyWithAuthorization: first policy in a new cell");
    }

    function test_Gas_BuyWithAuthorization_NextWindowInAnActiveCell() public {
        _buyWithAuthorization(_quote(holder, WET_BASE, NOW, NOW + 10 minutes, RATE, PREMIUM), holderKey, relayer);
        vm.snapshotGasLastFrame("Gas", "buyWithAuthorization: next window in an active cell");
    }

    function test_Gas_Buy_NextWindowInAnActiveCell() public {
        _buy(_quote(holder, WET_BASE, NOW, NOW + 10 minutes, RATE, PREMIUM));
        vm.snapshotGasLastFrame("Gas", "buy: next window in an active cell");
    }

    // ───────────────────────────── settlement ─────────────────────────────

    function test_Gas_Settle_PayoutWhileTheWindowIsOpen() public {
        vm.prank(keeper);
        uint256 paid = book.settle(partialId);
        vm.snapshotGasLastFrame("Gas", "settle: payout while the window is open");
        assertEq(paid, 150 * RATE);
    }

    function test_Gas_Settle_PayoutAndClose() public {
        vm.prank(keeper);
        uint256 paid = book.settle(closingId);
        vm.snapshotGasLastFrame("Gas", "settle: payout and close");
        assertEq(paid, 266 * RATE);
    }

    function test_Gas_Settle_DryClose() public {
        vm.prank(keeper);
        uint256 paid = book.settle(dryId);
        vm.snapshotGasLastFrame("Gas", "settle: dry close");
        assertEq(paid, 0);
    }

    function test_Gas_SettleMany_ThreePolicies() public {
        uint256[] memory ids = new uint256[](3);
        ids[0] = partialId;
        ids[1] = closingId;
        ids[2] = dryId;
        vm.prank(keeper);
        book.settleMany(ids);
        vm.snapshotGasLastFrame("Gas", "settleMany: three policies");
    }

    // ───────────────────────────── oracle ─────────────────────────────

    function test_Gas_OnReport_Heartbeat() public {
        _forward(new Reading[](0));
        vm.snapshotGasLastFrame("Gas", "onReport: heartbeat, no readings");
    }

    function test_Gas_OnReport_OneWetReading() public {
        _forward(_readings(Reading(WET_BASE + 2, T0 + 5 minutes, NOW, 500)));
        vm.snapshotGasLastFrame("Gas", "onReport: 1 wet reading");
    }

    function test_Gas_OnReport_TenWetReadings() public {
        Reading[] memory readings = _tenReadings(WET_BASE + 10, T0 + 5 minutes, NOW, 500);
        // The setup reported ten wet cells from WET_BASE; use them, skipping the two already reported to NOW.
        for (uint256 i = 0; i < 10; ++i) {
            readings[i].key = WET_BASE + i;
        }
        readings[0] = Reading(WET_BASE, T0 + 15 minutes, NOW, 200);
        readings[1] = Reading(WET_BASE + 1, NOW - 1, NOW + 1, 1);
        vm.warp(NOW + 1);
        _forward(readings);
        vm.snapshotGasLastFrame("Gas", "onReport: 10 wet readings");
    }

    function test_Gas_OnReport_OneDryReading() public {
        _forward(_readings(Reading(DRY_BASE + 1, T0 + 5 minutes, NOW, 0)));
        vm.snapshotGasLastFrame("Gas", "onReport: 1 dry reading");
    }

    function test_Gas_OnReport_TenDryReadings() public {
        Reading[] memory readings = _tenReadings(DRY_BASE, T0 + 5 minutes, NOW, 0);
        readings[0] = Reading(DRY_BASE, NOW, NOW + 1, 0);
        vm.warp(NOW + 1);
        _forward(readings);
        vm.snapshotGasLastFrame("Gas", "onReport: 10 dry readings");
    }

    function test_Gas_OnReport_TenReadingsForCellsNeverSeenBefore() public {
        _forward(_tenReadings(NEW_BASE, T0 + 15 minutes, NOW, 150));
        vm.snapshotGasLastFrame("Gas", "onReport: 10 readings for new cells");
    }

    function test_Gas_Submit_OneWetReading() public {
        _report(WET_BASE + 2, T0 + 5 minutes, NOW, 500);
        vm.snapshotGasLastFrame("Gas", "submit: 1 wet reading");
    }

    // ───────────────────────────── liquidity ─────────────────────────────

    function test_Gas_RequestRedeem() public {
        vm.prank(lp);
        pool.requestRedeem(POOL_DEPOSIT / 2 * 1e6, lp, lp);
        vm.snapshotGasLastFrame("Gas", "requestRedeem");
    }

    function test_Gas_Redeem_ClaimAMaturedRequest() public {
        vm.prank(leaver);
        uint256 assets = pool.redeem(1_000e6 * 1e6, leaver, leaver);
        vm.snapshotGasLastFrame("Gas", "redeem: claim a matured request");
        assertEq(assets, 1_000e6);
    }

    function test_Gas_CancelRedeemRequest() public {
        vm.prank(leaver);
        pool.cancelRedeemRequest();
        vm.snapshotGasLastFrame("Gas", "cancelRedeemRequest");
    }

    function test_Gas_DepositWithAuthorization() public {
        Authorization memory a = Authorization(holder, address(pool), 500e6, 0, NOW + 1 hours, keccak256("deposit"));
        (uint8 v, bytes32 r, bytes32 s) = _signReceiveAuthorization(holderKey, dollarDomain, a);
        vm.prank(relayer);
        pool.depositWithAuthorization(500e6, holder, a.validAfter, a.validBefore, a.nonce, v, r, s);
        vm.snapshotGasLastFrame("Gas", "depositWithAuthorization");
    }
}
