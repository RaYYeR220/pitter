// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {CoverBook} from "../src/CoverBook.sol";
import {CoverPool} from "../src/CoverPool.sol";
import {Quote, Reading} from "../src/Types.sol";
import {WeatherIndex} from "../src/WeatherIndex.sol";
import {HookedDollar, ITransferHook} from "./mocks/HookedDollar.sol";
import {Signing} from "./utils/Signing.sol";

/// @dev Replays a prepared call the first time the hooked token notifies it of a transfer, and records the
/// outcome. With `propagate` set, a failed nested call makes the transfer itself fail.
contract Reenterer is ITransferHook {
    address public target;
    bytes public payload;
    bool public propagate;
    bool public attempted;
    bool public succeeded;
    bytes public failure;

    function arm(address target_, bytes calldata payload_, bool propagate_) external {
        target = target_;
        payload = payload_;
        propagate = propagate_;
        attempted = false;
        succeeded = false;
        failure = "";
    }

    function onTransfer(address, address, uint256) external {
        if (target == address(0) || attempted) return;
        attempted = true;
        (bool ok, bytes memory returned) = target.call(payload);
        succeeded = ok;
        failure = returned;
        if (!ok && propagate) {
            assembly ("memory-safe") {
                revert(add(returned, 0x20), mload(returned))
            }
        }
    }
}

