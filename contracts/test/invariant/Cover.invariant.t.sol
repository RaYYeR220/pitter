// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {CoverFixture} from "../utils/CoverFixture.sol";
import {CoverHandler} from "./CoverHandler.sol";

contract CoverInvariantTest is CoverFixture {
    CoverHandler internal handler;

    function setUp() public override {
        super.setUp();
        // Policies large enough to run into the pool's caps, and a grace period short enough to be reached.
        vm.startPrank(owner);
        book.setMaxPolicyPayout(20_000e6);
        book.setExpiryGrace(1 hours);
        vm.stopPrank();

        handler = new CoverHandler(dollar, index, pool, book, owner, underwriterKey, reporterKey);
        targetContract(address(handler));

        bytes4[] memory selectors = new bytes4[](17);
        selectors[0] = CoverHandler.warp.selector;
        selectors[1] = CoverHandler.warpFar.selector;
        selectors[2] = CoverHandler.heartbeat.selector;
        selectors[3] = CoverHandler.report.selector;
        selectors[4] = CoverHandler.forgeReport.selector;
        selectors[5] = CoverHandler.buy.selector;
        selectors[6] = CoverHandler.replay.selector;
        selectors[7] = CoverHandler.settle.selector;
        selectors[8] = CoverHandler.settleMany.selector;
        selectors[9] = CoverHandler.expire.selector;
        selectors[10] = CoverHandler.deposit.selector;
        selectors[11] = CoverHandler.withdraw.selector;
        selectors[12] = CoverHandler.redeem.selector;
        selectors[13] = CoverHandler.withdrawTooMuch.selector;
        selectors[14] = CoverHandler.donate.selector;
        selectors[15] = CoverHandler.setBlocked.selector;
        selectors[16] = CoverHandler.claimDeferred.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    // ───────────────────────────── invariants ─────────────────────────────

    /// The pool reserves exactly the remaining maximum payout of every open policy, globally and per cell,
    /// and the active-cell set is exactly the cells with an open policy.
    function invariant_ExposureMatchesOpenPolicies() public view {
        _checkExposure();
    }

    /// Reserved exposure and deferred payouts are always covered by tokens the pool holds.
    function invariant_PoolHoldsWhatItOwes() public view {
        _checkSolvency();
    }

    /// A policy is never paid more than its maximum, and exactly for the rain the index reported inside the
    /// part of its window that has been settled.
    function invariant_PayoutsFollowTheIndexAndTheMaximum() public view {
        _checkPolicies();
    }

    /// No liquidity provider can withdraw or redeem assets that back live exposure.
    function invariant_WithdrawalLimitsStayWithinFreeAssets() public view {
        _checkWithdrawalLimits();
    }

    /// A quote produces at most one policy.
    function invariant_QuotesAreUsableOnce() public view {
        assertEq(handler.replaysAccepted(), 0);
        assertEq(book.policyCount(), handler.bought());
    }

    /// Every settled amount reached its holder, as tokens or as a deferred payout waiting for them.
    function invariant_HoldersReceiveExactlyWhatWasSettled() public view {
        _checkHolderBalances();
    }

    /// Only reports signed by the reporter change the index.
    function invariant_ForgedReportsAreNeverAccepted() public view {
        assertEq(handler.forgeriesAccepted(), 0);
    }

    /// Every refusal was justified, every permitted action succeeded, and the caps held when exposure was
    /// locked.
    function invariant_NoUnexpectedBehaviour() public view {
        assertEq(handler.unexpectedReverts(), 0, "unexpected revert");
        assertEq(handler.unjustifiedRefusals(), 0, "sale refused without cause");
        assertEq(handler.capBreaches(), 0, "sale above a cap");
        assertEq(handler.earlyExpiries(), 0, "expired inside the grace period");
        assertEq(handler.overWithdrawals(), 0, "withdrew above the limit");
        assertEq(handler.claimableMismatches(), 0, "claimable differs from settle");
    }

    /// The book never keeps tokens between transactions.
    function invariant_BookHoldsNoFunds() public view {
        assertEq(dollar.balanceOf(address(book)), 0);
    }

    // ───────────────────────────── scenario ─────────────────────────────

    /// @dev A fixed walk through every handler action. It proves the handler reaches the interesting states
    /// (sales, refusals at the caps, payouts, deferrals, expiries) and that the invariants hold along the way.
    function test_Handler_ReachesEveryStateAndKeepsTheInvariants() public {
        // Four sales in one cell; the 25% cell cap of the 100k pool refuses those that no longer fit.
        for (uint256 i = 0; i < 4; ++i) {
            handler.buy(0, 0, 0, 29, type(uint256).max, 5e6, i % 2 == 0, true);
            _checkAll();
        }
        assertGt(handler.bought(), 0, "nothing sold");
        assertGt(handler.refused(), 0, "nothing refused");

        handler.replay(0, true);
        handler.replay(0, false);
        handler.forgeReport(0, 0);

        // Rain in the cell, a settlement to a holder who can receive and one to a holder who cannot.
        handler.warp(10 minutes);
        handler.report(0, 2, 0);
        handler.settle(0);
        assertGt(handler.paidTo(1), 0, "nothing paid");
        _checkAll();

        handler.setBlocked(0, true);
        handler.warp(10 minutes);
        handler.report(0, 2, 0);
        handler.settleMany(0, 4);
        assertGt(handler.deferrals() + pool.totalDeferred(), 0, "nothing deferred");
        _checkAll();

        handler.setBlocked(0, false);
        handler.claimDeferred(0);
        assertEq(pool.totalDeferred(), 0);
        _checkAll();

        // Liquidity moves around the locked exposure.
        handler.deposit(0, 100_000e6, true);
        handler.deposit(1, 100_000e6, false);
        handler.withdrawTooMuch(0, 1);
        handler.withdraw(0, type(uint256).max);
        handler.redeem(1, type(uint256).max);
        handler.donate(50e6);
        _checkAll();

        // The oracle goes silent; the open policies are expired after the grace period.
        handler.expire(0);
        handler.warpFar(3 hours);
        handler.buy(1, 1, 0, 9, 1e4, 1e6, false, false);
        for (uint256 i = 0; i < book.policyCount(); ++i) {
            handler.expire(i);
        }
        assertGt(handler.expiries(), 0, "nothing expired");
        assertEq(pool.lockedExposure(), 0);
        _checkAll();
    }

    // ───────────────────────────── checks ─────────────────────────────

    function _checkAll() internal view {
        _checkExposure();
        _checkSolvency();
        _checkPolicies();
        _checkWithdrawalLimits();
        _checkHolderBalances();
        invariant_QuotesAreUsableOnce();
        invariant_ForgedReportsAreNeverAccepted();
        invariant_NoUnexpectedBehaviour();
        invariant_BookHoldsNoFunds();
    }

    function _checkExposure() internal view {
        uint256 keyCount = handler.keyCount();
        uint256[] memory openExposure = new uint256[](keyCount);
        uint256[] memory openCount = new uint256[](keyCount);
        uint256 totalOpen;

        uint256 count = book.policyCount();
        for (uint256 id = 1; id <= count; ++id) {
            PolicyView memory p = _policy(id);
            if (p.closed) continue;
            uint256 k = _keyIndex(p.key);
            openExposure[k] += p.maxPayout - p.paid;
            openCount[k] += 1;
            totalOpen += p.maxPayout - p.paid;
        }

        assertEq(pool.lockedExposure(), totalOpen, "locked exposure drifted from the open policies");
        uint256 activeExpected;
        for (uint256 k = 0; k < keyCount; ++k) {
            uint256 key = handler.keys(k);
            assertEq(pool.cellExposure(key), openExposure[k], "cell exposure drifted");
            assertEq(book.openPolicies(key), openCount[k], "open policy count drifted");
            if (openCount[k] != 0) ++activeExpected;
        }

        uint256[] memory active = book.activeCells();
        assertEq(active.length, activeExpected, "active cell set has the wrong size");
        for (uint256 i = 0; i < active.length; ++i) {
            assertGt(openCount[_keyIndex(active[i])], 0, "inactive cell listed as active");
        }
    }

    function _checkSolvency() internal view {
        uint256 balance = dollar.balanceOf(address(pool));
        assertGe(balance, pool.lockedExposure() + pool.totalDeferred(), "pool cannot cover what it owes");
        assertGe(pool.totalAssets(), pool.lockedExposure());
        assertEq(pool.freeAssets(), pool.totalAssets() - pool.lockedExposure());

        uint256 deferredSum;
        uint256 holderCount = handler.holderCount();
        for (uint256 i = 0; i < holderCount; ++i) {
            deferredSum += pool.deferred(handler.holders(i));
        }
        assertEq(pool.totalDeferred(), deferredSum, "deferred payouts drifted");
    }

    function _checkPolicies() internal view {
        uint256 count = book.policyCount();
        for (uint256 id = 1; id <= count; ++id) {
            PolicyView memory p = _policy(id);
            assertLe(p.paid, p.maxPayout, "paid above the maximum");
            assertEq(p.paid, handler.paidTo(id), "paid differs from the settlements made");
            assertGe(p.settledUntil, p.start);
            assertLe(p.settledUntil, p.end);
            if (p.settledUntil > p.start) {
                assertLe(p.settledUntil, index.lastTo(p.key), "settled past the reported time");
            }
            assertEq(
                p.paid,
                uint256(p.ratePerSecond) * index.wetSeconds(p.key, p.start, p.settledUntil),
                "paid differs from the reported rain"
            );
            if (p.closed && p.settledUntil < p.end) {
                assertGe(vm.getBlockTimestamp(), uint256(p.end) + book.expiryGrace(), "closed early");
            }
        }
    }

    function _checkWithdrawalLimits() internal view {
        uint256 free = pool.freeAssets();
        uint256 lpCount = handler.lpCount();
        for (uint256 i = 0; i < lpCount; ++i) {
            address provider = handler.lps(i);
            assertLe(pool.maxWithdraw(provider), free, "maxWithdraw above free assets");
            assertLe(pool.previewRedeem(pool.maxRedeem(provider)), free, "maxRedeem above free assets");
        }
        assertLe(pool.maxWithdraw(lp), free);
        assertLe(pool.previewRedeem(pool.maxRedeem(lp)), free);
    }

    function _checkHolderBalances() internal view {
        uint256 holderCount = handler.holderCount();
        for (uint256 i = 0; i < holderCount; ++i) {
            address account = handler.holders(i);
            assertEq(
                dollar.balanceOf(account) + pool.deferred(account) + handler.premiumsPaid(account),
                handler.HOLDER_FUNDS() + handler.payoutsOwed(account),
                "holder balance differs from premiums and payouts"
            );
        }
    }

    function _keyIndex(uint256 key) internal view returns (uint256) {
        uint256 keyCount = handler.keyCount();
        for (uint256 k = 0; k < keyCount; ++k) {
            if (handler.keys(k) == key) return k;
        }
        revert("policy on a key the handler does not use");
    }
}
