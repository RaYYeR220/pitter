// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {CoverPool} from "../src/CoverPool.sol";
import {IERC7540Redeem} from "../src/interfaces/IERC7540Redeem.sol";
import {PoolFixture} from "./utils/PoolFixture.sol";

/// @dev Leaving the pool: a redemption is requested, waits out the notice in escrow and is then claimed.
contract CoverPoolRedeemTest is PoolFixture {
    uint256 internal constant DEPOSIT = 1_000e6;
    uint256 internal constant SHARES = DEPOSIT * SHARE_UNIT;
    uint64 internal constant NOTICE = 13 hours;

    function setUp() public override {
        super.setUp();
        _deposit(lp, DEPOSIT);
    }

    function _request(address from, uint256 shares) internal {
        vm.prank(from);
        pool.requestRedeem(shares, from, from);
    }

    function _redeem(address from, uint256 shares) internal returns (uint256) {
        vm.prank(from);
        return pool.redeem(shares, from, from);
    }

    function _state(address controller) internal view returns (uint256 shares, uint256 assetsAtRequest, uint64 at) {
        (shares, assetsAtRequest, at) = pool.redeemRequests(controller);
    }

    function _donate(uint256 amount) internal {
        vm.prank(attacker);
        dollar.transfer(address(pool), amount);
    }

    function _loss(uint256 amount) internal {
        vm.prank(book);
        pool.pay(holder, KEY, amount);
    }

    // ───────────────────────────── requesting ─────────────────────────────

    function test_RedeemNotice_DefaultsToThirteenHours() public view {
        assertEq(pool.redeemNotice(), 13 hours);
        assertEq(pool.MIN_REDEEM_NOTICE(), 1 minutes);
        assertEq(pool.MAX_REDEEM_NOTICE(), 7 days);
        assertEq(pool.escrowedShares(), 0);
        assertEq(pool.activeAssets(), DEPOSIT);
    }

    function test_RequestRedeem_EscrowsTheSharesAndStartsTheNotice() public {
        uint256 shares = 400e6 * SHARE_UNIT;

        vm.expectEmit(address(pool));
        emit IERC7540Redeem.RedeemRequest(lp, lp, 0, lp, shares);
        vm.prank(lp);
        uint256 requestId = pool.requestRedeem(shares, lp, lp);

        assertEq(requestId, 0);
        assertEq(pool.balanceOf(lp), SHARES - shares);
        assertEq(pool.balanceOf(address(pool)), shares);
        assertEq(pool.escrowedShares(), shares);
        assertEq(pool.totalSupply(), SHARES);
        assertEq(pool.totalAssets(), DEPOSIT);

        (uint256 requested, uint256 assetsAtRequest, uint64 claimableAt) = _state(lp);
        assertEq(requested, shares);
        assertEq(assetsAtRequest, 400e6);
        assertEq(claimableAt, T0 + NOTICE);

        assertEq(pool.pendingRedeemRequest(0, lp), shares);
        assertEq(pool.claimableRedeemRequest(0, lp), 0);
        assertEq(pool.maxRedeem(lp), 0);
        assertEq(pool.maxWithdraw(lp), 0);
        assertEq(pool.activeAssets(), 600e6);
    }

    function test_RequestRedeem_ByASpenderForTheOwner() public {
        vm.prank(lp);
        pool.approve(relayer, 300e6 * SHARE_UNIT);

        vm.expectEmit(address(pool));
        emit IERC7540Redeem.RedeemRequest(lp, lp, 0, relayer, 100e6 * SHARE_UNIT);
        vm.prank(relayer);
        pool.requestRedeem(100e6 * SHARE_UNIT, lp, lp);

        assertEq(pool.allowance(lp, relayer), 200e6 * SHARE_UNIT);
        assertEq(pool.pendingRedeemRequest(0, lp), 100e6 * SHARE_UNIT);
        assertEq(pool.pendingRedeemRequest(0, relayer), 0);
    }

    function test_RequestRedeem_ASpenderMayBecomeTheController() public {
        vm.prank(lp);
        pool.approve(relayer, 100e6 * SHARE_UNIT);

        vm.prank(relayer);
        pool.requestRedeem(100e6 * SHARE_UNIT, relayer, lp);

        assertEq(pool.pendingRedeemRequest(0, relayer), 100e6 * SHARE_UNIT);
        assertEq(pool.pendingRedeemRequest(0, lp), 0);
        assertEq(pool.balanceOf(lp), SHARES - 100e6 * SHARE_UNIT);
    }

    function test_RequestRedeem_RevertWhen_SpenderHasNoAllowance() public {
        vm.expectRevert(
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, attacker, 0, 1e6 * SHARE_UNIT)
        );
        vm.prank(attacker);
        pool.requestRedeem(1e6 * SHARE_UNIT, attacker, lp);
    }

    function test_RequestRedeem_RevertWhen_ControllerIsAThirdParty() public {
        vm.expectRevert(CoverPool.ControllerNotAllowed.selector);
        vm.prank(lp);
        pool.requestRedeem(1e6 * SHARE_UNIT, lp2, lp);
    }

    function test_RequestRedeem_NobodyCanRestartSomeoneElsesNotice() public {
        _request(lp, 400e6 * SHARE_UNIT);
        _deposit(attacker, 10e6);
        vm.warp(T0 + NOTICE - 1);

        // Adding a single share to the victim's request would push its claim another notice period away.
        vm.expectRevert(CoverPool.ControllerNotAllowed.selector);
        vm.prank(attacker);
        pool.requestRedeem(1, lp, attacker);

        (,, uint64 claimableAt) = _state(lp);
        assertEq(claimableAt, T0 + NOTICE);
    }

    function test_RequestRedeem_RevertWhen_ZeroShares() public {
        vm.expectRevert(CoverPool.ZeroShares.selector);
        vm.prank(lp);
        pool.requestRedeem(0, lp, lp);
    }

    function test_RequestRedeem_RevertWhen_MoreThanTheOwnerHolds() public {
        vm.expectRevert(abi.encodeWithSelector(IERC20Errors.ERC20InsufficientBalance.selector, lp, SHARES, SHARES + 1));
        vm.prank(lp);
        pool.requestRedeem(SHARES + 1, lp, lp);
    }

    function test_RequestRedeem_AddingToARequestRestartsTheNotice() public {
        _request(lp, 100e6 * SHARE_UNIT);
        vm.warp(T0 + 12 hours);
        _request(lp, 50e6 * SHARE_UNIT);

        (uint256 requested, uint256 assetsAtRequest, uint64 claimableAt) = _state(lp);
        assertEq(requested, 150e6 * SHARE_UNIT);
        assertEq(assetsAtRequest, 150e6);
        assertEq(claimableAt, T0 + 12 hours + NOTICE);
        assertEq(pool.escrowedShares(), 150e6 * SHARE_UNIT);

        // The first part alone would have matured here; now nothing has.
        vm.warp(T0 + NOTICE);
        assertEq(pool.claimableRedeemRequest(0, lp), 0);
        assertEq(pool.pendingRedeemRequest(0, lp), 150e6 * SHARE_UNIT);
    }

    function test_PendingAndClaimable_FollowTheNotice() public {
        uint256 shares = 400e6 * SHARE_UNIT;
        _request(lp, shares);

        vm.warp(T0 + NOTICE - 1);
        assertEq(pool.pendingRedeemRequest(0, lp), shares);
        assertEq(pool.claimableRedeemRequest(0, lp), 0);
        assertEq(pool.maxRedeem(lp), 0);
        assertEq(pool.maxWithdraw(lp), 0);

        vm.warp(T0 + NOTICE);
        assertEq(pool.pendingRedeemRequest(0, lp), 0);
        assertEq(pool.claimableRedeemRequest(0, lp), shares);
        assertEq(pool.maxRedeem(lp), shares);
        assertEq(pool.maxWithdraw(lp), 400e6);

        // There is one request per controller and its id is zero.
        assertEq(pool.pendingRedeemRequest(1, lp), 0);
        assertEq(pool.claimableRedeemRequest(1, lp), 0);
        assertEq(pool.claimableRedeemRequest(0, lp2), 0);
    }

    // ───────────────────────────── claiming ─────────────────────────────

    function test_Redeem_PaysAMaturedRequest() public {
        uint256 shares = 400e6 * SHARE_UNIT;
        _request(lp, shares);
        vm.warp(T0 + NOTICE);
        uint256 before = dollar.balanceOf(lp);

        vm.expectEmit(address(pool));
        emit IERC4626.Withdraw(lp, lp, lp, 400e6, shares);
        uint256 assets = _redeem(lp, shares);

        assertEq(assets, 400e6);
        assertEq(dollar.balanceOf(lp), before + 400e6);
        assertEq(pool.totalSupply(), SHARES - shares);
        assertEq(pool.totalAssets(), 600e6);
        assertEq(pool.balanceOf(address(pool)), 0);
        assertEq(pool.escrowedShares(), 0);
        assertEq(pool.activeAssets(), 600e6);

        (uint256 requested, uint256 assetsAtRequest, uint64 claimableAt) = _state(lp);
        assertEq(requested, 0);
        assertEq(assetsAtRequest, 0);
        assertEq(claimableAt, 0);
    }

    function test_Redeem_ToAnotherReceiver() public {
        _request(lp, 400e6 * SHARE_UNIT);
        vm.warp(T0 + NOTICE);

        vm.prank(lp);
        pool.redeem(400e6 * SHARE_UNIT, holder, lp);

        assertEq(dollar.balanceOf(holder), 400e6);
    }

    function test_Redeem_InPartsAndNeverTwice() public {
        _request(lp, 400e6 * SHARE_UNIT);
        vm.warp(T0 + NOTICE);

        assertEq(_redeem(lp, 100e6 * SHARE_UNIT), 100e6);
        (uint256 requested, uint256 assetsAtRequest, uint64 claimableAt) = _state(lp);
        assertEq(requested, 300e6 * SHARE_UNIT);
        assertEq(assetsAtRequest, 300e6);
        assertEq(claimableAt, T0 + NOTICE);
        assertEq(pool.maxRedeem(lp), 300e6 * SHARE_UNIT);

        assertEq(_redeem(lp, 300e6 * SHARE_UNIT), 300e6);
        assertEq(pool.escrowedShares(), 0);

        // Everything requested has been paid; the shares still held need a request of their own.
        vm.expectRevert(CoverPool.InsufficientRequest.selector);
        vm.prank(lp);
        pool.redeem(1, lp, lp);
        assertEq(pool.balanceOf(lp), 600e6 * SHARE_UNIT);
    }

    function test_Withdraw_PaysAssetsFromAMaturedRequest() public {
        _request(lp, 400e6 * SHARE_UNIT);
        vm.warp(T0 + NOTICE);
        uint256 before = dollar.balanceOf(lp);

        vm.expectEmit(address(pool));
        emit IERC4626.Withdraw(lp, lp, lp, 100e6, 100e6 * SHARE_UNIT);
        vm.prank(lp);
        uint256 shares = pool.withdraw(100e6, lp, lp);

        assertEq(shares, 100e6 * SHARE_UNIT);
        assertEq(dollar.balanceOf(lp), before + 100e6);
        (uint256 requested, uint256 assetsAtRequest,) = _state(lp);
        assertEq(requested, 300e6 * SHARE_UNIT);
        assertEq(assetsAtRequest, 300e6);
        assertEq(pool.maxWithdraw(lp), 300e6);
    }

    function test_Redeem_RevertWhen_TheNoticeIsNotOver() public {
        _request(lp, 400e6 * SHARE_UNIT);
        vm.warp(T0 + NOTICE - 1);

        vm.expectRevert(CoverPool.NoticeNotOver.selector);
        vm.prank(lp);
        pool.redeem(400e6 * SHARE_UNIT, lp, lp);

        vm.expectRevert(CoverPool.NoticeNotOver.selector);
        vm.prank(lp);
        pool.withdraw(1e6, lp, lp);
    }

    function test_Redeem_RevertWhen_CallerIsNotTheController() public {
        _request(lp, 400e6 * SHARE_UNIT);
        vm.prank(lp);
        pool.approve(relayer, type(uint256).max);
        vm.warp(T0 + NOTICE);

        // Not even an account the owner trusts with their shares can collect the claim.
        vm.expectRevert(CoverPool.NotController.selector);
        vm.prank(relayer);
        pool.redeem(400e6 * SHARE_UNIT, relayer, lp);

        vm.expectRevert(CoverPool.NotController.selector);
        vm.prank(attacker);
        pool.withdraw(1e6, attacker, lp);
    }

    function test_Redeem_RevertWhen_MoreThanRequested() public {
        _request(lp, 400e6 * SHARE_UNIT);
        vm.warp(T0 + NOTICE);

        vm.expectRevert(CoverPool.InsufficientRequest.selector);
        vm.prank(lp);
        pool.redeem(400e6 * SHARE_UNIT + 1, lp, lp);

        vm.expectRevert(CoverPool.InsufficientRequest.selector);
        vm.prank(lp);
        pool.withdraw(400e6 + 1, lp, lp);
    }

    function test_ThereIsNoInstantExit() public {
        vm.expectRevert(CoverPool.InsufficientRequest.selector);
        vm.prank(lp);
        pool.redeem(1, lp, lp);

        vm.expectRevert(CoverPool.InsufficientRequest.selector);
        vm.prank(lp);
        pool.withdraw(1, lp, lp);

        assertEq(pool.maxRedeem(lp), 0);
        assertEq(pool.maxWithdraw(lp), 0);
    }

    function test_FlashLiquidity_CannotLeaveInTheBlockItBackedCover() public {
        // Borrowed capital comes in, lifts the caps, a large policy is sold against it...
        _deposit(attacker, 10_000e6);
        _lock(KEY, 2_500e6);

        // ...and the capital asks to leave at once.
        uint256 shares = pool.balanceOf(attacker);
        _request(attacker, shares);

        vm.expectRevert(CoverPool.NoticeNotOver.selector);
        vm.prank(attacker);
        pool.redeem(shares, attacker, attacker);

        vm.expectRevert(CoverPool.NoticeNotOver.selector);
        vm.prank(attacker);
        pool.withdraw(1, attacker, attacker);

        assertEq(pool.maxWithdraw(attacker), 0);
        assertEq(dollar.balanceOf(address(pool)), 11_000e6);
    }

    function test_Redeem_ZeroIsHarmless() public {
        assertEq(_redeem(lp, 0), 0);
        vm.prank(lp);
        assertEq(pool.withdraw(0, lp, lp), 0);
        assertEq(pool.totalSupply(), SHARES);
        assertEq(pool.totalAssets(), DEPOSIT);
    }

    function test_EscrowedShares_CannotBeTransferred() public {
        _request(lp, 400e6 * SHARE_UNIT);

        vm.expectRevert(
            abi.encodeWithSelector(
                IERC20Errors.ERC20InsufficientBalance.selector, lp, 600e6 * SHARE_UNIT, 600e6 * SHARE_UNIT + 1
            )
        );
        vm.prank(lp);
        pool.transfer(lp2, 600e6 * SHARE_UNIT + 1);

        // The part that was not requested stays freely transferable and carries no claim with it.
        vm.prank(lp);
        pool.transfer(lp2, 600e6 * SHARE_UNIT);
        assertEq(pool.claimableRedeemRequest(0, lp2), 0);
        assertEq(pool.pendingRedeemRequest(0, lp2), 0);
    }

    // ───────────────────────────── cancelling ─────────────────────────────

    function test_CancelRedeemRequest_ReturnsTheShares() public {
        _request(lp, 400e6 * SHARE_UNIT);

        vm.expectEmit(address(pool));
        emit CoverPool.RedeemRequestCancelled(lp, 400e6 * SHARE_UNIT);
        vm.prank(lp);
        uint256 returned = pool.cancelRedeemRequest();

        assertEq(returned, 400e6 * SHARE_UNIT);
        assertEq(pool.balanceOf(lp), SHARES);
        assertEq(pool.balanceOf(address(pool)), 0);
        assertEq(pool.escrowedShares(), 0);
        assertEq(pool.activeAssets(), DEPOSIT);
        (uint256 requested, uint256 assetsAtRequest, uint64 claimableAt) = _state(lp);
        assertEq(requested + assetsAtRequest + claimableAt, 0);
    }

    function test_CancelRedeemRequest_AMaturedRequestCanBeCancelledAndMustThenStartOver() public {
        _request(lp, 400e6 * SHARE_UNIT);
        vm.warp(T0 + NOTICE);
        vm.prank(lp);
        pool.cancelRedeemRequest();

        vm.expectRevert(CoverPool.InsufficientRequest.selector);
        vm.prank(lp);
        pool.redeem(1, lp, lp);

        _request(lp, 400e6 * SHARE_UNIT);
        assertEq(pool.claimableRedeemRequest(0, lp), 0);
        (,, uint64 claimableAt) = _state(lp);
        assertEq(claimableAt, T0 + NOTICE + NOTICE);
    }

    function test_CancelRedeemRequest_RevertWhen_NothingIsRequested() public {
        vm.expectRevert(CoverPool.NoRedeemRequest.selector);
        vm.prank(lp);
        pool.cancelRedeemRequest();
    }

    // ───────────────────────────── retiring capital and the caps ─────────────────────────────

    function test_Caps_ShrinkWhileCapitalIsRetiring() public {
        _request(lp, SHARES / 2);
        assertEq(pool.activeAssets(), 500e6);

        // A quarter of the active half, not of the whole pool.
        _lock(KEY, 125e6);
        vm.expectRevert(CoverPool.CellCapExceeded.selector);
        vm.prank(book);
        pool.lock(KEY, 1);

        vm.prank(owner);
        pool.setMaxCellBps(10_000);
        _lock(OTHER_KEY, 275e6);
        vm.expectRevert(CoverPool.GlobalCapExceeded.selector);
        vm.prank(book);
        pool.lock(OTHER_KEY, 1);

        // Capital that stays after all counts again.
        vm.prank(lp);
        pool.cancelRedeemRequest();
        _lock(OTHER_KEY, 400e6);
        assertEq(pool.lockedExposure(), 800e6);
    }

    function test_Caps_AMaturedRequestStillBacksNothingNew() public {
        _request(lp, SHARES);
        vm.warp(T0 + NOTICE);
        assertEq(pool.activeAssets(), 0);

        // Capital that can walk out at any moment cannot be sold against.
        vm.expectRevert(CoverPool.GlobalCapExceeded.selector);
        vm.prank(book);
        pool.lock(KEY, 1);
    }

    function test_ActiveAssets_FollowsDepositsRequestsAndClaims() public {
        _deposit(lp2, 500e6);
        assertEq(pool.activeAssets(), 1_500e6);

        _request(lp2, 200e6 * SHARE_UNIT);
        assertEq(pool.activeAssets(), 1_300e6);

        vm.warp(T0 + NOTICE);
        _redeem(lp2, 200e6 * SHARE_UNIT);
        assertEq(pool.activeAssets(), 1_300e6);
        assertEq(pool.totalAssets(), 1_300e6);
    }

    // ───────────────────────────── free assets ─────────────────────────────

    function test_Redeem_AMaturedRequestIsStillLimitedByFreeAssets() public {
        _lock(KEY, 250e6);
        _lock(OTHER_KEY, 250e6);
        _request(lp, SHARES);
        vm.warp(T0 + NOTICE);

        assertEq(pool.freeAssets(), 500e6);
        assertEq(pool.claimableRedeemRequest(0, lp), SHARES);
        assertEq(pool.maxWithdraw(lp), 500e6);
        assertEq(pool.maxRedeem(lp), SHARES / 2);

        vm.expectRevert(CoverPool.ExposureLocked.selector);
        vm.prank(lp);
        pool.redeem(SHARES, lp, lp);

        vm.expectRevert(CoverPool.ExposureLocked.selector);
        vm.prank(lp);
        pool.withdraw(500e6 + 1, lp, lp);

        assertEq(_redeem(lp, SHARES / 2), 500e6);
        assertEq(pool.freeAssets(), 0);
        assertEq(pool.maxWithdraw(lp), 0);
        assertEq(pool.maxRedeem(lp), 0);
        assertGe(dollar.balanceOf(address(pool)), pool.lockedExposure());

        // The rest follows once the policies it backs are over.
        vm.prank(book);
        pool.release(KEY, 250e6);
        assertApproxEqAbs(pool.maxWithdraw(lp), 250e6, 1);
        uint256 half = pool.maxRedeem(lp);
        assertApproxEqAbs(_redeem(lp, half), 250e6, 1);
    }

    // ───────────────────────────── what a retiring provider is owed ─────────────────────────────

    function test_Redeem_BearsLossesUntilTheClaim() public {
        _lock(KEY, 100e6);
        _request(lp, 400e6 * SHARE_UNIT);

        // A payout during the notice period lands on the retiring shares like on any others.
        _loss(100e6);
        vm.warp(T0 + NOTICE);

        assertApproxEqAbs(pool.maxWithdraw(lp), 360e6, 1);
        uint256 assets = _redeem(lp, 400e6 * SHARE_UNIT);
        assertApproxEqAbs(assets, 360e6, 1);
        assertLe(assets, 360e6);
    }

    function test_Redeem_DoesNotEarnAfterTheRequest() public {
        _request(lp, 400e6 * SHARE_UNIT);

        // A premium that arrives during the notice period is for cover the retiring capital does not back.
        _donate(100e6);
        vm.warp(T0 + NOTICE);

        assertEq(pool.maxWithdraw(lp), 400e6);
        assertEq(_redeem(lp, 400e6 * SHARE_UNIT), 400e6);

        // It stays with the providers who remain.
        assertEq(pool.totalAssets(), 700e6);
        assertApproxEqAbs(pool.convertToAssets(pool.balanceOf(lp)), 700e6, 2);
    }

    function test_Redeem_AGainDoesNotMakeUpForALoss() public {
        _lock(KEY, 100e6);
        _request(lp, 400e6 * SHARE_UNIT);
        _loss(100e6);
        _donate(300e6);
        vm.warp(T0 + NOTICE);

        // Worth 480 at today's price, owed no more than the 400 it was worth when it asked to leave.
        assertEq(_redeem(lp, 400e6 * SHARE_UNIT), 400e6);
    }

    function test_RequestRedeem_AddingRemarksTheWholeRequestAtTheCurrentPrice() public {
        _request(lp, 400e6 * SHARE_UNIT);
        _donate(100e6);
        vm.warp(T0 + 1 hours);

        _request(lp, 1);

        (uint256 requested, uint256 assetsAtRequest, uint64 claimableAt) = _state(lp);
        assertEq(requested, 400e6 * SHARE_UNIT + 1);
        assertApproxEqAbs(assetsAtRequest, 440e6, 1);
        assertEq(claimableAt, T0 + 1 hours + NOTICE);
    }

    function test_Redeem_ADonationAroundARequestCannotBeTakenBackOut() public {
        _deposit(attacker, 1_000e6);
        uint256 shares = pool.balanceOf(attacker);
        _request(attacker, shares);
        _donate(5_000e6);
        vm.warp(T0 + NOTICE);

        vm.prank(attacker);
        uint256 assets = pool.redeem(shares, attacker, attacker);

        assertEq(assets, 1_000e6);
        assertApproxEqAbs(pool.convertToAssets(pool.balanceOf(lp)), 6_000e6, 10);
    }

    function test_Redeem_DustRoundsInThePoolsFavour() public {
        // Three shares are worth 0.000003 of a base unit.
        _request(lp, 3);
        vm.warp(T0 + NOTICE);
        assertEq(pool.maxWithdraw(lp), 0);

        vm.expectRevert(CoverPool.InsufficientRequest.selector);
        vm.prank(lp);
        pool.withdraw(1, lp, lp);

        assertEq(_redeem(lp, 3), 0);
        assertEq(pool.totalAssets(), DEPOSIT);
        assertEq(pool.totalSupply(), SHARES - 3);
    }

    function testFuzz_Claim_NeverPaysMoreThanEitherValuationNorDilutesTheRest(
        uint256 other,
        uint256 requested,
        uint256 gain,
        uint256 loss,
        uint256 firstPart
    ) public {
        other = bound(other, 1, 1_000_000e6);
        _deposit(lp2, other);
        requested = bound(requested, 1, SHARES);
        loss = bound(loss, 0, (DEPOSIT + other) / 5);
        gain = bound(gain, 0, 10_000e6);
        firstPart = bound(firstPart, 0, requested);

        _lock(KEY, loss);
        _request(lp, requested);
        (, uint256 assetsAtRequest,) = _state(lp);
        _donate(gain);
        _loss(loss);
        vm.warp(T0 + NOTICE);

        uint256 restBefore = pool.convertToAssets(pool.balanceOf(lp2));
        uint256 fair = pool.convertToAssets(firstPart);
        uint256 first = _redeem(lp, firstPart);
        assertLe(first, fair, "paid above today's value");

        fair = pool.convertToAssets(requested - firstPart);
        uint256 second = _redeem(lp, requested - firstPart);
        assertLe(second, fair, "paid above today's value");

        assertLe(first + second, assetsAtRequest, "paid above the value at request");
        assertGe(pool.convertToAssets(pool.balanceOf(lp2)), restBefore, "the remaining provider was diluted");
        assertEq(pool.escrowedShares(), 0);
        assertEq(pool.balanceOf(address(pool)), 0);
        assertGe(dollar.balanceOf(address(pool)), pool.lockedExposure());
    }

    function testFuzz_Limits_AreClaimableAndNeverExceedFreeAssets(uint256 locked, uint256 requested, uint256 gain)
        public
    {
        vm.prank(owner);
        pool.setMaxCellBps(10_000);
        locked = bound(locked, 0, DEPOSIT * 8 / 10);
        requested = bound(requested, 1, SHARES);
        gain = bound(gain, 0, 1_000e6);

        _lock(KEY, locked);
        _request(lp, requested);
        _donate(gain);
        vm.warp(T0 + NOTICE);

        uint256 free = pool.freeAssets();
        uint256 maxAssets = pool.maxWithdraw(lp);
        uint256 maxShares = pool.maxRedeem(lp);
        assertLe(maxAssets, free);
        assertLe(maxShares, requested);

        uint256 snapshot = vm.snapshotState();
        assertLe(_redeem(lp, maxShares), free);
        assertGe(dollar.balanceOf(address(pool)), pool.lockedExposure());
        vm.revertToState(snapshot);

        vm.prank(lp);
        pool.withdraw(maxAssets, lp, lp);
        assertGe(dollar.balanceOf(address(pool)), pool.lockedExposure());
        vm.revertToState(snapshot);

        vm.expectRevert();
        vm.prank(lp);
        pool.withdraw(maxAssets + 1, lp, lp);
    }

    // ───────────────────────────── interface and administration ─────────────────────────────

    function test_Previews_RevertForTheAsynchronousSide() public {
        vm.expectRevert(CoverPool.PreviewUnavailable.selector);
        pool.previewRedeem(1);

        vm.expectRevert(CoverPool.PreviewUnavailable.selector);
        pool.previewWithdraw(1);

        // Deposits stay synchronous.
        assertEq(pool.previewDeposit(1e6), 1e6 * SHARE_UNIT);
        assertEq(pool.previewMint(1e6 * SHARE_UNIT), 1e6);
    }

    function test_SupportsInterface() public view {
        assertEq(type(IERC7540Redeem).interfaceId, bytes4(0x620ee8e4));
        assertTrue(pool.supportsInterface(0x620ee8e4));
        assertTrue(pool.supportsInterface(type(IERC165).interfaceId));
        // Operators are not implemented.
        assertFalse(pool.supportsInterface(0xe3bc4e65));
        assertFalse(pool.supportsInterface(0xffffffff));
    }

    function test_SetRedeemNotice() public {
        _request(lp, 100e6 * SHARE_UNIT);

        vm.expectEmit(address(pool));
        emit CoverPool.RedeemNoticeSet(2 hours);
        vm.prank(owner);
        pool.setRedeemNotice(2 hours);
        assertEq(pool.redeemNotice(), 2 hours);

        // A request already made keeps the notice it was given.
        (,, uint64 claimableAt) = _state(lp);
        assertEq(claimableAt, T0 + NOTICE);

        _deposit(lp2, 100e6);
        _request(lp2, 100e6 * SHARE_UNIT);
        (,, claimableAt) = _state(lp2);
        assertEq(claimableAt, T0 + 2 hours);
    }

    function test_SetRedeemNotice_RevertWhen_OutOfBounds() public {
        vm.expectRevert(CoverPool.NoticeInvalid.selector);
        vm.prank(owner);
        pool.setRedeemNotice(59);

        vm.expectRevert(CoverPool.NoticeInvalid.selector);
        vm.prank(owner);
        pool.setRedeemNotice(7 days + 1);

        vm.startPrank(owner);
        pool.setRedeemNotice(1 minutes);
        pool.setRedeemNotice(7 days);
        vm.stopPrank();
    }

    function test_SetRedeemNotice_RevertWhen_CallerIsNotOwner() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, attacker));
        vm.prank(attacker);
        pool.setRedeemNotice(1 hours);
    }
}