/// @dev The dollar token has no transfer callbacks, but nothing here depends on that: with a token that does
/// call back, every attempt to re-enter a function that moves funds is refused.
contract ReentrancyTest is Signing {
    HookedDollar internal dollar;
    WeatherIndex internal index;
    CoverPool internal pool;
    CoverBook internal book;
    Reenterer internal reenterer;

    address internal owner = makeAddr("owner");
    address internal treasury = makeAddr("treasury");
    address internal lp = makeAddr("lp");
    uint256 internal underwriterKey;
    uint256 internal reporterKey;

    uint256 internal constant KEY = (uint256(1) << 64) | 7;
    uint64 internal constant T0 = 1_760_000_400;
    bytes4 internal constant REENTERED = bytes4(keccak256("ReentrancyGuardReentrantCall()"));

    function setUp() public {
        vm.warp(T0);
        address underwriter;
        address reporter;
        (underwriter, underwriterKey) = makeAddrAndKey("underwriter");
        (reporter, reporterKey) = makeAddrAndKey("reporter");

        dollar = new HookedDollar();
        index = new WeatherIndex(owner, reporter);
        pool = new CoverPool(dollar, owner, treasury, "Cover Pool Share", "cvUSD");
        book = new CoverBook(dollar, pool, index, underwriter, treasury, 0, 500e6, owner);
        vm.prank(owner);
        pool.setBook(address(book));
        reenterer = new Reenterer();

        dollar.mint(lp, 100_000e6);
        vm.startPrank(lp);
        dollar.approve(address(pool), type(uint256).max);
        pool.deposit(50_000e6, lp);
        vm.stopPrank();

        dollar.mint(address(reenterer), 1_000e6);
        vm.startPrank(address(reenterer));
        dollar.approve(address(book), type(uint256).max);
        dollar.approve(address(pool), type(uint256).max);
        vm.stopPrank();
        dollar.setHook(address(reenterer), address(reenterer));

        _report(new Reading[](0), T0);
    }

    function _report(Reading[] memory readings, uint64 issuedAt) internal {
        index.submit(_signedReport(reporterKey, index.DOMAIN_SEPARATOR(), readings, issuedAt));
    }

    function _quote(uint256 salt) internal view returns (Quote memory q, bytes memory signature) {
        q = Quote(address(reenterer), KEY, T0, T0 + 10 minutes, 1e4, 1e6, T0 + 5 minutes, bytes32(salt));
        signature = _signDigest(underwriterKey, _quoteDigest(book.DOMAIN_SEPARATOR(), q));
    }

    function _assertRefused() internal view {
        assertTrue(reenterer.attempted(), "the hook never fired");
        assertFalse(reenterer.succeeded(), "the nested call went through");
        assertEq(bytes4(reenterer.failure()), REENTERED);
    }

    /// @dev Leaves the reenterer holding a fully wet, fully reported policy that has not been settled.
    function _wetPolicy() internal returns (uint256 id) {
        (Quote memory q, bytes memory signature) = _quote(1);
        vm.prank(address(reenterer));
        id = book.buy(q, signature);
        vm.warp(q.end);
        _report(_readings(Reading(KEY, q.start, q.end, 600)), q.end);
    }

    function test_Rescue_CannotRunWhileAPurchaseIsInFlight() public {
        // The owner key sits behind the hooked account and tries to sweep the book mid-purchase.
        vm.prank(owner);
        book.transferOwnership(address(reenterer));
        vm.prank(address(reenterer));
        book.acceptOwnership();
        reenterer.arm(
            address(book), abi.encodeCall(CoverBook.rescue, (address(dollar), address(reenterer), 1e6)), false
        );

        (Quote memory q, bytes memory signature) = _quote(1);
        uint256 poolBefore = dollar.balanceOf(address(pool));
        vm.prank(address(reenterer));
        book.buy(q, signature);

        _assertRefused();
        assertEq(dollar.balanceOf(treasury), q.premium * 500 / 10_000);
        assertEq(dollar.balanceOf(address(pool)), poolBefore + q.premium - q.premium * 500 / 10_000);
        assertEq(dollar.balanceOf(address(book)), 0);
    }

    function test_Buy_CannotBeReenteredWhileThePremiumMoves() public {
        (Quote memory first, bytes memory firstSig) = _quote(1);
        (Quote memory second, bytes memory secondSig) = _quote(2);
        reenterer.arm(address(book), abi.encodeCall(CoverBook.buy, (second, secondSig)), false);

        vm.prank(address(reenterer));
        book.buy(first, firstSig);

        _assertRefused();
        assertEq(book.policyCount(), 1);
        assertFalse(book.quoteUsed(_quoteDigest(book.DOMAIN_SEPARATOR(), second)));
    }

    function test_Buy_CannotReenterSettlement() public {
        uint256 id = _wetPolicy();
        (Quote memory q, bytes memory signature) = _quote(2);
        q.start = T0 + 10 minutes;
        q.end = T0 + 20 minutes;
        q.expiry = T0 + 15 minutes;
        signature = _signDigest(underwriterKey, _quoteDigest(book.DOMAIN_SEPARATOR(), q));
        reenterer.arm(address(book), abi.encodeCall(CoverBook.settle, (id)), false);

        vm.prank(address(reenterer));
        book.buy(q, signature);

        _assertRefused();
        (,,,,,,, uint256 paid,,) = book.policies(id);
        assertEq(paid, 0);
    }

    function test_Settle_AReenteringHolderOnlyDefersTheirOwnPayout() public {
        uint256 id = _wetPolicy();

        // On receiving the payout the holder tries to settle again and lets the refusal undo the transfer.
        reenterer.arm(address(book), abi.encodeCall(CoverBook.settle, (id)), true);
        uint256 before = dollar.balanceOf(address(reenterer));
        uint256 paid = book.settle(id);

        assertEq(paid, 6e6);
        assertEq(dollar.balanceOf(address(reenterer)), before, "nothing was transferred");
        assertEq(pool.deferred(address(reenterer)), 6e6, "the payout waits in the pool");
        assertEq(pool.lockedExposure(), 0);
        (,,,,,,, uint256 totalPaid,, bool closed) = book.policies(id);
        assertEq(totalPaid, 6e6);
        assertTrue(closed);

        // Once the holder stops interfering the payout is delivered, once.
        reenterer.arm(address(0), "", false);
        pool.claimDeferred(address(reenterer));
        assertEq(dollar.balanceOf(address(reenterer)), before + 6e6);
        assertEq(pool.totalDeferred(), 0);
    }

    function test_Settle_CannotReenterThePoolWhileThePayoutMoves() public {
        uint256 id = _wetPolicy();
        vm.prank(address(reenterer));
        pool.deposit(500e6, address(reenterer));

        reenterer.arm(
            address(pool), abi.encodeCall(pool.withdraw, (100e6, address(reenterer), address(reenterer))), false
        );
        book.settle(id);

        _assertRefused();
        assertEq(pool.deferred(address(reenterer)), 0, "the payout itself went through");
    }

    /// @dev Leaves the reenterer with a matured redemption request for 500 dollars.
    function _maturedRequest() internal {
        vm.startPrank(address(reenterer));
        uint256 shares = pool.deposit(500e6, address(reenterer));
        pool.requestRedeem(shares, address(reenterer), address(reenterer));
        vm.stopPrank();
        vm.warp(vm.getBlockTimestamp() + pool.redeemNotice());
    }

    function test_Claim_CannotBeReenteredWhileTheAssetsMove() public {
        _maturedRequest();

        // Claiming the same escrowed shares again from inside the first claim would pay them twice.
        reenterer.arm(
            address(pool), abi.encodeCall(pool.withdraw, (100e6, address(reenterer), address(reenterer))), false
        );
        vm.prank(address(reenterer));
        pool.withdraw(100e6, address(reenterer), address(reenterer));

        _assertRefused();
        assertEq(pool.maxWithdraw(address(reenterer)), 400e6);
    }

    function test_Claim_CannotReenterACancellation() public {
        _maturedRequest();

        // Taking the shares back out of escrow while they are being paid would keep both.
        reenterer.arm(address(pool), abi.encodeCall(pool.cancelRedeemRequest, ()), false);
        vm.prank(address(reenterer));
        pool.redeem(100e6 * 1e6, address(reenterer), address(reenterer));

        _assertRefused();
        assertEq(pool.balanceOf(address(reenterer)), 0);
        assertEq(pool.escrowedShares(), 400e6 * 1e6);
    }

    function test_Deposit_CannotReenterARedemptionRequest() public {
        vm.prank(address(reenterer));
        pool.deposit(500e6, address(reenterer));

        reenterer.arm(
            address(pool), abi.encodeCall(pool.requestRedeem, (1, address(reenterer), address(reenterer))), false
        );
        vm.prank(address(reenterer));
        pool.deposit(100e6, address(reenterer));

        _assertRefused();
        assertEq(pool.escrowedShares(), 0);
    }

    function test_Deposit_CannotReenterARedemption() public {
        vm.prank(address(reenterer));
        pool.deposit(500e6, address(reenterer));

        reenterer.arm(address(pool), abi.encodeCall(pool.redeem, (1, address(reenterer), address(reenterer))), false);
        vm.prank(address(reenterer));
        pool.deposit(100e6, address(reenterer));

        _assertRefused();
    }

    function test_ClaimDeferred_CannotBeReentered() public {
        uint256 id = _wetPolicy();
        reenterer.arm(address(book), abi.encodeCall(CoverBook.settle, (id)), true);
        book.settle(id);
        assertEq(pool.deferred(address(reenterer)), 6e6);

        // Claiming again from inside the first claim would pay the deferred amount twice.
        reenterer.arm(address(pool), abi.encodeCall(CoverPool.claimDeferred, (address(reenterer))), false);
        uint256 before = dollar.balanceOf(address(reenterer));
        pool.claimDeferred(address(reenterer));

        _assertRefused();
        assertEq(dollar.balanceOf(address(reenterer)), before + 6e6);
        assertEq(pool.deferred(address(reenterer)), 0);
    }
}
