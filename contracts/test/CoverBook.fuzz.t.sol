// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {CoverBook} from "../src/CoverBook.sol";
import {Quote} from "../src/Types.sol";
import {CoverFixture} from "./utils/CoverFixture.sol";

contract CoverBookFuzzTest is CoverFixture {
    struct Segment {
        uint64 from;
        uint64 to;
        uint32 wet;
    }

    Segment[] internal segments;

    /// @dev Buys one policy on KEY starting a minute from now.
    function _open(uint128 rate, uint64 duration) internal returns (uint256 id, Quote memory q) {
        q = _quote(holder, KEY, _now() + 60, _now() + 60 + duration, rate, PREMIUM);
        id = _buy(q);
    }

    /// @dev Drives the oracle through and past the policy's window with seed-chosen gaps, overlaps and
    /// wetness, optionally settling after some of the reports, then settles once the window is fully reported.
    function _play(uint256 seed, uint256 id, Quote memory q, bool settleAlongTheWay) internal returns (uint256 total) {
        uint64 duration = q.end - q.start;
        uint64 cursor;
        for (uint256 i = 0; i < 16 && cursor < q.end; ++i) {
            seed = uint256(keccak256(abi.encode(seed, i)));
            uint64 nowTs = _now() + uint64(1 + seed % (duration / 4 + 60));
            vm.warp(nowTs);

            uint64 from;
            if (cursor == 0) {
                from = nowTs - uint64(1 + (seed >> 16) % 300);
            } else if ((seed >> 8) % 5 == 0) {
                from = cursor + uint64((seed >> 16) % (nowTs - cursor));
            } else if ((seed >> 8) % 5 == 1) {
                from = cursor - uint64((seed >> 16) % 120);
            } else {
                from = cursor;
            }
            cursor = _reportSegment(seed, cursor, from, nowTs);

            if (settleAlongTheWay && (seed >> 96) % 3 != 0) {
                vm.prank(keeper);
                total += book.settle(id);
            }
        }
        if (cursor < q.end) {
            vm.warp(q.end + 1 + seed % 300);
            _reportSegment(seed >> 3, cursor, cursor == 0 ? q.end - 30 : cursor, _now());
        }
        vm.prank(keeper);
        total += book.settle(id);
    }

    function _reportSegment(uint256 seed, uint64 cursor, uint64 from, uint64 to) internal returns (uint64) {
        uint64 effectiveFrom = (cursor == 0 || from > cursor) ? from : cursor;
        uint64 span = to - effectiveFrom;
        uint256 mode = (seed >> 40) % 4;
        uint32 wet = mode == 0 ? 0 : mode == 1 ? uint32(span) : uint32((seed >> 48) % (span + 1));

        _report(KEY, from, to, wet);
        segments.push(Segment(effectiveFrom, to, wet));
        return to;
    }

    /// @dev Exact wet time reported inside `[a, b]`, scaled by 1e18. Each term truncates by less than one unit.
    function _referenceWet(uint64 a, uint64 b) internal view returns (uint256 scaled) {
        uint256 n = segments.length;
        for (uint256 i = 0; i < n; ++i) {
            Segment memory seg = segments[i];
            uint64 lo = seg.from > a ? seg.from : a;
            uint64 hi = seg.to < b ? seg.to : b;
            if (hi > lo) scaled += uint256(seg.wet) * (hi - lo) * 1e18 / (seg.to - seg.from);
        }
    }

    function testFuzz_Payout_NeverExceedsTheMaximumOrTheReportedRain(
        uint256 seed,
        uint128 rate,
        uint8 minutes_,
        bool settleAlongTheWay
    ) public {
        uint64 duration = uint64(bound(minutes_, 1, 60)) * 60;
        rate = uint128(bound(rate, 1, MAX_POLICY_PAYOUT / duration));
        (uint256 id, Quote memory q) = _open(rate, duration);
        uint256 maxPayout = uint256(rate) * duration;
        uint256 holderBefore = dollar.balanceOf(holder);

        uint256 total = _play(seed, id, q, settleAlongTheWay);

        PolicyView memory p = _policy(id);
        assertTrue(p.closed, "fully reported window closes the policy");
        assertEq(p.paid, total);
        assertEq(dollar.balanceOf(holder) - holderBefore, total);
        assertLe(total, maxPayout, "paid more than the maximum");
        assertEq(pool.lockedExposure(), 0, "exposure left behind");
        assertEq(pool.cellExposure(KEY), 0);

        // Whole wet seconds only, never more than was reported inside the window, and less than two seconds
        // below it.
        assertEq(total % rate, 0);
        uint256 paidSeconds = total / rate * 1e18;
        uint256 reported = _referenceWet(q.start, q.end);
        assertLe(paidSeconds, reported + segments.length, "paid for rain that was not reported");
        assertGt(paidSeconds + 2e18, reported, "lost two seconds or more to rounding");
    }

    function testFuzz_Payout_DoesNotDependOnWhenSettlementsHappen(uint256 seed, uint128 rate, uint8 minutes_) public {
        uint64 duration = uint64(bound(minutes_, 1, 60)) * 60;
        rate = uint128(bound(rate, 1, MAX_POLICY_PAYOUT / duration));
        (uint256 id, Quote memory q) = _open(rate, duration);

        uint256 snapshot = vm.snapshotState();
        uint256 settledOften = _play(seed, id, q, true);
        vm.revertToState(snapshot);
        uint256 settledOnce = _play(seed, id, q, false);

        assertEq(settledOften, settledOnce);
    }

    function testFuzz_Payout_OpenPolicyExposureAlwaysMatchesThePool(uint256 seed, uint128 rate, uint8 minutes_)
        public
    {
        uint64 duration = uint64(bound(minutes_, 2, 60)) * 60;
        rate = uint128(bound(rate, 1, MAX_POLICY_PAYOUT / duration));
        (uint256 id, Quote memory q) = _open(rate, duration);
        uint256 maxPayout = uint256(rate) * duration;

        // Report and settle the first part of the window only.
        uint64 half = q.start + duration / 2;
        vm.warp(half);
        uint32 wet = uint32(bound(seed, 0, duration / 2));
        _report(KEY, q.start, half, wet);
        uint256 paid = book.settle(id);

        assertEq(paid, uint256(wet) * rate);
        assertEq(pool.lockedExposure(), maxPayout - paid);
        assertEq(pool.cellExposure(KEY), maxPayout - paid);
        assertFalse(_policy(id).closed);
        assertGe(dollar.balanceOf(address(pool)), pool.lockedExposure());

        // The oracle goes silent: expiry returns the rest.
        vm.warp(q.end + book.expiryGrace());
        book.expire(id);
        assertEq(pool.lockedExposure(), 0);
        assertEq(_policy(id).paid, paid);
    }

    function testFuzz_Premium_IsSplitExactlyAndTheFeeRoundsDown(uint128 premium, uint16 feeBps) public {
        premium = uint128(bound(premium, 0, HOLDER_FUNDS));
        feeBps = uint16(bound(feeBps, 0, book.MAX_FEE_BPS()));
        vm.prank(owner);
        book.setFeeBps(feeBps);

        _buy(_quote(holder, KEY, _now(), _now() + 10 minutes, RATE, premium));

        uint256 fee = dollar.balanceOf(treasury);
        uint256 net = dollar.balanceOf(address(pool)) - POOL_DEPOSIT;
        assertEq(fee + net, premium);
        assertEq(fee, uint256(premium) * feeBps / 10_000);
        assertEq(dollar.balanceOf(address(book)), 0);
        assertEq(dollar.balanceOf(holder), HOLDER_FUNDS - premium);
    }

    function testFuzz_Quote_IsUsableExactlyOnce(uint128 rate, uint8 minutes_, bytes32 salt, bool firstByAuthorization, bool secondByAuthorization)
        public
    {
        uint64 duration = uint64(bound(minutes_, 1, 720)) * 60;
        rate = uint128(bound(rate, 0, MAX_POLICY_PAYOUT / duration));
        Quote memory q = _quote(holder, KEY, _now() + 60, _now() + 60 + duration, rate, PREMIUM);
        q.salt = salt;
        bytes memory signature = _signQuote(q);
        (Authorization memory a, uint8 v, bytes32 r, bytes32 s) = _premiumAuthorization(q, holderKey);

        if (firstByAuthorization) {
            vm.prank(relayer);
            book.buyWithAuthorization(q, signature, a.validAfter, a.validBefore, v, r, s);
        } else {
            vm.prank(holder);
            book.buy(q, signature);
        }
        assertEq(book.policyCount(), 1);
        assertTrue(book.quoteUsed(a.nonce));

        vm.expectRevert(CoverBook.QuoteUsed.selector);
        if (secondByAuthorization) {
            vm.prank(relayer);
            book.buyWithAuthorization(q, signature, a.validAfter, a.validBefore, v, r, s);
        } else {
            vm.prank(holder);
            book.buy(q, signature);
        }
        assertEq(book.policyCount(), 1);
        assertEq(dollar.balanceOf(holder), HOLDER_FUNDS - PREMIUM);
    }
}
