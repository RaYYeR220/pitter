// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {CoverBook} from "../src/CoverBook.sol";
import {Quote, Reading} from "../src/Types.sol";
import {CoverFixture} from "./utils/CoverFixture.sol";

/// @dev Served areas: the owner names the keys the product sells, and with `servedOnly` on nothing else can be
/// bought, so the active-cell cap can never shut out an area the product serves.
contract CoverBookServedTest is CoverFixture {
    uint256 internal constant AREA_BASE = (uint256(1) << 64) | (uint256(5000) << 32);

    function _keys(uint256 base, uint256 count) internal pure returns (uint256[] memory keys) {
        keys = new uint256[](count);
        for (uint256 i = 0; i < count; ++i) {
            keys[i] = base + i;
        }
    }

    function _serve(uint256[] memory keys) internal {
        vm.startPrank(owner);
        book.setServed(keys, true);
        book.setServedOnly(true);
        vm.stopPrank();
    }

    function _expectBuyRevert(Quote memory q, bytes4 selector) internal {
        bytes memory signature = _signQuote(q);
        vm.expectRevert(selector);
        vm.prank(q.holder);
        book.buy(q, signature);
    }

    function test_ServedOnly_IsOffByDefault() public {
        assertFalse(book.servedOnly());
        assertFalse(book.isServed(KEY));
        assertEq(book.servedKeys().length, 0);
        assertEq(_buy(_standardQuote(0)), 1);
    }

    function test_SetServed_AddsAndRemovesKeys() public {
        uint256[] memory keys = _keys(AREA_BASE, 2);

        vm.expectEmit(address(book));
        emit CoverBook.ServedSet(keys[0], true);
        vm.expectEmit(address(book));
        emit CoverBook.ServedSet(keys[1], true);
        vm.prank(owner);
        book.setServed(keys, true);
        assertTrue(book.isServed(keys[0]));
        assertTrue(book.isServed(keys[1]));
        assertEq(book.servedKeys().length, 2);

        // Serving a key twice changes nothing.
        vm.prank(owner);
        book.setServed(keys, true);
        assertEq(book.servedKeys().length, 2);

        vm.expectEmit(address(book));
        emit CoverBook.ServedSet(keys[1], false);
        vm.prank(owner);
        book.setServed(_keys(keys[1], 1), false);
        assertFalse(book.isServed(keys[1]));
        assertEq(book.servedKeys().length, 1);
    }

    function test_SetServedOnly() public {
        vm.expectEmit(address(book));
        emit CoverBook.ServedOnlySet(true);
        vm.prank(owner);
        book.setServedOnly(true);
        assertTrue(book.servedOnly());
    }

    function test_SetServed_RevertWhen_CallerIsNotOwner() public {
        uint256[] memory keys = _keys(AREA_BASE, 1);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, attacker));
        vm.prank(attacker);
        book.setServed(keys, true);

        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, attacker));
        vm.prank(attacker);
        book.setServedOnly(true);
    }

    function test_Buy_RevertWhen_TheAreaIsNotServed() public {
        _serve(_keys(KEY, 1));

        Quote memory q = _quote(holder, OTHER_KEY, _now(), _now() + 10 minutes, RATE, PREMIUM);
        _expectBuyRevert(q, CoverBook.AreaNotServed.selector);

        // The same rule guards the gasless path.
        bytes memory signature = _signQuote(q);
        (Authorization memory a, uint8 v, bytes32 r, bytes32 s) = _premiumAuthorization(q, holderKey);
        vm.expectRevert(CoverBook.AreaNotServed.selector);
        vm.prank(relayer);
        book.buyWithAuthorization(q, signature, a.validAfter, a.validBefore, v, r, s);

        assertEq(_buy(_standardQuote(0)), 1);
    }

    function test_DustCannotShutOutAServedArea() public {
        // Sixty-four served cells and as many slots.
        uint256[] memory areas = _keys(AREA_BASE, 64);
        _serve(areas);
        vm.prank(attacker);
        dollar.approve(address(book), type(uint256).max);

        // A buyer takes every served cell for one base unit each, ending as late as the horizon allows...
        uint64 end = _now() + book.maxHorizon();
        for (uint256 i = 0; i < areas.length; ++i) {
            _buy(_quote(attacker, areas[i], end - 60, end, 1, 1));
        }
        assertEq(book.activeCells().length, 64);

        // ...and cannot reach beyond them.
        _expectBuyRevert(_quote(attacker, AREA_BASE + 64, end - 60, end, 1, 1), CoverBook.AreaNotServed.selector);

        // Every served cell keeps selling: an active cell needs no free slot.
        vm.warp(T0 + 12 hours);
        _heartbeat();
        for (uint256 i = 0; i < areas.length; i += 21) {
            _buy(_quote(holder, areas[i], _now() + 10 minutes, _now() + 20 minutes, RATE, PREMIUM));
        }
    }

    function test_ServedAreas_MayNotOutnumberTheActiveCellSlots() public {
        vm.startPrank(owner);
        book.setMaxActiveCells(2);
        book.setServed(_keys(AREA_BASE, 3), true);

        // Selling only in three areas with two slots would let two policies shut out the third.
        vm.expectRevert(CoverBook.ConfigInvalid.selector);
        book.setServedOnly(true);

        book.setServed(_keys(AREA_BASE + 2, 1), false);
        book.setServedOnly(true);

        vm.expectRevert(CoverBook.ConfigInvalid.selector);
        book.setServed(_keys(AREA_BASE + 2, 1), true);
        vm.expectRevert(CoverBook.ConfigInvalid.selector);
        book.setMaxActiveCells(1);

        // Without the rule, the set may be any size.
        book.setServedOnly(false);
        book.setServed(_keys(AREA_BASE + 2, 1), true);
        book.setMaxActiveCells(1);
        vm.stopPrank();
    }

    function test_AnAreaThatStopsBeingServedStillSettlesItsOpenCover() public {
        _serve(_keys(KEY, 1));
        Quote memory q = _standardQuote(60);
        uint256 id = _buy(q);

        vm.prank(owner);
        book.setServed(_keys(KEY, 1), false);
        _expectBuyRevert(_standardQuote(60), CoverBook.AreaNotServed.selector);

        vm.warp(q.end);
        _submitReport(_readings(Reading(KEY, q.start, q.end, 600)));
        assertEq(book.settle(id), uint256(RATE) * 600);
        assertTrue(_policy(id).closed);
    }
}
