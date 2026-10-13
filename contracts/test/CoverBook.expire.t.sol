// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {CoverBook} from "../src/CoverBook.sol";
import {Quote} from "../src/Types.sol";
import {CoverFixture} from "./utils/CoverFixture.sol";

contract CoverBookExpireTest is CoverFixture {
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

    function test_Expire_RevertWhen_TheGracePeriodIsNotOver() public {
        vm.warp(end + 24 hours - 1);
        vm.expectRevert(CoverBook.ExpiryNotReached.selector);
        book.expire(id);

        assertFalse(_policy(id).closed);
        assertEq(pool.lockedExposure(), MAX_PAYOUT);
    }

    function test_Expire_ClosesAPolicyTheIndexNeverReported() public {
        vm.warp(end + 24 hours);

        vm.expectEmit(address(book));
        emit CoverBook.PolicySettled(id, holder, 0, start, true);
        vm.prank(keeper);
        book.expire(id);

        PolicyView memory p = _policy(id);
        assertTrue(p.closed);
        assertEq(p.paid, 0);
        assertEq(p.settledUntil, start);
        assertEq(pool.lockedExposure(), 0);
        assertEq(pool.cellExposure(KEY), 0);
        assertEq(book.activeCells().length, 0);
        assertEq(book.openPolicies(KEY), 0);
        assertEq(pool.freeAssets(), pool.totalAssets());
    }

    function test_Expire_PaysWhatWasConfirmedBeforeClosing() public {
        vm.warp(start + 300);
        _report(KEY, start, start + 300, 100);

        vm.warp(end + 24 hours);
        vm.expectEmit(address(book));
        emit CoverBook.PolicySettled(id, holder, 100 * RATE, start + 300, true);
        vm.prank(keeper);
        book.expire(id);

        PolicyView memory p = _policy(id);
        assertTrue(p.closed);
        assertEq(p.paid, 100 * RATE);
        assertEq(p.settledUntil, start + 300);
        assertEq(dollar.balanceOf(holder), HOLDER_FUNDS - PREMIUM + 100 * RATE);
        assertEq(pool.lockedExposure(), 0);
    }

    function test_Expire_AfterAPartialSettlementReleasesTheRest() public {
        vm.warp(start + 300);
        _report(KEY, start, start + 300, 100);
        book.settle(id);
        assertEq(pool.lockedExposure(), MAX_PAYOUT - 100 * RATE);

        vm.warp(end + 24 hours);
        book.expire(id);

        assertTrue(_policy(id).closed);
        assertEq(_policy(id).paid, 100 * RATE);
        assertEq(pool.lockedExposure(), 0);
    }

    function test_Expire_ALateReportPaysNothingAfterwards() public {
        vm.warp(end + 24 hours);
        book.expire(id);

        _report(KEY, start, end, 600);
        assertEq(book.claimable(id), 0);
        assertEq(book.settle(id), 0);
        assertEq(_policy(id).paid, 0);
        assertEq(dollar.balanceOf(holder), HOLDER_FUNDS - PREMIUM);
    }

    function test_Expire_SettlesInFullWhenTheWindowWasReported() public {
        vm.warp(end);
        _report(KEY, start, end, 450);

        vm.warp(end + 24 hours);
        book.expire(id);

        PolicyView memory p = _policy(id);
        assertTrue(p.closed);
        assertEq(p.paid, 450 * RATE);
        assertEq(p.settledUntil, end);
    }

    function test_Expire_RevertWhen_PolicyUnknown() public {
        vm.warp(end + 24 hours);
        vm.expectRevert(CoverBook.PolicyUnknown.selector);
        book.expire(0);

        vm.expectRevert(CoverBook.PolicyUnknown.selector);
        book.expire(id + 1);
    }

    function test_Expire_OnAClosedPolicyDoesNothing() public {
        vm.warp(end);
        _report(KEY, start, end, 600);
        book.settle(id);

        vm.warp(end + 24 hours);
        vm.recordLogs();
        book.expire(id);
        assertEq(vm.getRecordedLogs().length, 0);
        assertEq(_policy(id).paid, MAX_PAYOUT);
    }

    function test_Expire_FollowsTheConfiguredGrace() public {
        vm.prank(owner);
        book.setExpiryGrace(1 hours);

        vm.warp(end + 1 hours - 1);
        vm.expectRevert(CoverBook.ExpiryNotReached.selector);
        book.expire(id);

        vm.warp(end + 1 hours);
        book.expire(id);
        assertTrue(_policy(id).closed);
    }

    function test_Settle_StillWorksAfterTheGracePeriod() public {
        vm.warp(end + 48 hours);
        _report(KEY, start, end, 600);

        assertEq(book.settle(id), MAX_PAYOUT);
        assertTrue(_policy(id).closed);
    }
}
