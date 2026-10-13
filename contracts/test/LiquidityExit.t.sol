// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {CoverPool} from "../src/CoverPool.sol";
import {Quote} from "../src/Types.sol";
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

        // 950 dollars of premium reached the pool; none of it leaves with the retiring provider.
        assertEq(assets, POOL_DEPOSIT);
        assertApproxEqAbs(pool.convertToAssets(whaleShares), 100_000e6 + 950e6, 2);
    }

    function test_AMaturedRequest_WaitsForThePoliciesItStillBacks() public {
        vm.prank(owner);
        pool.setRedeemNotice(5 minutes);

        // A policy is sold against the provider's capital, then the provider asks for all of it back.
        Quote memory q = _quote(holder, KEY, _now() + 60, _now() + 60 + 10 minutes, 30e6, 200e6);
        uint256 id = _buy(q);
        uint256 shares = pool.balanceOf(lp);
        vm.prank(lp);
        pool.requestRedeem(shares, lp, lp);

        // The short notice is over while the policy is still open: what it may yet pay stays in the pool.
        vm.warp(T0 + 5 minutes);
        assertEq(pool.claimableRedeemRequest(0, lp), shares);
        assertEq(pool.maxWithdraw(lp), pool.freeAssets());
        assertEq(pool.freeAssets(), pool.totalAssets() - 18_000e6);

        vm.prank(lp);
        vm.expectRevert(CoverPool.ExposureLocked.selector);
        pool.redeem(shares, lp, lp);

        // Once the window is over and dry, the rest can go.
        vm.warp(q.end);
        _report(KEY, q.start, q.end, 0);
        book.settle(id);
        vm.prank(lp);
        uint256 assets = pool.redeem(shares, lp, lp);
        assertApproxEqAbs(assets, POOL_DEPOSIT + 190e6, 2);
        assertEq(pool.lockedExposure(), 0);
    }
}
