// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {CoverBook} from "../../src/CoverBook.sol";
import {CoverPool} from "../../src/CoverPool.sol";
import {IERC3009} from "../../src/interfaces/IERC3009.sol";
import {Quote, Reading} from "../../src/Types.sol";
import {WeatherIndex} from "../../src/WeatherIndex.sol";
import {Signing} from "../utils/Signing.sol";

interface IFiatToken is IERC20, IERC3009 {
    function name() external view returns (string memory);
    function version() external view returns (string memory);
    function decimals() external view returns (uint8);
    function DOMAIN_SEPARATOR() external view returns (bytes32);
    function RECEIVE_WITH_AUTHORIZATION_TYPEHASH() external view returns (bytes32);
    function TRANSFER_WITH_AUTHORIZATION_TYPEHASH() external view returns (bytes32);
    function blacklister() external view returns (address);
    function blacklist(address account) external;
    function isBlacklisted(address account) external view returns (bool);
}

/// @dev Runs the purchase, deposit and payout paths against the real native USDC on a Monad mainnet fork.
/// Skipped unless MONAD_RPC_URL is set.
contract NativeUsdcForkTest is Signing {
    IFiatToken internal constant USDC = IFiatToken(0x754704Bc059F8C67012fEd69BC8A327a5aafb603);
    uint256 internal constant MONAD_CHAIN_ID = 143;
    uint256 internal constant KEY = (uint256(1) << 64) | (uint256(1044) << 32) | 420;

    WeatherIndex internal index;
    CoverPool internal pool;
    CoverBook internal book;

    bool internal forked;
    address internal owner = makeAddr("owner");
    address internal treasury = makeAddr("treasury");
    address internal relayer = makeAddr("relayer");
    address internal attacker = makeAddr("attacker");
    address internal lp;
    uint256 internal lpKey;
    address internal holder;
    uint256 internal holderKey;
    uint256 internal underwriterKey;
    uint256 internal reporterKey;

    uint128 internal constant RATE = 1e4;
    uint128 internal constant PREMIUM = 1e6;
    uint256 internal salt;

    function setUp() public {
        string memory rpc = vm.envOr("MONAD_RPC_URL", string(""));
        if (bytes(rpc).length == 0) return;
        vm.createSelectFork(rpc);
        forked = true;

        address underwriter;
        address reporter;
        (lp, lpKey) = makeAddrAndKey("lp");
        (holder, holderKey) = makeAddrAndKey("holder");
        (underwriter, underwriterKey) = makeAddrAndKey("underwriter");
        (reporter, reporterKey) = makeAddrAndKey("reporter");

        index = new WeatherIndex(owner, reporter);
        pool = new CoverPool(USDC, owner, "Cover Pool Share", "cvUSD");
        book = new CoverBook(USDC, pool, index, underwriter, treasury, 0, 500e6, owner);
        vm.prank(owner);
        pool.setBook(address(book));

        deal(address(USDC), lp, 10_000e6);
        deal(address(USDC), holder, 100e6);
        vm.startPrank(lp);
        USDC.approve(address(pool), 5_000e6);
        pool.deposit(5_000e6, lp);
        vm.stopPrank();

        _report(new Reading[](0));
    }

    modifier onlyOnFork() {
        vm.skip(!forked, "MONAD_RPC_URL is not set");
        _;
    }

    function _now() internal view returns (uint64) {
        return uint64(vm.getBlockTimestamp());
    }

    function _report(Reading[] memory readings) internal {
        if (index.lastIssuedAt() >= _now()) vm.warp(uint256(index.lastIssuedAt()) + 1);
        index.submit(_signedReport(reporterKey, index.DOMAIN_SEPARATOR(), readings, _now()));
    }

    function _quote() internal returns (Quote memory) {
        uint64 start = (_now() / 60 + 1) * 60;
        return Quote({
            holder: holder,
            key: KEY,
            start: start,
            end: start + 10 minutes,
            ratePerSecond: RATE,
            premium: PREMIUM,
            expiry: _now() + 5 minutes,
            salt: bytes32(++salt)
        });
    }

    function _signedPurchase(Quote memory q, uint256 payerKey)
        internal
        view
        returns (bytes memory quoteSig, uint8 v, bytes32 r, bytes32 s)
    {
        bytes32 digest = _quoteDigest(book.DOMAIN_SEPARATOR(), q);
        quoteSig = _signDigest(underwriterKey, digest);
        (v, r, s) = _signReceiveAuthorization(
            payerKey, USDC.DOMAIN_SEPARATOR(), Authorization(q.holder, address(book), q.premium, 0, q.expiry, digest)
        );
    }

    function test_Fork_NativeUsdcMatchesTheAssumptions() public onlyOnFork {
        assertEq(block.chainid, MONAD_CHAIN_ID);
        assertEq(USDC.decimals(), 6);
        assertEq(USDC.RECEIVE_WITH_AUTHORIZATION_TYPEHASH(), RECEIVE_WITH_AUTHORIZATION_TYPEHASH);
        assertEq(USDC.TRANSFER_WITH_AUTHORIZATION_TYPEHASH(), TRANSFER_WITH_AUTHORIZATION_TYPEHASH);

        bytes32 expected = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes(USDC.name())),
                keccak256(bytes(USDC.version())),
                MONAD_CHAIN_ID,
                address(USDC)
            )
        );
        assertEq(USDC.DOMAIN_SEPARATOR(), expected);
    }

    function test_Fork_BuyWithAuthorization_PullsThePremiumAndCreatesThePolicy() public onlyOnFork {
        Quote memory q = _quote();
        (bytes memory quoteSig, uint8 v, bytes32 r, bytes32 s) = _signedPurchase(q, holderKey);
        bytes32 digest = book.hashQuote(q);
        uint256 poolBefore = USDC.balanceOf(address(pool));

        vm.prank(relayer);
        uint256 id = book.buyWithAuthorization(q, quoteSig, 0, q.expiry, v, r, s);

        assertEq(id, 1);
        (address policyHolder,,,,, uint128 premium, uint256 maxPayout,,,) = book.policies(id);
        assertEq(policyHolder, holder);
        assertEq(premium, PREMIUM);
        assertEq(maxPayout, uint256(RATE) * 10 minutes);

        assertEq(USDC.balanceOf(holder), 100e6 - PREMIUM);
        assertEq(USDC.balanceOf(treasury), PREMIUM * 5 / 100);
        assertEq(USDC.balanceOf(address(pool)), poolBefore + PREMIUM * 95 / 100);
        assertEq(USDC.balanceOf(address(book)), 0);
        assertEq(USDC.balanceOf(relayer), 0);
        assertTrue(USDC.authorizationState(holder, digest));
        assertTrue(book.quoteUsed(digest));
        assertEq(pool.lockedExposure(), maxPayout);
    }

    function test_Fork_BuyWithAuthorization_RevertWhen_ThePaymentWasSignedForOtherTerms() public onlyOnFork {
        Quote memory signedFor = _quote();
        (, uint8 v, bytes32 r, bytes32 s) = _signedPurchase(signedFor, holderKey);

        Quote memory other = _quote();
        other.ratePerSecond = 1;
        other.expiry = signedFor.expiry;
        bytes memory quoteSig = _signDigest(underwriterKey, _quoteDigest(book.DOMAIN_SEPARATOR(), other));

        vm.expectRevert();
        vm.prank(attacker);
        book.buyWithAuthorization(other, quoteSig, 0, other.expiry, v, r, s);

        assertEq(book.policyCount(), 0);
        assertEq(USDC.balanceOf(holder), 100e6);
    }

    function test_Fork_BuyWithAuthorization_RevertWhen_Replayed() public onlyOnFork {
        Quote memory q = _quote();
        (bytes memory quoteSig, uint8 v, bytes32 r, bytes32 s) = _signedPurchase(q, holderKey);
        vm.prank(relayer);
        book.buyWithAuthorization(q, quoteSig, 0, q.expiry, v, r, s);

        vm.expectRevert(CoverBook.QuoteUsed.selector);
        vm.prank(relayer);
        book.buyWithAuthorization(q, quoteSig, 0, q.expiry, v, r, s);
    }

    function test_Fork_ThePaymentCannotBeTakenOutsideTheBook() public onlyOnFork {
        Quote memory q = _quote();
        (, uint8 v, bytes32 r, bytes32 s) = _signedPurchase(q, holderKey);
        bytes32 digest = book.hashQuote(q);

        vm.expectRevert(bytes("FiatTokenV2: caller must be the payee"));
        vm.prank(attacker);
        USDC.receiveWithAuthorization(holder, address(book), q.premium, 0, q.expiry, digest, v, r, s);

        vm.expectRevert();
        vm.prank(attacker);
        USDC.transferWithAuthorization(holder, address(book), q.premium, 0, q.expiry, digest, v, r, s);

        assertFalse(USDC.authorizationState(holder, digest));
    }

    function test_Fork_DepositWithAuthorization_MintsShares() public onlyOnFork {
        Authorization memory a = Authorization(lp, address(pool), 1_000e6, 0, _now() + 1 hours, keccak256("deposit"));
        (uint8 v, bytes32 r, bytes32 s) = _signReceiveAuthorization(lpKey, USDC.DOMAIN_SEPARATOR(), a);
        uint256 expectedShares = pool.previewDeposit(1_000e6);
        uint256 sharesBefore = pool.balanceOf(lp);

        vm.prank(relayer);
        uint256 shares = pool.depositWithAuthorization(1_000e6, lp, a.validAfter, a.validBefore, a.nonce, v, r, s);

        assertEq(shares, expectedShares);
        assertEq(pool.balanceOf(lp), sharesBefore + shares);
        assertEq(pool.totalAssets(), 6_000e6);
        assertEq(USDC.balanceOf(lp), 4_000e6);
    }

    function test_Fork_Settle_PaysNativeUsdcAndReleasesTheRest() public onlyOnFork {
        Quote memory q = _quote();
        (bytes memory quoteSig, uint8 v, bytes32 r, bytes32 s) = _signedPurchase(q, holderKey);
        vm.prank(relayer);
        uint256 id = book.buyWithAuthorization(q, quoteSig, 0, q.expiry, v, r, s);

        vm.warp(q.end);
        _report(_readings(Reading(KEY, q.start, q.end, 240)));
        uint256 holderBefore = USDC.balanceOf(holder);

        vm.prank(relayer);
        uint256 paid = book.settle(id);

        assertEq(paid, 240 * uint256(RATE));
        assertEq(USDC.balanceOf(holder), holderBefore + paid);
        assertEq(pool.lockedExposure(), 0);
        assertEq(pool.totalDeferred(), 0);
        assertEq(book.activeCells().length, 0);
    }

    function test_Fork_Settle_DefersThePayoutOfABlacklistedHolder() public onlyOnFork {
        Quote memory q = _quote();
        (bytes memory quoteSig, uint8 v, bytes32 r, bytes32 s) = _signedPurchase(q, holderKey);
        vm.prank(relayer);
        uint256 id = book.buyWithAuthorization(q, quoteSig, 0, q.expiry, v, r, s);

        vm.prank(USDC.blacklister());
        USDC.blacklist(holder);
        assertTrue(USDC.isBlacklisted(holder));

        vm.warp(q.end);
        _report(_readings(Reading(KEY, q.start, q.end, 240)));
        uint256 paid = book.settle(id);

        // The policy closes and its exposure is released; the payout waits in the pool.
        assertEq(paid, 240 * uint256(RATE));
        assertEq(pool.deferred(holder), paid);
        assertEq(pool.lockedExposure(), 0);
        (,,,,,,,,, bool closed) = book.policies(id);
        assertTrue(closed);

        vm.expectRevert();
        pool.claimDeferred(holder);
    }
}
