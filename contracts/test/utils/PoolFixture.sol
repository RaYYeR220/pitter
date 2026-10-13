// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {CoverPool} from "../../src/CoverPool.sol";
import {BlockableDollar} from "../mocks/BlockableDollar.sol";
import {BookStub} from "../mocks/BookStub.sol";
import {Signing} from "./Signing.sol";

/// @dev The pool on its own, with a stand-in contract as the book and funded liquidity providers.
abstract contract PoolFixture is Signing {
    BlockableDollar internal dollar;
    CoverPool internal pool;

    address internal owner = makeAddr("owner");
    address internal book;
    address internal relayer = makeAddr("relayer");
    address internal holder = makeAddr("holder");
    address internal attacker = makeAddr("attacker");
    address internal treasury = makeAddr("treasury");
    address internal lp;
    uint256 internal lpKey;
    address internal lp2 = makeAddr("lp2");

    uint256 internal constant KEY = (uint256(1) << 64) | 7;
    uint256 internal constant OTHER_KEY = (uint256(1) << 64) | 8;
    uint256 internal constant SHARE_UNIT = 1e6;
    uint64 internal constant T0 = 1_760_000_400;

    function setUp() public virtual {
        vm.warp(T0);
        (lp, lpKey) = makeAddrAndKey("lp");
        book = address(new BookStub());
        vm.label(book, "book");
        dollar = new BlockableDollar(owner);
        pool = new CoverPool(dollar, owner, treasury, "Cover Pool Share", "cvUSD");
        vm.prank(owner);
        pool.setBook(book);

        vm.startPrank(owner);
        dollar.mint(lp, 1_000_000e6);
        dollar.mint(lp2, 1_000_000e6);
        dollar.mint(attacker, 1_000_000e6);
        vm.stopPrank();
        vm.prank(lp);
        dollar.approve(address(pool), type(uint256).max);
        vm.prank(lp2);
        dollar.approve(address(pool), type(uint256).max);
        vm.prank(attacker);
        dollar.approve(address(pool), type(uint256).max);
    }

    function _now() internal view returns (uint64) {
        return uint64(vm.getBlockTimestamp());
    }

    function _deposit(address from, uint256 assets) internal returns (uint256 shares) {
        vm.prank(from);
        return pool.deposit(assets, from);
    }

    function _lock(uint256 key, uint256 amount) internal {
        vm.prank(book);
        pool.lock(key, amount);
    }
}
