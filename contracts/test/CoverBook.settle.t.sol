// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Vm} from "forge-std/Vm.sol";
import {CoverBook} from "../src/CoverBook.sol";
import {CoverPool} from "../src/CoverPool.sol";
import {IWeatherIndex} from "../src/interfaces/IWeatherIndex.sol";
import {Quote, Reading} from "../src/Types.sol";
import {CoverFixture} from "./utils/CoverFixture.sol";

contract CoverBookSettleTest is CoverFixture {
    uint64 internal start;
    uint64 internal end;
    uint256 internal id;
    uint256 internal constant MAX_PAYOUT = uint256(RATE) * 10 minutes;

    function setUp() public override {
        super.setUp();
        Quote memory q = _standardQuote(60);
        start = q.start;
        end = q.end;
        id = _buy(q);
    }

    function _settle(uint256 policyId) internal returns (uint256) {
        vm.prank(keeper);
        return book.settle(policyId);
    }

    // ───────────────────────────── settle ─────────────────────────────

    function test_Settle_PaysConfirmedWetSecondsWhileTheWindowIsOpen() public {
        vm.warp(start + 300);
        _report(KEY, start, start + 300, 120);
        uint256 holderBefore = dollar.balanceOf(holder);
        uint256 poolBefore = dollar.balanceOf(address(pool));

        vm.expectEmit(address(book));
        emit CoverBook.PolicySettled(id, holder, 120 * RATE, start + 300, false);
        uint256 paid = _settle(id);

        assertEq(paid, 120 * RATE);
        assertEq(dollar.balanceOf(holder), holderBefore + paid);
        assertEq(dollar.balanceOf(address(pool)), poolBefore - paid);
        assertEq(dollar.balanceOf(keeper), 0);

        PolicyView memory p = _policy(id);
        assertEq(p.paid, paid);
        assertEq(p.settledUntil, start + 300);
        assertFalse(p.closed);
        assertEq(pool.lockedExposure(), MAX_PAYOUT - paid);
        assertEq(pool.cellExposure(KEY), MAX_PAYOUT - paid);
        assertEq(book.activeCells().length, 1);
    }

    function test_Settle_ClosesAtTheEndOfTheWindowAndReleasesTheRest() public {
        vm.warp(start + 300);
        _report(KEY, start, start + 300, 120);
        _settle(id);

        vm.warp(end);
        _report(KEY, start + 300, end, 60);

        vm.expectEmit(address(book));
        emit CoverBook.PolicySettled(id, holder, 60 * RATE, end, true);
        uint256 paid = _settle(id);

        assertEq(paid, 60 * RATE);
        PolicyView memory p = _policy(id);
        assertEq(p.paid, 180 * RATE);
        assertEq(p.settledUntil, end);
        assertTrue(p.closed);
        assertEq(dollar.balanceOf(holder), HOLDER_FUNDS - PREMIUM + 180 * RATE);

        assertEq(pool.lockedExposure(), 0);
        assertEq(pool.cellExposure(KEY), 0);
        assertEq(book.activeCells().length, 0);
        assertEq(book.openPolicies(KEY), 0);
        assertEq(pool.freeAssets(), pool.totalAssets());
    }

    function test_Settle_AFullyWetWindowPaysExactlyTheMaximum() public {
        vm.warp(end);
        _report(KEY, start, end, 600);

        uint256 paid = _settle(id);

        assertEq(paid, MAX_PAYOUT);
        assertTrue(_policy(id).closed);
        assertEq(pool.lockedExposure(), 0);
    }

    function test_Settle_ADryWindowPaysNothingAndReleasesEverything() public {
        vm.warp(end);
        _report(KEY, start, end, 0);

        vm.expectEmit(address(book));
        emit CoverBook.PolicySettled(id, holder, 0, end, true);
        uint256 paid = _settle(id);

        assertEq(paid, 0);
        assertTrue(_policy(id).closed);
        assertEq(pool.lockedExposure(), 0);
        assertEq(dollar.balanceOf(holder), HOLDER_FUNDS - PREMIUM);
    }

    function test_Settle_IsANoOpUntilTheIndexReportsNewTime() public {
        vm.warp(start + 300);
        vm.recordLogs();
        assertEq(_settle(id), 0);
        assertEq(vm.getRecordedLogs().length, 0);
        assertEq(_policy(id).settledUntil, start);

        _report(KEY, start, start + 300, 300);
        assertEq(_settle(id), 300 * RATE);

        vm.recordLogs();
        assertEq(_settle(id), 0);
        assertEq(vm.getRecordedLogs().length, 0);
        assertEq(_policy(id).paid, 300 * RATE);
    }

    function test_Settle_IgnoresRainBeforeTheWindow() public {
        vm.warp(start);
        _report(KEY, T0, start, 60);

        assertEq(_settle(id), 0);
        assertEq(_policy(id).paid, 0);
        assertEq(pool.lockedExposure(), MAX_PAYOUT);
    }

    function test_Settle_IgnoresRainAfterTheWindow() public {
        vm.warp(end + 10 minutes);
        _report(KEY, start, end, 0);
        _report(KEY, end, end + 10 minutes, 600);

        assertEq(_settle(id), 0);
        assertTrue(_policy(id).closed);
    }

    function test_Settle_TakesOnlyTheWindowsShareOfAReportThatStraddlesIt() public {
        // Rain for half of a five-minute interval that starts one minute before the window.
        vm.warp(start + 240);
        _report(KEY, start - 60, start + 240, 150);

        // 30 of the 150 wet seconds fall before the window.
        assertEq(_settle(id), 120 * RATE);

        // The same at the far end: a report that runs past the window's end.
        vm.warp(end + 240);
        _report(KEY, start + 240, end + 240, 600);
        assertEq(_settle(id), 360 * RATE);
        assertTrue(_policy(id).closed);
    }

    function test_Settle_SplittingSettlementsNeverPaysMoreThanSettlingOnce() public {
        uint256 snapshot = vm.snapshotState();

        // Settle after every report.
        uint256 split;
        vm.warp(start + 200);
        _report(KEY, start - 60, start + 200, 77);
        split += _settle(id);
        vm.warp(start + 400);
        _report(KEY, start + 200, start + 400, 133);
        split += _settle(id);
        vm.warp(end + 100);
        _report(KEY, start + 400, end + 100, 211);
        split += _settle(id);
        assertTrue(_policy(id).closed);

        // Settle once at the end.
        vm.revertToState(snapshot);
        vm.warp(end + 100);
        _submitReport(_readings(Reading(KEY, start - 60, start + 200, 77), Reading(KEY, start + 200, start + 400, 133)));
        _report(KEY, start + 400, end + 100, 211);
        uint256 once = _settle(id);

        assertLe(split, once);
        assertLe(once, MAX_PAYOUT);
        assertEq(split, once, "settling on report boundaries loses nothing");
    }

    function test_Settle_IsPermissionlessAndAlwaysPaysTheHolder() public {
        vm.warp(end);
        _report(KEY, start, end, 300);

        vm.prank(attacker);
        uint256 paid = book.settle(id);

        assertEq(paid, 300 * RATE);
        assertEq(dollar.balanceOf(holder), HOLDER_FUNDS - PREMIUM + paid);
        assertEq(dollar.balanceOf(attacker), HOLDER_FUNDS);
    }

    function test_Settle_RevertWhen_PolicyUnknown() public {
        vm.expectRevert(CoverBook.PolicyUnknown.selector);
        book.settle(0);

        vm.expectRevert(CoverBook.PolicyUnknown.selector);
        book.settle(id + 1);
    }

    function test_Settle_OnAClosedPolicyDoesNothing() public {
        vm.warp(end);
        _report(KEY, start, end, 600);
        _settle(id);

        vm.warp(end + 1 hours);
        _report(KEY, end, end + 1 hours, 3600);
        vm.recordLogs();
        assertEq(_settle(id), 0);
        assertEq(vm.getRecordedLogs().length, 0);
        assertEq(_policy(id).paid, MAX_PAYOUT);
    }

    function test_Settle_NeverPaysMoreThanTheMaximumEvenIfTheIndexOverReports() public {
        GenerousIndex generous = new GenerousIndex();
        CoverPool otherPool = new CoverPool(dollar, owner, "Cover Pool Share", "cvUSD");
        CoverBook otherBook = new CoverBook(
            dollar, otherPool, IWeatherIndex(address(generous)), underwriter, treasury, 0, MAX_POLICY_PAYOUT, owner
        );
        vm.prank(owner);
        otherPool.setBook(address(otherBook));
        vm.prank(owner);
        dollar.mint(address(otherPool), POOL_DEPOSIT);
        vm.prank(holder);
        dollar.approve(address(otherBook), type(uint256).max);

        Quote memory q = _standardQuote(0);
        bytes memory signature = _signDigest(underwriterKey, _quoteDigest(otherBook.DOMAIN_SEPARATOR(), q));
        vm.prank(holder);
        uint256 otherId = otherBook.buy(q, signature);

        // The index claims ten wet seconds per second.
        uint256 total;
        vm.warp(q.start + 30);
        total += otherBook.settle(otherId);
        vm.warp(q.start + 61);
        total += otherBook.settle(otherId);
        vm.warp(q.end);
        total += otherBook.settle(otherId);

        assertEq(total, MAX_PAYOUT);
        (,,,,,,, uint256 paid,, bool closed) = otherBook.policies(otherId);
        assertEq(paid, MAX_PAYOUT);
        assertTrue(closed);
        assertEq(otherPool.lockedExposure(), 0);
    }

    function test_Settle_DefersThePayoutWhenTheHolderCannotReceiveAndStillCloses() public {
        vm.warp(end);
        _report(KEY, start, end, 300);
        vm.prank(owner);
        dollar.setBlocked(holder, true);

        vm.expectEmit(address(pool));
        emit CoverPool.PayoutDeferred(holder, 300 * RATE);
        uint256 paid = _settle(id);

        assertEq(paid, 300 * RATE);
        assertTrue(_policy(id).closed);
        assertEq(pool.lockedExposure(), 0);
        assertEq(book.activeCells().length, 0);
        assertEq(pool.deferred(holder), 300 * RATE);
        assertEq(dollar.balanceOf(holder), HOLDER_FUNDS - PREMIUM);

        vm.prank(owner);
        dollar.setBlocked(holder, false);
        pool.claimDeferred(holder);
        assertEq(dollar.balanceOf(holder), HOLDER_FUNDS - PREMIUM + 300 * RATE);
    }

    function test_Settle_PoliciesInOneCellShareTheSameReports() public {
        // A second, larger policy over the same window for another holder.
        Quote memory q = _quote(attacker, KEY, start, end, 3 * RATE, PREMIUM);
        uint256 second = _buy2(q);
        assertEq(book.openPolicies(KEY), 2);
        assertEq(pool.cellExposure(KEY), 4 * MAX_PAYOUT);

        vm.warp(end);
        _report(KEY, start, end, 200);

        assertEq(_settle(id), 200 * RATE);
        assertEq(book.activeCells().length, 1, "cell stays active while a policy is open");
        assertEq(pool.cellExposure(KEY), 3 * MAX_PAYOUT);

        assertEq(_settle(second), 600 * RATE);
        assertEq(book.activeCells().length, 0);
        assertEq(pool.cellExposure(KEY), 0);
        assertEq(pool.lockedExposure(), 0);
    }

    function test_Settle_ActiveCellsFollowOpenPolicies() public {
        uint256 other = _buy(_quote(holder, OTHER_KEY, start, end, RATE, PREMIUM));
        uint256[] memory cells = book.activeCells();
        assertEq(cells.length, 2);
        assertEq(cells[0], KEY);
        assertEq(cells[1], OTHER_KEY);

        vm.warp(end);
        _submitReport(_readings(Reading(KEY, start, end, 0), Reading(OTHER_KEY, start, end, 0)));

        _settle(id);
        cells = book.activeCells();
        assertEq(cells.length, 1);
        assertEq(cells[0], OTHER_KEY);

        _settle(other);
        assertEq(book.activeCells().length, 0);
    }

    function test_Settle_FreesACellSlotForNewSales() public {
        vm.prank(owner);
        book.setMaxActiveCells(1);

        vm.warp(end);
        _report(KEY, start, end, 0);
        Quote memory q = _quote(holder, OTHER_KEY, end, end + 10 minutes, RATE, PREMIUM);
        bytes memory signature = _signQuote(q);
        vm.expectRevert(CoverBook.TooManyCells.selector);
        vm.prank(holder);
        book.buy(q, signature);

        _settle(id);
        vm.prank(holder);
        book.buy(q, signature);
        assertEq(book.activeCells()[0], OTHER_KEY);
    }

    // ───────────────────────────── claimable ─────────────────────────────

    function test_Claimable_IsWhatSettleWouldPay() public {
        assertEq(book.claimable(id), 0);

        vm.warp(start + 300);
        _report(KEY, start, start + 300, 120);
        assertEq(book.claimable(id), 120 * RATE);

        assertEq(_settle(id), 120 * RATE);
        assertEq(book.claimable(id), 0);

        vm.warp(end);
        _report(KEY, start + 300, end, 300);
        assertEq(book.claimable(id), 300 * RATE);
        _settle(id);
        assertEq(book.claimable(id), 0);
    }

    function test_Claimable_IsZeroForUnknownPolicies() public view {
        assertEq(book.claimable(0), 0);
        assertEq(book.claimable(id + 1), 0);
    }

    // ───────────────────────────── settleMany ─────────────────────────────

    function test_SettleMany_SettlesEveryPolicyAndSkipsClosedOnes() public {
        uint256 second = _buy(_quote(holder, OTHER_KEY, start, end, 2 * RATE, PREMIUM));
        uint256 third = _buy2(_quote(attacker, KEY, start, end, RATE, PREMIUM));

        vm.warp(end);
        _submitReport(_readings(Reading(KEY, start, end, 100), Reading(OTHER_KEY, start, end, 50)));
        _settle(id);

        uint256[] memory ids = new uint256[](3);
        ids[0] = id;
        ids[1] = second;
        ids[2] = third;
        uint256 holderBefore = dollar.balanceOf(holder);
        uint256 attackerBefore = dollar.balanceOf(attacker);

        vm.prank(keeper);
        book.settleMany(ids);

        assertEq(dollar.balanceOf(holder), holderBefore + 50 * 2 * RATE);
        assertEq(dollar.balanceOf(attacker), attackerBefore + 100 * RATE);
        assertTrue(_policy(second).closed);
        assertTrue(_policy(third).closed);
        assertEq(pool.lockedExposure(), 0);
        assertEq(book.activeCells().length, 0);
    }

    function test_SettleMany_AcceptsAnEmptyList() public {
        book.settleMany(new uint256[](0));
    }

    function test_SettleMany_RevertWhen_AnIdIsUnknown() public {
        uint256[] memory ids = new uint256[](2);
        ids[0] = id;
        ids[1] = 99;

        vm.expectRevert(CoverBook.PolicyUnknown.selector);
        book.settleMany(ids);
    }

    // ───────────────────────────── helpers ─────────────────────────────

    function _buy2(Quote memory q) private returns (uint256) {
        bytes memory signature = _signQuote(q);
        vm.startPrank(q.holder);
        dollar.approve(address(book), type(uint256).max);
        uint256 policyId = book.buy(q, signature);
        vm.stopPrank();
        return policyId;
    }
}

/// @dev An index that is always fresh, has always reported up to now and claims ten wet seconds per second.
contract GenerousIndex {
    function heartbeat() external view returns (uint64) {
        return uint64(block.timestamp);
    }

    function lastTo(uint256) external view returns (uint64) {
        return uint64(block.timestamp);
    }

    function wetSeconds(uint256, uint64 a, uint64 b) external pure returns (uint256) {
        return uint256(b - a) * 10;
    }
}
