// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {CoverPool} from "../src/CoverPool.sol";
import {TestDollar} from "../src/TestDollar.sol";
import {BlockableDollar} from "./mocks/BlockableDollar.sol";
import {SilentDollar} from "./mocks/SilentDollar.sol";
import {Signing} from "./utils/Signing.sol";

contract CoverPoolTest is Signing {
    BlockableDollar internal dollar;
    CoverPool internal pool;

    address internal owner = makeAddr("owner");
    address internal book = makeAddr("book");
    address internal relayer = makeAddr("relayer");
    address internal holder = makeAddr("holder");
    address internal attacker = makeAddr("attacker");
    address internal lp;
    uint256 internal lpKey;
    address internal lp2 = makeAddr("lp2");

    uint256 internal constant KEY = (uint256(1) << 64) | 7;
    uint256 internal constant OTHER_KEY = (uint256(1) << 64) | 8;
    uint256 internal constant SHARE_UNIT = 1e6;

    function setUp() public {
        vm.warp(1_760_000_400);
        (lp, lpKey) = makeAddrAndKey("lp");
        dollar = new BlockableDollar(owner);
        pool = new CoverPool(dollar, owner, "Cover Pool Share", "cvUSD");
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

    function _deposit(address from, uint256 assets) internal returns (uint256 shares) {
        vm.prank(from);
        return pool.deposit(assets, from);
    }

    function _lock(uint256 key, uint256 amount) internal {
        vm.prank(book);
        pool.lock(key, amount);
    }

    // ───────────────────────────── construction and administration ─────────────────────────────

    function test_InitialState() public view {
        assertEq(pool.asset(), address(dollar));
        assertEq(pool.name(), "Cover Pool Share");
        assertEq(pool.symbol(), "cvUSD");
        assertEq(pool.decimals(), 12);
        assertEq(pool.owner(), owner);
        assertEq(pool.book(), book);
        assertEq(pool.maxUtilizationBps(), 8000);
        assertEq(pool.maxCellBps(), 2500);
        assertEq(pool.lockedExposure(), 0);
        assertEq(pool.totalAssets(), 0);
        assertEq(pool.freeAssets(), 0);
    }

    function test_SetBook_IsOneTime() public {
        CoverPool fresh = new CoverPool(dollar, owner, "Cover Pool Share", "cvUSD");
        assertEq(fresh.book(), address(0));

        vm.expectEmit(address(fresh));
        emit CoverPool.BookSet(book);
        vm.prank(owner);
        fresh.setBook(book);
        assertEq(fresh.book(), book);

        vm.expectRevert(CoverPool.BookAlreadySet.selector);
        vm.prank(owner);
        fresh.setBook(relayer);
    }

    function test_SetBook_RevertWhen_ZeroAddress() public {
        CoverPool fresh = new CoverPool(dollar, owner, "Cover Pool Share", "cvUSD");
        vm.expectRevert(CoverPool.ZeroAddress.selector);
        vm.prank(owner);
        fresh.setBook(address(0));
    }

    function test_SetBook_RevertWhen_CallerIsNotOwner() public {
        CoverPool fresh = new CoverPool(dollar, owner, "Cover Pool Share", "cvUSD");
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, attacker));
        vm.prank(attacker);
        fresh.setBook(attacker);
    }

    function test_SetMaxUtilizationBps() public {
        vm.expectEmit(address(pool));
        emit CoverPool.MaxUtilizationSet(5000);
        vm.prank(owner);
        pool.setMaxUtilizationBps(5000);
        assertEq(pool.maxUtilizationBps(), 5000);

        vm.prank(owner);
        pool.setMaxUtilizationBps(10_000);
        assertEq(pool.maxUtilizationBps(), 10_000);
    }

    function test_SetMaxUtilizationBps_RevertWhen_AboveOneHundredPercent() public {
        vm.expectRevert(CoverPool.BpsInvalid.selector);
        vm.prank(owner);
        pool.setMaxUtilizationBps(10_001);
    }

    function test_SetMaxUtilizationBps_RevertWhen_CallerIsNotOwner() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, attacker));
        vm.prank(attacker);
        pool.setMaxUtilizationBps(10_000);
    }

    function test_SetMaxCellBps() public {
        vm.expectEmit(address(pool));
        emit CoverPool.MaxCellSet(1000);
        vm.prank(owner);
        pool.setMaxCellBps(1000);
        assertEq(pool.maxCellBps(), 1000);
    }

    function test_SetMaxCellBps_RevertWhen_AboveOneHundredPercent() public {
        vm.expectRevert(CoverPool.BpsInvalid.selector);
        vm.prank(owner);
        pool.setMaxCellBps(10_001);
    }

    function test_SetMaxCellBps_RevertWhen_CallerIsNotOwner() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, attacker));
        vm.prank(attacker);
        pool.setMaxCellBps(10_000);
    }

    // ───────────────────────────── vault basics ─────────────────────────────

    function test_Deposit_MintsSharesWithSixExtraDecimals() public {
        uint256 shares = _deposit(lp, 1_000e6);

        assertEq(shares, 1_000e6 * SHARE_UNIT);
        assertEq(pool.balanceOf(lp), shares);
        assertEq(pool.totalAssets(), 1_000e6);
        assertEq(pool.freeAssets(), 1_000e6);
        assertEq(pool.maxWithdraw(lp), 1_000e6);
        assertEq(pool.maxRedeem(lp), shares);
    }

    function test_Mint_PullsTheQuotedAssets() public {
        vm.prank(lp);
        uint256 assets = pool.mint(500e6 * SHARE_UNIT, lp);
        assertEq(assets, 500e6);
        assertEq(pool.totalAssets(), 500e6);
    }

    function test_PremiumsRaiseTheSharePrice() public {
        _deposit(lp, 1_000e6);
        vm.prank(attacker);
        dollar.transfer(address(pool), 100e6);

        assertEq(pool.totalAssets(), 1_100e6);
        assertApproxEqAbs(pool.maxWithdraw(lp), 1_100e6, 1);
    }

    function test_InflationAttack_IsUnprofitable() public {
        // The attacker seeds the empty vault with one unit and donates a large amount to inflate the price.
        _deposit(attacker, 1);
        vm.prank(attacker);
        dollar.transfer(address(pool), 10_000e6);

        uint256 shares = _deposit(lp, 1_000e6);
        assertGt(shares, 0);

        uint256 victimValue = pool.previewRedeem(pool.balanceOf(lp));
        uint256 attackerValue = pool.previewRedeem(pool.balanceOf(attacker));

        assertGe(victimValue, 1_000e6 * 9_999 / 10_000, "victim keeps their deposit");
        assertLt(attackerValue, 10_000e6 + 1, "attacker does not recover the donation");
        assertLt(attackerValue, 10_000e6 * 6 / 10, "attacker loses a large part of the donation");
    }

    // ───────────────────────────── lock ─────────────────────────────

    function test_Lock_TracksGlobalAndCellExposure() public {
        _deposit(lp, 1_000e6);

        _lock(KEY, 200e6);
        _lock(OTHER_KEY, 50e6);
        vm.expectEmit(address(pool));
        emit CoverPool.ExposureChanged(KEY, 250e6, 300e6);
        _lock(KEY, 50e6);

        assertEq(pool.lockedExposure(), 300e6);
        assertEq(pool.cellExposure(KEY), 250e6);
        assertEq(pool.cellExposure(OTHER_KEY), 50e6);
        assertEq(pool.freeAssets(), 700e6);
    }

    function test_Lock_RevertWhen_CallerIsNotTheBook() public {
        _deposit(lp, 1_000e6);
        vm.expectRevert(CoverPool.NotBook.selector);
        vm.prank(owner);
        pool.lock(KEY, 1);
    }

    function test_Lock_RevertWhen_GlobalCapExceeded() public {
        _deposit(lp, 1_000e6);
        vm.prank(owner);
        pool.setMaxCellBps(10_000);

        _lock(KEY, 800e6);
        vm.expectRevert(CoverPool.GlobalCapExceeded.selector);
        vm.prank(book);
        pool.lock(OTHER_KEY, 1);
    }

    function test_Lock_RevertWhen_CellCapExceeded() public {
        _deposit(lp, 1_000e6);

        _lock(KEY, 250e6);
        vm.expectRevert(CoverPool.CellCapExceeded.selector);
        vm.prank(book);
        pool.lock(KEY, 1);

        // Another cell still has room.
        _lock(OTHER_KEY, 250e6);
    }

    function test_Lock_GlobalCapIsCheckedBeforeTheCellCap() public {
        _deposit(lp, 1_000e6);
        vm.expectRevert(CoverPool.GlobalCapExceeded.selector);
        vm.prank(book);
        pool.lock(KEY, 801e6);
    }

    function test_Lock_CapsRoundDown() public {
        _deposit(lp, 9);
        vm.prank(owner);
        pool.setMaxCellBps(10_000);

        // 80% of 9 units is 7.2: seven may be locked, the eighth may not.
        _lock(KEY, 7);
        vm.expectRevert(CoverPool.GlobalCapExceeded.selector);
        vm.prank(book);
        pool.lock(KEY, 1);
    }

    function test_Lock_RevertWhen_PoolIsEmpty() public {
        vm.expectRevert(CoverPool.GlobalCapExceeded.selector);
        vm.prank(book);
        pool.lock(KEY, 1);
    }

    function test_Lock_CapsFollowTotalAssets() public {
        _deposit(lp, 1_000e6);
        _lock(KEY, 250e6);

        _deposit(lp2, 1_000e6);
        _lock(KEY, 250e6);
        assertEq(pool.cellExposure(KEY), 500e6);
    }

    function testFuzz_Lock_NeverExceedsTheCaps(uint256 deposited, uint16 utilizationBps, uint16 cellBps, uint256 amount)
        public
    {
        deposited = bound(deposited, 1, 1_000_000e6);
        utilizationBps = uint16(bound(utilizationBps, 0, 10_000));
        cellBps = uint16(bound(cellBps, 0, 10_000));
        amount = bound(amount, 0, 2_000_000e6);
        _deposit(lp, deposited);
        vm.startPrank(owner);
        pool.setMaxUtilizationBps(utilizationBps);
        pool.setMaxCellBps(cellBps);
        vm.stopPrank();

        bool overGlobal = amount * 10_000 > deposited * utilizationBps;
        bool overCell = amount * 10_000 > deposited * cellBps;
        if (overGlobal) vm.expectRevert(CoverPool.GlobalCapExceeded.selector);
        else if (overCell) vm.expectRevert(CoverPool.CellCapExceeded.selector);
        vm.prank(book);
        pool.lock(KEY, amount);

        assertLe(pool.lockedExposure(), pool.totalAssets());
        assertLe(pool.lockedExposure() * 10_000, pool.totalAssets() * utilizationBps);
        assertLe(pool.cellExposure(KEY) * 10_000, pool.totalAssets() * cellBps);
    }

    // ───────────────────────────── release ─────────────────────────────

    function test_Release_ReducesBothExposures() public {
        _deposit(lp, 1_000e6);
        _lock(KEY, 200e6);

        vm.expectEmit(address(pool));
        emit CoverPool.ExposureChanged(KEY, 50e6, 50e6);
        vm.prank(book);
        pool.release(KEY, 150e6);

        assertEq(pool.lockedExposure(), 50e6);
        assertEq(pool.cellExposure(KEY), 50e6);
        assertEq(pool.freeAssets(), 950e6);
    }

    function test_Release_RevertWhen_CallerIsNotTheBook() public {
        vm.expectRevert(CoverPool.NotBook.selector);
        vm.prank(owner);
        pool.release(KEY, 0);
    }

    function test_Release_RevertWhen_MoreThanTheCellHolds() public {
        _deposit(lp, 1_000e6);
        _lock(KEY, 200e6);
        _lock(OTHER_KEY, 200e6);

        vm.expectRevert(CoverPool.ExposureUnderflow.selector);
        vm.prank(book);
        pool.release(KEY, 200e6 + 1);
    }

    // ───────────────────────────── pay ─────────────────────────────

    function test_Pay_TransfersAndReducesBothExposures() public {
        _deposit(lp, 1_000e6);
        _lock(KEY, 200e6);

        vm.expectEmit(address(pool));
        emit CoverPool.ExposureChanged(KEY, 80e6, 80e6);
        vm.prank(book);
        pool.pay(holder, KEY, 120e6);

        assertEq(dollar.balanceOf(holder), 120e6);
        assertEq(pool.lockedExposure(), 80e6);
        assertEq(pool.cellExposure(KEY), 80e6);
        assertEq(pool.totalAssets(), 880e6);
        assertEq(pool.freeAssets(), 800e6);
    }

    function test_Pay_ZeroAmountMovesNothing() public {
        _deposit(lp, 1_000e6);
        _lock(KEY, 200e6);

        vm.prank(book);
        pool.pay(holder, KEY, 0);

        assertEq(dollar.balanceOf(holder), 0);
        assertEq(pool.lockedExposure(), 200e6);
        assertEq(pool.deferred(holder), 0);
    }

    function test_Pay_RevertWhen_CallerIsNotTheBook() public {
        _deposit(lp, 1_000e6);
        vm.expectRevert(CoverPool.NotBook.selector);
        vm.prank(attacker);
        pool.pay(attacker, KEY, 1);
    }

    function test_Pay_RevertWhen_MoreThanTheCellHolds() public {
        _deposit(lp, 1_000e6);
        _lock(KEY, 200e6);

        vm.expectRevert(CoverPool.ExposureUnderflow.selector);
        vm.prank(book);
        pool.pay(holder, KEY, 200e6 + 1);
    }

    function test_Pay_DefersWhenTheRecipientCannotReceive() public {
        _deposit(lp, 1_000e6);
        _lock(KEY, 200e6);
        vm.prank(owner);
        dollar.setBlocked(holder, true);

        vm.expectEmit(address(pool));
        emit CoverPool.PayoutDeferred(holder, 120e6);
        vm.prank(book);
        pool.pay(holder, KEY, 120e6);

        // The exposure is gone and the money is set aside: it is no longer the LPs' and backs nothing else.
        assertEq(dollar.balanceOf(holder), 0);
        assertEq(pool.deferred(holder), 120e6);
        assertEq(pool.totalDeferred(), 120e6);
        assertEq(pool.lockedExposure(), 80e6);
        assertEq(pool.cellExposure(KEY), 80e6);
        assertEq(pool.totalAssets(), 880e6);
        assertEq(pool.freeAssets(), 800e6);
        assertEq(pool.maxWithdraw(lp), 800e6);
    }

    function test_ClaimDeferred_PaysOnceTheRecipientCanReceive() public {
        _deposit(lp, 1_000e6);
        _lock(KEY, 200e6);
        vm.prank(owner);
        dollar.setBlocked(holder, true);
        vm.prank(book);
        pool.pay(holder, KEY, 120e6);

        vm.expectRevert(abi.encodeWithSelector(BlockableDollar.AccountBlocked.selector, holder));
        pool.claimDeferred(holder);

        vm.prank(owner);
        dollar.setBlocked(holder, false);

        vm.expectEmit(address(pool));
        emit CoverPool.DeferredClaimed(holder, 120e6);
        vm.prank(relayer);
        uint256 claimed = pool.claimDeferred(holder);

        assertEq(claimed, 120e6);
        assertEq(dollar.balanceOf(holder), 120e6);
        assertEq(pool.deferred(holder), 0);
        assertEq(pool.totalDeferred(), 0);
        assertEq(pool.totalAssets(), 880e6);
    }

    function test_ClaimDeferred_RevertWhen_NothingIsOwed() public {
        vm.expectRevert(CoverPool.NothingDeferred.selector);
        pool.claimDeferred(holder);
    }

    // ───────────────────────────── withdrawals ─────────────────────────────

    function test_MaxWithdraw_IsLimitedToFreeAssets() public {
        uint256 shares = _deposit(lp, 1_000e6);
        _lock(KEY, 250e6);
        _lock(OTHER_KEY, 250e6);

        assertEq(pool.freeAssets(), 500e6);
        assertEq(pool.maxWithdraw(lp), 500e6);
        assertEq(pool.maxRedeem(lp), shares / 2);
    }

    function test_MaxWithdraw_IsLimitedToTheOwnersShares() public {
        _deposit(lp, 1_000e6);
        _deposit(lp2, 100e6);
        _lock(KEY, 250e6);

        assertEq(pool.maxWithdraw(lp2), 100e6);
        assertEq(pool.maxRedeem(lp2), pool.balanceOf(lp2));
    }

    function test_Withdraw_UpToFreeAssets() public {
        _deposit(lp, 1_000e6);
        _lock(KEY, 250e6);

        vm.prank(lp);
        pool.withdraw(750e6, lp, lp);

        assertEq(pool.totalAssets(), 250e6);
        assertEq(pool.freeAssets(), 0);
        assertEq(pool.maxWithdraw(lp), 0);
        assertEq(pool.maxRedeem(lp), 0);
        assertGe(dollar.balanceOf(address(pool)), pool.lockedExposure());
    }

    function test_Withdraw_RevertWhen_AssetsBackLiveExposure() public {
        _deposit(lp, 1_000e6);
        _lock(KEY, 250e6);

        vm.expectRevert(CoverPool.ExposureLocked.selector);
        vm.prank(lp);
        pool.withdraw(750e6 + 1, lp, lp);
    }

    function test_Redeem_RevertWhen_AssetsBackLiveExposure() public {
        uint256 shares = _deposit(lp, 1_000e6);
        _lock(KEY, 250e6);

        vm.expectRevert(CoverPool.ExposureLocked.selector);
        vm.prank(lp);
        pool.redeem(shares, lp, lp);

        uint256 redeemable = pool.maxRedeem(lp);
        vm.prank(lp);
        uint256 assets = pool.redeem(redeemable, lp, lp);
        assertEq(assets, 750e6);
    }

    function test_Withdraw_RevertWhen_MoreThanTheOwnerHolds() public {
        _deposit(lp, 1_000e6);
        _deposit(lp2, 100e6);

        vm.expectRevert(abi.encodeWithSelector(ERC4626.ERC4626ExceededMaxWithdraw.selector, lp2, 100e6 + 1, 100e6));
        vm.prank(lp2);
        pool.withdraw(100e6 + 1, lp2, lp2);
    }

    function test_Redeem_RevertWhen_MoreThanTheOwnerHolds() public {
        _deposit(lp, 1_000e6);
        uint256 shares = _deposit(lp2, 100e6);

        vm.expectRevert(abi.encodeWithSelector(ERC4626.ERC4626ExceededMaxRedeem.selector, lp2, shares + 1, shares));
        vm.prank(lp2);
        pool.redeem(shares + 1, lp2, lp2);
    }

    function test_Withdraw_RacingAPurchase_EitherOrderKeepsExposureBacked() public {
        _deposit(lp, 1_000e6);

        // Purchase first: the withdrawal can no longer take what now backs the policy.
        uint256 snapshot = vm.snapshotState();
        _lock(KEY, 250e6);
        vm.expectRevert(CoverPool.ExposureLocked.selector);
        vm.prank(lp);
        pool.withdraw(800e6, lp, lp);
        vm.revertToState(snapshot);

        // Withdrawal first: the purchase no longer fits under the caps and is refused.
        vm.prank(lp);
        pool.withdraw(800e6, lp, lp);
        vm.expectRevert(CoverPool.GlobalCapExceeded.selector);
        vm.prank(book);
        pool.lock(KEY, 250e6);
    }

    function testFuzz_Withdraw_NeverTakesAssetsBackingExposure(uint256 deposited, uint256 locked, uint256 requested)
        public
    {
        deposited = bound(deposited, 1e6, 1_000_000e6);
        vm.prank(owner);
        pool.setMaxCellBps(10_000);
        _deposit(lp, deposited);
        locked = bound(locked, 0, deposited * 8 / 10);
        _lock(KEY, locked);
        requested = bound(requested, 0, deposited);

        uint256 limit = pool.maxWithdraw(lp);
        assertLe(limit, pool.freeAssets());
        if (requested > limit) vm.expectRevert();
        vm.prank(lp);
        pool.withdraw(requested, lp, lp);

        assertGe(dollar.balanceOf(address(pool)), pool.lockedExposure());
        assertLe(pool.maxWithdraw(lp), pool.freeAssets());
        assertLe(pool.previewRedeem(pool.maxRedeem(lp)), pool.freeAssets());
    }

    function testFuzz_Redeem_NeverTakesAssetsBackingExposure(uint256 deposited, uint256 locked, uint256 donated)
        public
    {
        deposited = bound(deposited, 1e6, 1_000_000e6);
        donated = bound(donated, 0, 1_000e6);
        vm.prank(owner);
        pool.setMaxCellBps(10_000);
        _deposit(lp, deposited);
        locked = bound(locked, 0, deposited * 8 / 10);
        _lock(KEY, locked);
        vm.prank(attacker);
        dollar.transfer(address(pool), donated);

        uint256 shares = pool.maxRedeem(lp);
        vm.prank(lp);
        uint256 assets = pool.redeem(shares, lp, lp);

        assertLe(assets, deposited + donated - locked);
        assertGe(dollar.balanceOf(address(pool)), pool.lockedExposure());
    }

    // ───────────────────────────── gasless deposit ─────────────────────────────

    function _depositAuthorization(uint256 assets, bytes32 nonce)
        internal
        view
        returns (Authorization memory a, uint8 v, bytes32 r, bytes32 s)
    {
        a = Authorization({
            from: lp,
            to: address(pool),
            value: assets,
            validAfter: 0,
            validBefore: vm.getBlockTimestamp() + 1 hours,
            nonce: nonce
        });
        (v, r, s) = _signReceiveAuthorization(lpKey, dollar.DOMAIN_SEPARATOR(), a);
    }

    function test_DepositWithAuthorization_MintsToTheSignerForAnySubmitter() public {
        vm.prank(lp);
        dollar.approve(address(pool), 0);
        (Authorization memory a, uint8 v, bytes32 r, bytes32 s) = _depositAuthorization(400e6, keccak256("d1"));
        uint256 expectedShares = pool.previewDeposit(400e6);

        vm.expectEmit(address(pool));
        emit IERC4626.Deposit(relayer, lp, 400e6, expectedShares);
        vm.prank(relayer);
        uint256 shares = pool.depositWithAuthorization(400e6, lp, a.validAfter, a.validBefore, a.nonce, v, r, s);

        assertEq(shares, expectedShares);
        assertEq(pool.balanceOf(lp), expectedShares);
        assertEq(pool.balanceOf(relayer), 0);
        assertEq(pool.totalAssets(), 400e6);
        assertEq(dollar.balanceOf(lp), 1_000_000e6 - 400e6);
    }

    function test_DepositWithAuthorization_PricesSharesBeforeTheAssetsArrive() public {
        _deposit(lp2, 1_000e6);
        vm.prank(attacker);
        dollar.transfer(address(pool), 500e6);
        (Authorization memory a, uint8 v, bytes32 r, bytes32 s) = _depositAuthorization(300e6, keccak256("d1"));

        uint256 expectedShares = pool.previewDeposit(300e6);
        vm.prank(relayer);
        uint256 shares = pool.depositWithAuthorization(300e6, lp, a.validAfter, a.validBefore, a.nonce, v, r, s);

        assertEq(shares, expectedShares);
        assertApproxEqAbs(pool.previewRedeem(shares), 300e6, 1);
    }

    function test_DepositWithAuthorization_RevertWhen_Replayed() public {
        (Authorization memory a, uint8 v, bytes32 r, bytes32 s) = _depositAuthorization(400e6, keccak256("d1"));
        pool.depositWithAuthorization(400e6, lp, a.validAfter, a.validBefore, a.nonce, v, r, s);

        vm.expectRevert(abi.encodeWithSelector(TestDollar.AuthorizationAlreadyUsed.selector, lp, a.nonce));
        pool.depositWithAuthorization(400e6, lp, a.validAfter, a.validBefore, a.nonce, v, r, s);
    }

    function test_DepositWithAuthorization_RevertWhen_AmountOrReceiverDiffersFromTheSignedOnes() public {
        (Authorization memory a, uint8 v, bytes32 r, bytes32 s) = _depositAuthorization(400e6, keccak256("d1"));

        vm.expectRevert(TestDollar.InvalidAuthorizationSignature.selector);
        pool.depositWithAuthorization(401e6, lp, a.validAfter, a.validBefore, a.nonce, v, r, s);

        // Nobody can redirect the shares: the receiver is the account the assets are pulled from.
        vm.expectRevert(TestDollar.InvalidAuthorizationSignature.selector);
        vm.prank(attacker);
        pool.depositWithAuthorization(400e6, attacker, a.validAfter, a.validBefore, a.nonce, v, r, s);

        assertEq(pool.totalSupply(), 0);
    }

    function test_DepositWithAuthorization_RevertWhen_Expired() public {
        (Authorization memory a, uint8 v, bytes32 r, bytes32 s) = _depositAuthorization(400e6, keccak256("d1"));
        vm.warp(a.validBefore);

        vm.expectRevert(abi.encodeWithSelector(TestDollar.AuthorizationExpired.selector, a.validBefore));
        pool.depositWithAuthorization(400e6, lp, a.validAfter, a.validBefore, a.nonce, v, r, s);
    }

    function test_DepositWithAuthorization_RevertWhen_TheTokenDoesNotDeliverTheAssets() public {
        CoverPool silentPool = new CoverPool(new SilentDollar(), owner, "Cover Pool Share", "cvUSD");

        vm.expectRevert(CoverPool.DepositNotReceived.selector);
        silentPool.depositWithAuthorization(400e6, lp, 0, type(uint256).max, bytes32(0), 27, bytes32(0), bytes32(0));

        assertEq(silentPool.totalSupply(), 0);
    }

    function test_DepositWithAuthorization_CannotBeConsumedOutsideThePool() public {
        (Authorization memory a, uint8 v, bytes32 r, bytes32 s) = _depositAuthorization(400e6, keccak256("d1"));

        // Submitting the signature to the token directly would move the assets without minting shares.
        vm.expectRevert(abi.encodeWithSelector(TestDollar.CallerMustBePayee.selector, attacker, address(pool)));
        vm.prank(attacker);
        dollar.receiveWithAuthorization(lp, address(pool), 400e6, a.validAfter, a.validBefore, a.nonce, v, r, s);

        vm.expectRevert(TestDollar.InvalidAuthorizationSignature.selector);
        vm.prank(attacker);
        dollar.transferWithAuthorization(lp, address(pool), 400e6, a.validAfter, a.validBefore, a.nonce, v, r, s);
    }
}
