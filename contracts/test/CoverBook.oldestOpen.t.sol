// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {CoverFixture} from "./utils/CoverFixture.sol";

/// @dev The book's low-water mark of open cover: every policy below `oldestOpenId` is closed.
contract CoverBookOldestOpenTest is CoverFixture {
    function _buyOn(uint256 key) internal returns (uint256) {
        return _buy(_quote(holder, key, _now(), _now() + 10 minutes, RATE, PREMIUM));
    }

    function _closeAll(uint256 key, uint256[] memory ids) internal {
        PolicyView memory p = _policy(ids[0]);
        if (index.lastTo(key) < p.end) {
            vm.warp(p.end);
            _report(key, p.start, p.end, 0);
        }
        vm.prank(keeper);
        book.settleMany(ids);
    }

    function _one(uint256 id) internal pure returns (uint256[] memory ids) {
        ids = new uint256[](1);
        ids[0] = id;
    }

    function test_OldestOpenId_IsOnePastTheLastPolicyWhileNoneIsOpen() public {
        assertEq(book.oldestOpenId(), 1);

        uint256 id = _buyOn(KEY);
        assertEq(book.oldestOpenId(), id);

        _closeAll(KEY, _one(id));
        assertEq(book.oldestOpenId(), book.policyCount() + 1);

        // The next sale is the oldest open one again.
        _heartbeat();
        assertEq(book.oldestOpenId(), _buyOn(KEY));
    }

    function test_OldestOpenId_WaitsForTheOldestPolicyToClose() public {
        uint256 first = _buyOn(KEY);
        uint256 second = _buyOn(OTHER_KEY);

        // The younger policy closes first: older cover is still open.
        _closeAll(OTHER_KEY, _one(second));
        assertTrue(_policy(second).closed);
        assertEq(book.oldestOpenId(), first);

        // The older one closes and the mark moves past both.
        _closeAll(KEY, _one(first));
        assertEq(book.oldestOpenId(), 3);
    }

    function test_OldestOpenId_FollowsAnExpiry() public {
        uint256 id = _buyOn(KEY);
        vm.warp(_policy(id).end + book.expiryGrace());
        book.expire(id);
        assertEq(book.oldestOpenId(), 2);
    }

    function test_OldestOpenId_MovesAtMostThirtyTwoPoliciesPerCloseAndAnyoneCanCatchItUp() public {
        uint256 first = _buyOn(KEY);
        uint256[] memory younger = new uint256[](39);
        for (uint256 i = 0; i < younger.length; ++i) {
            younger[i] = _buyOn(OTHER_KEY);
        }
        _closeAll(OTHER_KEY, younger);
        assertEq(book.oldestOpenId(), first);

        // Closing the oldest walks the mark forward over at most 32 closed policies.
        _closeAll(KEY, _one(first));
        assertEq(book.oldestOpenId(), 33);

        // Anyone can walk it the rest of the way, in steps of their choosing.
        vm.prank(attacker);
        assertEq(book.syncOldestOpen(3), 36);
        assertEq(book.syncOldestOpen(0), 36);
        assertEq(book.syncOldestOpen(100), 41);
        assertEq(book.oldestOpenId(), book.policyCount() + 1);
    }

    function test_SyncOldestOpen_StopsAtAnOpenPolicy() public {
        uint256 first = _buyOn(KEY);
        _buyOn(OTHER_KEY);
        assertEq(book.syncOldestOpen(10), first);

        _closeAll(KEY, _one(first));
        assertEq(book.syncOldestOpen(10), 2);
        assertEq(book.oldestOpenId(), 2);
    }

    /// @dev Whatever the order in which policies close, every policy below the mark is closed, and the mark is
    /// exactly the oldest open policy once it has been caught up.
    function testFuzz_OldestOpenId_IsALowerBoundOnTheOpenPolicies(uint256 orderSeed, uint8 countSeed) public {
        uint256 count = 1 + uint256(countSeed) % 12;
        uint256[] memory ids = new uint256[](count);
        uint256 keyBase = OTHER_KEY + 100;
        for (uint256 i = 0; i < count; ++i) {
            ids[i] = _buyOn(keyBase + i);
        }

        vm.warp(_now() + 10 minutes);
        for (uint256 i = 0; i < count; ++i) {
            // Close a seed-chosen subset, in a seed-chosen order.
            uint256 pick = uint256(keccak256(abi.encode(orderSeed, i))) % count;
            if (_policy(ids[pick]).closed || (orderSeed >> i) & 1 == 0) continue;
            PolicyView memory p = _policy(ids[pick]);
            _report(p.key, p.start, p.end, 0);
            book.settle(ids[pick]);

            uint256 mark = book.oldestOpenId();
            for (uint256 id = 1; id < mark; ++id) {
                assertTrue(_policy(id).closed, "an open policy lies below the mark");
            }
        }

        uint256 synced = book.syncOldestOpen(type(uint256).max);
        for (uint256 id = 1; id < synced; ++id) {
            assertTrue(_policy(id).closed);
        }
        assertTrue(synced == book.policyCount() + 1 || !_policy(synced).closed, "the mark lags after a sync");
    }
}
