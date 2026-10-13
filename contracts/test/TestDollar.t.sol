// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC3009} from "../src/interfaces/IERC3009.sol";
import {TestDollar} from "../src/TestDollar.sol";
import {Signing} from "./utils/Signing.sol";

contract TestDollarTest is Signing {
    TestDollar internal dollar;

    address internal owner = makeAddr("owner");
    address internal relayer = makeAddr("relayer");
    address internal bob = makeAddr("bob");
    address internal alice;
    uint256 internal aliceKey;
    uint256 internal malloryKey;

    bytes32 internal domain;

    event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce);
    event AuthorizationCanceled(address indexed authorizer, bytes32 indexed nonce);
    event Transfer(address indexed from, address indexed to, uint256 value);

    function setUp() public {
        vm.warp(1_760_000_000);
        (alice, aliceKey) = makeAddrAndKey("alice");
        (, malloryKey) = makeAddrAndKey("mallory");
        dollar = new TestDollar(owner);
        domain = dollar.DOMAIN_SEPARATOR();
        vm.prank(owner);
        dollar.mint(alice, 1_000e6);
    }

    function _authorization(address to, uint256 value, bytes32 nonce) internal view returns (Authorization memory) {
        return Authorization({
            from: alice,
            to: to,
            value: value,
            validAfter: vm.getBlockTimestamp() - 1,
            validBefore: vm.getBlockTimestamp() + 1 hours,
            nonce: nonce
        });
    }

    // ───────────────────────────── metadata ─────────────────────────────

    function test_Metadata() public view {
        assertEq(dollar.name(), "Test Dollar");
        assertEq(dollar.symbol(), "tUSD");
        assertEq(dollar.decimals(), 6);
        assertEq(dollar.version(), "1");
        assertEq(dollar.owner(), owner);
    }

    function test_TypeHashesMatchTheStandards() public view {
        assertEq(dollar.TRANSFER_WITH_AUTHORIZATION_TYPEHASH(), TRANSFER_WITH_AUTHORIZATION_TYPEHASH);
        assertEq(dollar.RECEIVE_WITH_AUTHORIZATION_TYPEHASH(), RECEIVE_WITH_AUTHORIZATION_TYPEHASH);
        assertEq(dollar.CANCEL_AUTHORIZATION_TYPEHASH(), CANCEL_AUTHORIZATION_TYPEHASH);
        assertEq(
            TRANSFER_WITH_AUTHORIZATION_TYPEHASH,
            keccak256(
                "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
            )
        );
        assertEq(
            RECEIVE_WITH_AUTHORIZATION_TYPEHASH,
            keccak256(
                "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
            )
        );
        assertEq(CANCEL_AUTHORIZATION_TYPEHASH, keccak256("CancelAuthorization(address authorizer,bytes32 nonce)"));
    }

    function test_DomainSeparatorUsesNameAndVersionOne() public view {
        bytes32 expected = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("Test Dollar"),
                keccak256("1"),
                block.chainid,
                address(dollar)
            )
        );
        assertEq(dollar.DOMAIN_SEPARATOR(), expected);
    }

    // ───────────────────────────── mint and drip ─────────────────────────────

    function test_Mint() public {
        vm.prank(owner);
        dollar.mint(bob, 5e6);
        assertEq(dollar.balanceOf(bob), 5e6);
        assertEq(dollar.totalSupply(), 1_005e6);
    }

    function test_Mint_RevertWhen_CallerIsNotOwner() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        vm.prank(alice);
        dollar.mint(alice, 1);
    }

    function test_Drip_MintsTheDripAmountToAnyRecipient() public {
        vm.prank(relayer);
        dollar.drip(bob);
        assertEq(dollar.balanceOf(bob), dollar.DRIP_AMOUNT());
        assertEq(dollar.nextDripAt(bob), vm.getBlockTimestamp() + dollar.DRIP_INTERVAL());
    }

    function test_Drip_RevertWhen_RecipientWasServedWithinTheInterval() public {
        dollar.drip(bob);
        uint256 availableAt = vm.getBlockTimestamp() + 1 days;

        vm.warp(availableAt - 1);
        vm.expectRevert(abi.encodeWithSelector(TestDollar.DripLimited.selector, bob, availableAt));
        dollar.drip(bob);
    }

    function test_Drip_IsAvailableAgainAfterTheInterval() public {
        dollar.drip(bob);
        vm.warp(vm.getBlockTimestamp() + 1 days);
        dollar.drip(bob);
        assertEq(dollar.balanceOf(bob), 2 * dollar.DRIP_AMOUNT());
    }

    function test_Drip_LimitIsPerRecipient() public {
        dollar.drip(bob);
        dollar.drip(relayer);
        assertEq(dollar.balanceOf(relayer), dollar.DRIP_AMOUNT());
        assertEq(dollar.nextDripAt(alice), 0);
    }

    // ───────────────────────────── permit ─────────────────────────────

    function test_Permit_SetsTheAllowance() public {
        uint256 deadline = vm.getBlockTimestamp() + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _signPermit(aliceKey, domain, alice, bob, 40e6, dollar.nonces(alice), deadline);

        vm.prank(relayer);
        dollar.permit(alice, bob, 40e6, deadline, v, r, s);

        assertEq(dollar.allowance(alice, bob), 40e6);
        assertEq(dollar.nonces(alice), 1);
    }

    // ───────────────────────────── transferWithAuthorization ─────────────────────────────

    function test_TransferWithAuthorization_MovesFundsForAnySubmitter() public {
        Authorization memory a = _authorization(bob, 25e6, keccak256("n1"));
        (uint8 v, bytes32 r, bytes32 s) = _signTransferAuthorization(aliceKey, domain, a);

        assertFalse(dollar.authorizationState(alice, a.nonce));

        vm.expectEmit(address(dollar));
        emit AuthorizationUsed(alice, a.nonce);
        vm.expectEmit(address(dollar));
        emit Transfer(alice, bob, 25e6);
        vm.prank(relayer);
        dollar.transferWithAuthorization(a.from, a.to, a.value, a.validAfter, a.validBefore, a.nonce, v, r, s);

        assertEq(dollar.balanceOf(bob), 25e6);
        assertEq(dollar.balanceOf(alice), 975e6);
        assertTrue(dollar.authorizationState(alice, a.nonce));
    }

    function test_TransferWithAuthorization_RevertWhen_NotYetValid() public {
        Authorization memory a = _authorization(bob, 1e6, keccak256("n1"));
        a.validAfter = vm.getBlockTimestamp();
        (uint8 v, bytes32 r, bytes32 s) = _signTransferAuthorization(aliceKey, domain, a);

        vm.expectRevert(abi.encodeWithSelector(TestDollar.AuthorizationNotYetValid.selector, a.validAfter));
        dollar.transferWithAuthorization(a.from, a.to, a.value, a.validAfter, a.validBefore, a.nonce, v, r, s);
    }

    function test_TransferWithAuthorization_RevertWhen_Expired() public {
        Authorization memory a = _authorization(bob, 1e6, keccak256("n1"));
        a.validBefore = vm.getBlockTimestamp();
        (uint8 v, bytes32 r, bytes32 s) = _signTransferAuthorization(aliceKey, domain, a);

        vm.expectRevert(abi.encodeWithSelector(TestDollar.AuthorizationExpired.selector, a.validBefore));
        dollar.transferWithAuthorization(a.from, a.to, a.value, a.validAfter, a.validBefore, a.nonce, v, r, s);
    }

    function test_TransferWithAuthorization_RevertWhen_NonceAlreadyUsed() public {
        Authorization memory a = _authorization(bob, 1e6, keccak256("n1"));
        (uint8 v, bytes32 r, bytes32 s) = _signTransferAuthorization(aliceKey, domain, a);
        dollar.transferWithAuthorization(a.from, a.to, a.value, a.validAfter, a.validBefore, a.nonce, v, r, s);

        vm.expectRevert(abi.encodeWithSelector(TestDollar.AuthorizationAlreadyUsed.selector, alice, a.nonce));
        dollar.transferWithAuthorization(a.from, a.to, a.value, a.validAfter, a.validBefore, a.nonce, v, r, s);
    }

    function test_TransferWithAuthorization_RevertWhen_SignedBySomeoneElse() public {
        Authorization memory a = _authorization(bob, 1e6, keccak256("n1"));
        (uint8 v, bytes32 r, bytes32 s) = _signTransferAuthorization(malloryKey, domain, a);

        vm.expectRevert(TestDollar.InvalidAuthorizationSignature.selector);
        dollar.transferWithAuthorization(a.from, a.to, a.value, a.validAfter, a.validBefore, a.nonce, v, r, s);
    }

    function test_TransferWithAuthorization_RevertWhen_AnyFieldIsTampered() public {
        Authorization memory a = _authorization(bob, 1e6, keccak256("n1"));
        (uint8 v, bytes32 r, bytes32 s) = _signTransferAuthorization(aliceKey, domain, a);

        vm.expectRevert(TestDollar.InvalidAuthorizationSignature.selector);
        dollar.transferWithAuthorization(a.from, a.to, a.value + 1, a.validAfter, a.validBefore, a.nonce, v, r, s);

        vm.expectRevert(TestDollar.InvalidAuthorizationSignature.selector);
        dollar.transferWithAuthorization(a.from, relayer, a.value, a.validAfter, a.validBefore, a.nonce, v, r, s);

        vm.expectRevert(TestDollar.InvalidAuthorizationSignature.selector);
        dollar.transferWithAuthorization(a.from, a.to, a.value, a.validAfter, a.validBefore + 1, a.nonce, v, r, s);

        vm.expectRevert(TestDollar.InvalidAuthorizationSignature.selector);
        dollar.transferWithAuthorization(a.from, a.to, a.value, a.validAfter, a.validBefore, keccak256("n2"), v, r, s);
    }

    function test_TransferWithAuthorization_RevertWhen_SignatureIsMalformed() public {
        Authorization memory a = _authorization(bob, 1e6, keccak256("n1"));

        vm.expectRevert(TestDollar.InvalidAuthorizationSignature.selector);
        dollar.transferWithAuthorization(
            a.from, a.to, a.value, a.validAfter, a.validBefore, a.nonce, 27, bytes32(0), bytes32(0)
        );
    }

    function test_TransferWithAuthorization_RevertWhen_ReceiveSignatureIsReused() public {
        Authorization memory a = _authorization(bob, 1e6, keccak256("n1"));
        (uint8 v, bytes32 r, bytes32 s) = _signReceiveAuthorization(aliceKey, domain, a);

        vm.expectRevert(TestDollar.InvalidAuthorizationSignature.selector);
        dollar.transferWithAuthorization(a.from, a.to, a.value, a.validAfter, a.validBefore, a.nonce, v, r, s);
    }

    function testFuzz_TransferWithAuthorization(uint256 value, uint256 lead, uint256 window, bytes32 nonce) public {
        value = bound(value, 0, dollar.balanceOf(alice));
        lead = bound(lead, 1, 365 days);
        window = bound(window, 1, 365 days);
        uint256 nowTs = vm.getBlockTimestamp();
        Authorization memory a = Authorization({
            from: alice,
            to: bob,
            value: value,
            validAfter: nowTs - lead,
            validBefore: nowTs + window,
            nonce: nonce
        });
        (uint8 v, bytes32 r, bytes32 s) = _signTransferAuthorization(aliceKey, domain, a);

        dollar.transferWithAuthorization(a.from, a.to, a.value, a.validAfter, a.validBefore, a.nonce, v, r, s);

        assertEq(dollar.balanceOf(bob), value);
        assertEq(dollar.balanceOf(alice), 1_000e6 - value);
        assertTrue(dollar.authorizationState(alice, nonce));
    }

    // ───────────────────────────── receiveWithAuthorization ─────────────────────────────

    function test_ReceiveWithAuthorization_MovesFundsWhenThePayeeCalls() public {
        Authorization memory a = _authorization(bob, 30e6, keccak256("n1"));
        (uint8 v, bytes32 r, bytes32 s) = _signReceiveAuthorization(aliceKey, domain, a);

        vm.expectEmit(address(dollar));
        emit AuthorizationUsed(alice, a.nonce);
        vm.prank(bob);
        dollar.receiveWithAuthorization(a.from, a.to, a.value, a.validAfter, a.validBefore, a.nonce, v, r, s);

        assertEq(dollar.balanceOf(bob), 30e6);
        assertTrue(dollar.authorizationState(alice, a.nonce));
    }

    function test_ReceiveWithAuthorization_RevertWhen_CallerIsNotThePayee() public {
        Authorization memory a = _authorization(bob, 30e6, keccak256("n1"));
        (uint8 v, bytes32 r, bytes32 s) = _signReceiveAuthorization(aliceKey, domain, a);

        vm.expectRevert(abi.encodeWithSelector(TestDollar.CallerMustBePayee.selector, relayer, bob));
        vm.prank(relayer);
        dollar.receiveWithAuthorization(a.from, a.to, a.value, a.validAfter, a.validBefore, a.nonce, v, r, s);
    }

    function test_ReceiveWithAuthorization_RevertWhen_TransferSignatureIsReused() public {
        Authorization memory a = _authorization(bob, 30e6, keccak256("n1"));
        (uint8 v, bytes32 r, bytes32 s) = _signTransferAuthorization(aliceKey, domain, a);

        vm.expectRevert(TestDollar.InvalidAuthorizationSignature.selector);
        vm.prank(bob);
        dollar.receiveWithAuthorization(a.from, a.to, a.value, a.validAfter, a.validBefore, a.nonce, v, r, s);
    }

    function test_ReceiveWithAuthorization_RevertWhen_NotYetValid() public {
        Authorization memory a = _authorization(bob, 30e6, keccak256("n1"));
        a.validAfter = vm.getBlockTimestamp() + 10;
        (uint8 v, bytes32 r, bytes32 s) = _signReceiveAuthorization(aliceKey, domain, a);

        vm.expectRevert(abi.encodeWithSelector(TestDollar.AuthorizationNotYetValid.selector, a.validAfter));
        vm.prank(bob);
        dollar.receiveWithAuthorization(a.from, a.to, a.value, a.validAfter, a.validBefore, a.nonce, v, r, s);
    }

    function test_ReceiveWithAuthorization_RevertWhen_Expired() public {
        Authorization memory a = _authorization(bob, 30e6, keccak256("n1"));
        (uint8 v, bytes32 r, bytes32 s) = _signReceiveAuthorization(aliceKey, domain, a);

        vm.warp(a.validBefore);
        vm.expectRevert(abi.encodeWithSelector(TestDollar.AuthorizationExpired.selector, a.validBefore));
        vm.prank(bob);
        dollar.receiveWithAuthorization(a.from, a.to, a.value, a.validAfter, a.validBefore, a.nonce, v, r, s);
    }

    function test_ReceiveWithAuthorization_RevertWhen_NonceAlreadyUsed() public {
        Authorization memory a = _authorization(bob, 30e6, keccak256("n1"));
        (uint8 v, bytes32 r, bytes32 s) = _signReceiveAuthorization(aliceKey, domain, a);
        vm.prank(bob);
        dollar.receiveWithAuthorization(a.from, a.to, a.value, a.validAfter, a.validBefore, a.nonce, v, r, s);

        vm.expectRevert(abi.encodeWithSelector(TestDollar.AuthorizationAlreadyUsed.selector, alice, a.nonce));
        vm.prank(bob);
        dollar.receiveWithAuthorization(a.from, a.to, a.value, a.validAfter, a.validBefore, a.nonce, v, r, s);
    }

    function test_ReceiveWithAuthorization_RevertWhen_BalanceIsTooLow() public {
        Authorization memory a = _authorization(bob, 1_000e6 + 1, keccak256("n1"));
        (uint8 v, bytes32 r, bytes32 s) = _signReceiveAuthorization(aliceKey, domain, a);

        vm.expectRevert();
        vm.prank(bob);
        dollar.receiveWithAuthorization(a.from, a.to, a.value, a.validAfter, a.validBefore, a.nonce, v, r, s);
        assertFalse(dollar.authorizationState(alice, a.nonce));
    }

    // ───────────────────────────── cancelAuthorization ─────────────────────────────

    function test_CancelAuthorization_BurnsTheNonce() public {
        Authorization memory a = _authorization(bob, 30e6, keccak256("n1"));
        (uint8 v, bytes32 r, bytes32 s) = _signTransferAuthorization(aliceKey, domain, a);
        (uint8 cv, bytes32 cr, bytes32 cs) = _signCancelAuthorization(aliceKey, domain, alice, a.nonce);

        vm.expectEmit(address(dollar));
        emit AuthorizationCanceled(alice, a.nonce);
        vm.prank(relayer);
        dollar.cancelAuthorization(alice, a.nonce, cv, cr, cs);
        assertTrue(dollar.authorizationState(alice, a.nonce));

        vm.expectRevert(abi.encodeWithSelector(TestDollar.AuthorizationAlreadyUsed.selector, alice, a.nonce));
        dollar.transferWithAuthorization(a.from, a.to, a.value, a.validAfter, a.validBefore, a.nonce, v, r, s);
    }

    function test_CancelAuthorization_RevertWhen_NonceAlreadyUsed() public {
        Authorization memory a = _authorization(bob, 30e6, keccak256("n1"));
        (uint8 v, bytes32 r, bytes32 s) = _signTransferAuthorization(aliceKey, domain, a);
        dollar.transferWithAuthorization(a.from, a.to, a.value, a.validAfter, a.validBefore, a.nonce, v, r, s);

        (uint8 cv, bytes32 cr, bytes32 cs) = _signCancelAuthorization(aliceKey, domain, alice, a.nonce);
        vm.expectRevert(abi.encodeWithSelector(TestDollar.AuthorizationAlreadyUsed.selector, alice, a.nonce));
        dollar.cancelAuthorization(alice, a.nonce, cv, cr, cs);
    }

    function test_CancelAuthorization_RevertWhen_SignedBySomeoneElse() public {
        bytes32 nonce = keccak256("n1");
        (uint8 cv, bytes32 cr, bytes32 cs) = _signCancelAuthorization(malloryKey, domain, alice, nonce);

        vm.expectRevert(TestDollar.InvalidAuthorizationSignature.selector);
        dollar.cancelAuthorization(alice, nonce, cv, cr, cs);
    }

    // ───────────────────────────── interface ─────────────────────────────

    function test_ExposesTheErc3009Surface() public view {
        IERC3009 token = IERC3009(address(dollar));
        assertFalse(token.authorizationState(alice, bytes32(0)));
    }
}
