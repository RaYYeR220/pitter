// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {CoverPool} from "../src/CoverPool.sol";
import {Quote, Reading} from "../src/Types.sol";
import {CoverFixture} from "./utils/CoverFixture.sol";

/// @dev The redemption notice against the two ways capital used to slip out from under the cover it backed:
/// arriving, lifting the caps and leaving in one transaction, and leaving just ahead of a payout that is
/// already known to be coming.
contract LiquidityExitTest is CoverFixture {
    uint64 internal constant NOTICE = 13 hours;
    address internal whale = makeAddr("whale");

    function setUp() public override {
        super.setUp();
        vm.startPrank(owner);
        dollar.mint(whale, 1_000_000e6);
        book.setMaxPolicyPayout(60_000e6);
        vm.stopPrank();
        vm.prank(whale);
        dollar.approve(address(pool), type(uint256).max);
    }

    function _bigQuote(uint64 start) internal returns (Quote memory) {
        // 50,000 dollars of maximum payout over ten minutes: twice what the 100,000 dollar pool allows a cell.
        return _quote(holder, KEY, start, start + 10 minutes, uint128(50_000e6 / uint256(10 minutes)), 500e6);
    }

    function _buyRevert(Quote memory q, bytes4 selector) internal {
        bytes memory signature = _signQuote(q);
        vm.expectRevert(selector);
        vm.prank(holder);
        book.buy(q, signature);
    }

    function test_FlashCapital_CannotBackASaleAndLeaveInTheSameBlock() public {
        Quote memory q = _bigQuote(_now());
        _buyRevert(q, CoverPool.CellCapExceeded.selector);

        // Borrowed capital quadruples the pool and the oversized policy goes through...
        vm.startPrank(whale);
        uint256 shares = pool.deposit(300_000e6, whale);
        vm.stopPrank();
        uint256 id = _buy(q);
        assertEq(pool.cellExposure(KEY), _policy(id).maxPayout);

        // ...but the capital cannot be pulled back out from under it.
        vm.startPrank(whale);
        vm.expectRevert(CoverPool.InsufficientRequest.selector);
        pool.redeem(shares, whale, whale);

        pool.requestRedeem(shares, whale, whale);
        vm.expectRevert(CoverPool.NoticeNotOver.selector);
        pool.redeem(shares, whale, whale);
        vm.expectRevert(CoverPool.NoticeNotOver.selector);
        pool.withdraw(300_000e6, whale, whale);
        vm.stopPrank();

        // It stays on risk for the whole window: the storm it helped insure comes out of its shares too.
        vm.warp(q.end);
        _report(KEY, q.start, q.end, 600);
        uint256 paid = book.settle(id);
        assertEq(paid, _policy(id).maxPayout);

        vm.warp(T0 + NOTICE);
        vm.prank(whale);
        uint256 assets = pool.redeem(shares, whale, whale);
        assertLt(assets, 300_000e6 - paid * 70 / 100, "the capital left without its share of the loss");
    }

    function test_AnExitRequestedAheadOfAWetReportStillBearsTheLoss() public {
        uint256 id = _buy(_quote(holder, KEY, _now() + 60, _now() + 60 + 10 minutes, 30e6, 200e6));
        PolicyView memory p = _policy(id);

        // It starts to rain. The provider sees it before the oracle does and heads for the door.
        uint256 shares = pool.balanceOf(lp);
        uint256 valueAtRequest = pool.convertToAssets(shares);
        vm.prank(lp);
        pool.requestRedeem(shares, lp, lp);
        assertEq(pool.maxWithdraw(lp), 0);

        // The oracle catches up and the policy pays in full.
        vm.warp(p.end);
        _report(KEY, p.start, p.end, 600);
        assertEq(book.settle(id), 18_000e6);

        vm.warp(T0 + NOTICE);
        vm.prank(lp);
        uint256 assets = pool.redeem(shares, lp, lp);

        assertApproxEqAbs(assets, valueAtRequest - 18_000e6, 2);
        assertEq(dollar.balanceOf(lp), assets);
    }

    function test_RetiringCapital_BacksNoNewCover() public {
        uint256 shares = pool.balanceOf(lp);
        vm.prank(lp);
        pool.requestRedeem(shares, lp, lp);
        assertEq(pool.activeAssets(), 0);

        // Neither while the notice runs...
        Quote memory q = _standardQuote(0);
        _buyRevert(q, CoverPool.GlobalCapExceeded.selector);

        // ...nor once the request has matured and the capital can leave at any moment.
        vm.warp(T0 + NOTICE);
        _heartbeat();
        q = _standardQuote(0);
        _buyRevert(q, CoverPool.GlobalCapExceeded.selector);

        // Only capital that has committed to stay is sold against.
        vm.prank(lp);
        pool.cancelRedeemRequest();
        assertEq(_buy(q), 1);
    }

    function test_RetiringCapital_DoesNotCollectThePremiumsOfNewCover() public {
        vm.prank(whale);
        uint256 whaleShares = pool.deposit(100_000e6, whale);

        // One provider asks to leave; the other stays and keeps the pool open for business.
        uint256 shares = pool.balanceOf(lp);
        vm.prank(lp);
        pool.requestRedeem(shares, lp, lp);

        Quote memory q = _quote(holder, KEY, _now(), _now() + 10 minutes, RATE, 1_000e6);
        uint256 id = _buy(q);
        vm.warp(q.end);
        _report(KEY, q.start, q.end, 0);
        book.settle(id);

        vm.warp(T0 + NOTICE);
        vm.prank(lp);
        uint256 assets = pool.redeem(shares, lp, lp);

        // 950 dollars of premium reached the pool. None of it leaves with the retiring provider; the provider who
        // stays keeps its own half and the retiring half goes to the treasury with the fee.
        assertEq(assets, POOL_DEPOSIT);
        assertApproxEqAbs(pool.convertToAssets(whaleShares), 100_000e6 + 475e6, 2);
        assertApproxEqAbs(dollar.balanceOf(treasury), 50e6 + 475e6, 2);
    }

    /// @dev One window of 160 policies of 500 at 187.50 each (a 30% chance of rain with a 25% load), bought by
    /// a provider who holds the only active shares while `lp` is in notice or, in the control, active. Everybody
    /// is unwound afterwards. Returns the buyer's and `lp`'s result.
    function _playOneWindow(bool lpInNotice, bool wet) internal returns (int256 buyer, int256 retiring) {
        uint256 lpShares = pool.balanceOf(lp);
        if (lpInNotice) {
            vm.prank(lp);
            pool.requestRedeem(lpShares, lp, lp);
        }

        vm.prank(owner);
        dollar.mint(attacker, 120_000e6);
        uint256 funds = dollar.balanceOf(attacker);
        vm.startPrank(attacker);
        dollar.approve(address(pool), type(uint256).max);
        dollar.approve(address(book), type(uint256).max);
        uint256 buyerShares = pool.deposit(100_000e6, attacker);
        vm.stopPrank();

        uint64 start = _now() + 60;
        uint64 end = start + 10 minutes;
        uint256[] memory ids = new uint256[](160);
        for (uint256 i = 0; i < ids.length; ++i) {
            ids[i] = _buy(_quote(attacker, KEY + i % 4, start, end, uint128(500e6 / uint256(10 minutes)), 187_500000));
        }
        vm.warp(end);
        Reading[] memory readings = new Reading[](4);
        for (uint256 c = 0; c < 4; ++c) {
            readings[c] = Reading(KEY + c, start, end, wet ? 600 : 0);
        }
        _submitReport(readings);
        book.settleMany(ids);

        if (!lpInNotice) {
            vm.prank(lp);
            pool.requestRedeem(lpShares, lp, lp);
        }
        vm.warp(_now() + NOTICE);
        vm.prank(lp);
        pool.redeem(lpShares, lp, lp);

        vm.startPrank(attacker);
        pool.requestRedeem(buyerShares, attacker, attacker);
        vm.warp(_now() + NOTICE);
        pool.redeem(buyerShares, attacker, attacker);
        vm.stopPrank();

        buyer = int256(dollar.balanceOf(attacker)) - int256(funds);
        retiring = int256(dollar.balanceOf(lp)) - int256(POOL_DEPOSIT);
    }

    function _bothWeathers(bool lpInNotice) internal returns (int256 dry, int256 wet, int256 lpDry, int256 lpWet) {
        uint256 snapshot = vm.snapshotState();
        (dry, lpDry) = _playOneWindow(lpInNotice, false);
        vm.revertToState(snapshot);
        (wet, lpWet) = _playOneWindow(lpInNotice, true);
        vm.revertToState(snapshot);
    }

    function test_ABuyerWhoHoldsTheActiveSharesStillPaysForCoverWrittenAgainstThem() public {
        (int256 dry, int256 wet, int256 lpDry, int256 lpWet) = _bothWeathers(true);

        // Dry, the buyer gets back only its own half of the premium; the retiring half goes to the treasury.
        assertApproxEqAbs(dry, -15_750e6, 1e6);
        assertApproxEqAbs(lpDry, 0, 1e6);
        assertApproxEqAbs(wet, 24_250e6, 1e6);
        assertApproxEqAbs(lpWet, -25_750e6, 1e6);

        // At the 30% it was priced for, the bet loses, exactly as it does against a provider who stays.
        (int256 controlDry, int256 controlWet,,) = _bothWeathers(false);
        assertApproxEqAbs(dry, controlDry, 1e6);
        assertApproxEqAbs(wet, controlWet, 1e6);
        assertLt((3 * wet + 7 * dry) / 10, -3_500e6);
    }

    function test_AMaturedRequest_WaitsForPoliciesTheOracleHasNotClosed() public {
        // A policy is sold against the provider's capital, then the provider asks for all of it back.
        Quote memory q = _quote(holder, KEY, _now() + 60, _now() + 60 + 10 minutes, 30e6, 200e6);
        uint256 id = _buy(q);
        uint256 shares = pool.balanceOf(lp);
        vm.prank(lp);
        pool.requestRedeem(shares, lp, lp);

        // The notice is over and so is the window, but the oracle never reported it: the claim waits until the
        // policy sold before the request is closed.
        vm.warp(T0 + NOTICE);
        assertTrue(pool.claimBlockedByCover(lp));
        assertEq(pool.claimableRedeemRequest(0, lp), 0);
        assertEq(pool.maxWithdraw(lp), 0);

        vm.prank(lp);
        vm.expectRevert(CoverPool.CoverStillOpen.selector);
        pool.redeem(shares, lp, lp);

        // Once the window is reported dry and settled, all of it can go.
        _report(KEY, q.start, q.end, 0);
        book.settle(id);
        assertFalse(pool.claimBlockedByCover(lp));
        vm.prank(lp);
        uint256 assets = pool.redeem(shares, lp, lp);
        assertApproxEqAbs(assets, POOL_DEPOSIT + 190e6, 2);
        assertEq(pool.lockedExposure(), 0);
    }

    function test_ALeaverCarriesItsShareOfALossConfirmedBeforeItsClaim() public {
        vm.prank(whale);
        pool.deposit(100_000e6, whale);

        // Three policies of 50,000, each the per-cell cap of the 200,000 pool; then `lp` asks to leave.
        uint64 start = _now() + 60;
        uint64 end = start + 10 minutes;
        uint128 rate = uint128(50_000e6 / uint256(10 minutes));
        uint256[] memory ids = new uint256[](3);
        Reading[] memory wet = new Reading[](3);
        for (uint256 i = 0; i < 3; ++i) {
            ids[i] = _buy(_quote(holder, KEY + i, start, end, rate, 500e6));
            wet[i] = Reading(KEY + i, start, end, 600);
        }
        uint256 shares = pool.balanceOf(lp);
        vm.prank(lp);
        pool.requestRedeem(shares, lp, lp);

        // It rains through all three windows and the oracle says so on time. Nobody settles.
        vm.warp(end);
        _submitReport(wet);

        // The notice ends long after the windows did, with the loss confirmed but not yet paid: the claim
        // waits for it.
        vm.warp(T0 + NOTICE);
        vm.prank(lp);
        vm.expectRevert(CoverPool.CoverStillOpen.selector);
        pool.redeem(shares, lp, lp);

        // Anyone may settle, the leaver included. It then carries half of the loss, like the provider who stays.
        vm.startPrank(lp);
        book.settleMany(ids);
        uint256 out = pool.redeem(shares, lp, lp);
        vm.stopPrank();

        uint256 loss = 3 * 600 * uint256(rate);
        assertApproxEqAbs(out, pool.convertToAssets(pool.balanceOf(whale)), 10);
        assertApproxEqAbs(out, (200_000e6 + 3 * 475e6 - loss) / 2, 10);
    }

    function test_TheNoticeCannotBeCutBelowTheCoverHorizonAndTheMargin() public {
        assertEq(pool.NOTICE_MARGIN(), book.NOTICE_MARGIN());

        vm.startPrank(owner);
        vm.expectRevert(CoverPool.NoticeInvalid.selector);
        pool.setRedeemNotice(13 hours - 1);
        vm.expectRevert(CoverPool.NoticeInvalid.selector);
        pool.setRedeemNotice(12 hours + 30 minutes);
        pool.setRedeemNotice(13 hours);

        // To shorten the notice further, the book first has to stop selling that far ahead.
        book.setDurationBounds(60, 1 hours);
        book.setMaxHorizon(1 hours);
        pool.setRedeemNotice(1 hours + 30 minutes);
        vm.stopPrank();

        assertEq(pool.redeemNotice(), book.maxHorizon() + book.NOTICE_MARGIN());
    }

    function test_ARequestMadeInTheSecondOfASaleAtTheHorizonWaitsForItsLastInterval() public {
        vm.prank(whale);
        pool.deposit(100_000e6, whale);

        // A notice equal to the horizon is refused: a request made in the second of a sale at the horizon would
        // mature in the second that window ends, before the oracle could report its last interval.
        uint64 horizon = book.maxHorizon();
        vm.prank(owner);
        vm.expectRevert(CoverPool.NoticeInvalid.selector);
        pool.setRedeemNotice(horizon);

        // A ten-minute window ending exactly at the horizon; `lp` asks to leave in the same second.
        uint64 end = _now() + horizon;
        uint64 start = end - 10 minutes;
        uint128 rate = uint128(50_000e6 / uint256(10 minutes));
        uint256 id = _buy(_quote(holder, KEY, start, end, rate, 500e6));
        uint256 shares = pool.balanceOf(lp);
        vm.prank(lp);
        pool.requestRedeem(shares, lp, lp);
        (,, uint64 claimableAt,) = pool.redeemRequests(lp);
        assertEq(claimableAt, end + book.NOTICE_MARGIN());

        // The first half is reported wet and settled at once.
        vm.warp(start + 5 minutes);
        _report(KEY, start, start + 5 minutes, 300);
        book.settle(id);

        // The second half is reported wet after the window; when the notice ends nobody has settled it yet.
        vm.warp(end + 20);
        _report(KEY, start + 5 minutes, end, 300);
        vm.warp(claimableAt);
        vm.prank(lp);
        vm.expectRevert(CoverPool.CoverStillOpen.selector);
        pool.redeem(shares, lp, lp);

        // Settled, the claim goes through and both providers have carried both halves.
        book.settle(id);
        vm.prank(lp);
        uint256 out = pool.redeem(shares, lp, lp);
        assertApproxEqAbs(out, pool.convertToAssets(pool.balanceOf(whale)), 10);
        assertApproxEqAbs(out, (200_000e6 + 475e6 - 600 * uint256(rate)) / 2, 10);
    }

    /// @dev Whatever window the book sells and whenever a provider then asks to leave, the request matures no
    /// earlier than the window ends.
    function testFuzz_ARequestMadeAfterASaleMaturesNoEarlierThanTheCoverEnds(
        uint256 minutesSeed,
        uint256 leadSeed,
        uint256 waitSeed
    ) public {
        uint64 duration = 60 * uint64(bound(minutesSeed, 1, 12 hours / 60));
        uint64 start = _now() + 60 * uint64(bound(leadSeed, 0, (book.maxHorizon() - duration) / 60));
        uint256 id = _buy(_quote(holder, KEY, start, start + duration, 1, PREMIUM));

        vm.warp(_now() + bound(waitSeed, 0, 2 days));
        uint256 shares = pool.balanceOf(lp);
        vm.prank(lp);
        pool.requestRedeem(shares, lp, lp);

        (,, uint64 claimableAt,) = pool.redeemRequests(lp);
        assertGe(claimableAt, _policy(id).end + book.NOTICE_MARGIN());
    }
}
