// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {CoverBook} from "../src/CoverBook.sol";
import {ICoverPool} from "../src/interfaces/ICoverPool.sol";
import {IWeatherIndex} from "../src/interfaces/IWeatherIndex.sol";
import {CoverFixture} from "./utils/CoverFixture.sol";

contract CoverBookAdminTest is CoverFixture {
    function _notOwner() private {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, attacker));
        vm.prank(attacker);
    }

    function test_InitialState() public view {
        assertEq(address(book.token()), address(dollar));
        assertEq(address(book.pool()), address(pool));
        assertEq(address(book.index()), address(index));
        assertEq(book.owner(), owner);
        assertEq(book.underwriter(), underwriter);
        assertEq(book.treasury(), treasury);
        assertEq(book.feeBps(), 500);
        assertEq(book.minLead(), 0);
        assertEq(book.minDuration(), 60);
        assertEq(book.maxDuration(), 12 hours);
        assertEq(book.maxPolicyPayout(), MAX_POLICY_PAYOUT);
        assertEq(book.maxOracleAge(), 20 minutes);
        assertEq(book.maxActiveCells(), 64);
        assertEq(book.expiryGrace(), 24 hours);
        assertEq(book.policyCount(), 0);
        assertEq(book.activeCells().length, 0);
    }

    function test_Constructor_RevertWhen_AnAddressIsZero() public {
        vm.expectRevert(CoverBook.ZeroAddress.selector);
        new CoverBook(IERC20(address(0)), pool, index, underwriter, treasury, 0, MAX_POLICY_PAYOUT, owner);

        vm.expectRevert(CoverBook.ZeroAddress.selector);
        new CoverBook(dollar, ICoverPool(address(0)), index, underwriter, treasury, 0, MAX_POLICY_PAYOUT, owner);

        vm.expectRevert(CoverBook.ZeroAddress.selector);
        new CoverBook(dollar, pool, IWeatherIndex(address(0)), underwriter, treasury, 0, MAX_POLICY_PAYOUT, owner);

        vm.expectRevert(CoverBook.ZeroAddress.selector);
        new CoverBook(dollar, pool, index, address(0), treasury, 0, MAX_POLICY_PAYOUT, owner);

        vm.expectRevert(CoverBook.ZeroAddress.selector);
        new CoverBook(dollar, pool, index, underwriter, address(0), 0, MAX_POLICY_PAYOUT, owner);
    }

    function test_Constructor_RevertWhen_MaxPolicyPayoutDoesNotFit() public {
        vm.expectRevert(CoverBook.ConfigInvalid.selector);
        new CoverBook(dollar, pool, index, underwriter, treasury, 0, uint256(type(uint128).max) + 1, owner);
    }

    function test_SetUnderwriter() public {
        vm.expectEmit(address(book));
        emit CoverBook.UnderwriterSet(keeper);
        vm.prank(owner);
        book.setUnderwriter(keeper);
        assertEq(book.underwriter(), keeper);
    }

    function test_SetUnderwriter_RevertWhen_Zero() public {
        vm.expectRevert(CoverBook.ZeroAddress.selector);
        vm.prank(owner);
        book.setUnderwriter(address(0));
    }

    function test_SetUnderwriter_RevertWhen_CallerIsNotOwner() public {
        _notOwner();
        book.setUnderwriter(attacker);
    }

    function test_SetUnderwriter_InvalidatesOutstandingQuotes() public {
        bytes memory signature = _signQuote(_standardQuote(0));
        vm.prank(owner);
        book.setUnderwriter(keeper);

        saltCounter -= 1;
        vm.expectRevert(CoverBook.BadQuoteSignature.selector);
        vm.prank(holder);
        book.buy(_standardQuote(0), signature);
    }

    function test_SetTreasury() public {
        vm.expectEmit(address(book));
        emit CoverBook.TreasurySet(keeper);
        vm.prank(owner);
        book.setTreasury(keeper);
        assertEq(book.treasury(), keeper);

        _buy(_standardQuote(0));
        assertEq(dollar.balanceOf(keeper), PREMIUM * 5 / 100);
        assertEq(dollar.balanceOf(treasury), 0);
    }

    function test_SetTreasury_RevertWhen_Zero() public {
        vm.expectRevert(CoverBook.ZeroAddress.selector);
        vm.prank(owner);
        book.setTreasury(address(0));
    }

    function test_SetTreasury_RevertWhen_CallerIsNotOwner() public {
        _notOwner();
        book.setTreasury(attacker);
    }

    function test_SetFeeBps() public {
        vm.expectEmit(address(book));
        emit CoverBook.FeeSet(2000);
        vm.prank(owner);
        book.setFeeBps(2000);
        assertEq(book.feeBps(), 2000);

        _buy(_standardQuote(0));
        assertEq(dollar.balanceOf(treasury), PREMIUM * 20 / 100);
        assertEq(dollar.balanceOf(address(pool)), POOL_DEPOSIT + PREMIUM * 80 / 100);
    }

    function test_SetFeeBps_ZeroSendsEverythingToThePool() public {
        vm.prank(owner);
        book.setFeeBps(0);

        _buy(_standardQuote(0));
        assertEq(dollar.balanceOf(treasury), 0);
        assertEq(dollar.balanceOf(address(pool)), POOL_DEPOSIT + PREMIUM);
    }

    function test_SetFeeBps_RevertWhen_AboveTheCeiling() public {
        vm.expectRevert(CoverBook.ConfigInvalid.selector);
        vm.prank(owner);
        book.setFeeBps(2001);
    }

    function test_SetFeeBps_RevertWhen_CallerIsNotOwner() public {
        _notOwner();
        book.setFeeBps(0);
    }

    function test_SetMinLead() public {
        vm.expectEmit(address(book));
        emit CoverBook.MinLeadSet(10 minutes);
        vm.prank(owner);
        book.setMinLead(10 minutes);
        assertEq(book.minLead(), 10 minutes);
    }

    function test_SetMinLead_RevertWhen_CallerIsNotOwner() public {
        _notOwner();
        book.setMinLead(0);
    }

    function test_SetDurationBounds() public {
        vm.expectEmit(address(book));
        emit CoverBook.DurationBoundsSet(5 minutes, 2 hours);
        vm.prank(owner);
        book.setDurationBounds(5 minutes, 2 hours);
        assertEq(book.minDuration(), 5 minutes);
        assertEq(book.maxDuration(), 2 hours);
    }

    function test_SetDurationBounds_RevertWhen_Invalid() public {
        vm.expectRevert(CoverBook.ConfigInvalid.selector);
        vm.prank(owner);
        book.setDurationBounds(59, 1 hours);

        vm.expectRevert(CoverBook.ConfigInvalid.selector);
        vm.prank(owner);
        book.setDurationBounds(2 hours, 1 hours);
    }

    function test_SetDurationBounds_RevertWhen_CallerIsNotOwner() public {
        _notOwner();
        book.setDurationBounds(60, 1 hours);
    }

    function test_SetMaxPolicyPayout() public {
        vm.expectEmit(address(book));
        emit CoverBook.MaxPolicyPayoutSet(1e6);
        vm.prank(owner);
        book.setMaxPolicyPayout(1e6);
        assertEq(book.maxPolicyPayout(), 1e6);
    }

    function test_SetMaxPolicyPayout_ZeroStopsSales() public {
        vm.prank(owner);
        book.setMaxPolicyPayout(0);

        bytes memory signature = _signQuote(_standardQuote(0));
        saltCounter -= 1;
        vm.expectRevert(CoverBook.PolicyTooLarge.selector);
        vm.prank(holder);
        book.buy(_standardQuote(0), signature);
    }

    function test_SetMaxPolicyPayout_RevertWhen_DoesNotFit() public {
        vm.expectRevert(CoverBook.ConfigInvalid.selector);
        vm.prank(owner);
        book.setMaxPolicyPayout(uint256(type(uint128).max) + 1);
    }

    function test_SetMaxPolicyPayout_RevertWhen_CallerIsNotOwner() public {
        _notOwner();
        book.setMaxPolicyPayout(1);
    }

    function test_SetMaxOracleAge() public {
        vm.expectEmit(address(book));
        emit CoverBook.MaxOracleAgeSet(5 minutes);
        vm.prank(owner);
        book.setMaxOracleAge(5 minutes);
        assertEq(book.maxOracleAge(), 5 minutes);
    }

    function test_SetMaxOracleAge_RevertWhen_Zero() public {
        vm.expectRevert(CoverBook.ConfigInvalid.selector);
        vm.prank(owner);
        book.setMaxOracleAge(0);
    }

    function test_SetMaxOracleAge_RevertWhen_CallerIsNotOwner() public {
        _notOwner();
        book.setMaxOracleAge(1);
    }

    function test_SetMaxActiveCells() public {
        vm.expectEmit(address(book));
        emit CoverBook.MaxActiveCellsSet(8);
        vm.prank(owner);
        book.setMaxActiveCells(8);
        assertEq(book.maxActiveCells(), 8);
    }

    function test_SetMaxActiveCells_RevertWhen_CallerIsNotOwner() public {
        _notOwner();
        book.setMaxActiveCells(1);
    }

    function test_SetExpiryGrace() public {
        vm.expectEmit(address(book));
        emit CoverBook.ExpiryGraceSet(2 hours);
        vm.prank(owner);
        book.setExpiryGrace(2 hours);
        assertEq(book.expiryGrace(), 2 hours);
    }

    function test_SetExpiryGrace_RevertWhen_BelowTheFloor() public {
        vm.expectRevert(CoverBook.ConfigInvalid.selector);
        vm.prank(owner);
        book.setExpiryGrace(1 hours - 1);
    }

    function test_SetExpiryGrace_RevertWhen_CallerIsNotOwner() public {
        _notOwner();
        book.setExpiryGrace(1 days);
    }

    function test_OwnershipTransferTakesTwoSteps() public {
        vm.prank(owner);
        book.transferOwnership(keeper);
        assertEq(book.owner(), owner);

        vm.prank(keeper);
        book.acceptOwnership();
        assertEq(book.owner(), keeper);
    }
}
