// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {ICoverPool} from "./interfaces/ICoverPool.sol";
import {IERC3009} from "./interfaces/IERC3009.sol";

/// @title CoverPool
/// @notice ERC-4626 vault that underwrites the cover sold by the policy book. Liquidity providers deposit the
/// dollar token; premiums flow in and raise the share price; payouts flow out and lower it.
///
/// Every policy reserves its maximum payout here for as long as it is open. Reserved assets cannot be
/// withdrawn, so a confirmed claim can always be paid.
///
/// @dev Invariants:
/// - `lockedExposure` equals the sum of `cellExposure` over all keys;
/// - the pool's token balance is at least `lockedExposure + totalDeferred`;
/// - at the moment exposure is locked, `lockedExposure <= totalAssets * maxUtilizationBps / 10_000` and
///   `cellExposure[key] <= totalAssets * maxCellBps / 10_000`. Later withdrawals or payouts may leave the
///   ratios above the caps; they only gate new exposure.
///
/// Shares carry six more decimals than the asset (virtual shares), which makes donation-based share price
/// manipulation uneconomic.
contract CoverPool is ERC4626, Ownable2Step, ReentrancyGuardTransient, ICoverPool {
    using SafeERC20 for IERC20;

    uint256 private constant BPS = 10_000;

    /// @notice The policy book: the only account allowed to lock, release and pay out exposure.
    address public book;

    /// @notice Largest share of total assets that may be reserved across all cells, in basis points.
    uint16 public maxUtilizationBps = 8000;

    /// @notice Largest share of total assets that may be reserved for one cell, in basis points.
    uint16 public maxCellBps = 2500;

    /// @notice Assets reserved for the remaining maximum payouts of all open policies.
    uint256 public lockedExposure;

    /// @notice Assets reserved for the open policies of one key.
    mapping(uint256 key => uint256) public cellExposure;

    /// @notice Payouts that could not be delivered and wait for `claimDeferred`.
    mapping(address recipient => uint256) public deferred;

    /// @notice Sum of all deferred payouts. Excluded from `totalAssets`.
    uint256 public totalDeferred;

    event BookSet(address indexed book);
    event MaxUtilizationSet(uint256 bps);
    event MaxCellSet(uint256 bps);

    /// @notice A payout to `to` could not be transferred and was set aside.
    event PayoutDeferred(address indexed to, uint256 amount);

    /// @notice A deferred payout was delivered to `to`.
    event DeferredClaimed(address indexed to, uint256 amount);

    error NotBook();
    error BookAlreadySet();
    error ZeroAddress();
    error BpsInvalid();
    error GlobalCapExceeded();
    error CellCapExceeded();
    error ExposureLocked();
    error ExposureUnderflow();
    error NothingDeferred();
    error DepositNotReceived();

    modifier onlyBook() {
        if (msg.sender != book) revert NotBook();
        _;
    }

    /// @param asset_ The dollar token the pool holds.
    /// @param initialOwner Account that sets the caps and wires the book.
    /// @param name_ Share token name.
    /// @param symbol_ Share token symbol.
    constructor(IERC20 asset_, address initialOwner, string memory name_, string memory symbol_)
        ERC20(name_, symbol_)
        ERC4626(asset_)
        Ownable(initialOwner)
    {}

    // ───────────────────────────── exposure (book only) ─────────────────────────────

    /// @inheritdoc ICoverPool
    /// @dev Reverts with `GlobalCapExceeded` or `CellCapExceeded`. Both caps round down.
    function lock(uint256 key, uint256 amount) external onlyBook {
        uint256 assets = totalAssets();
        uint256 locked = lockedExposure + amount;
        if (locked > assets * maxUtilizationBps / BPS) revert GlobalCapExceeded();
        uint256 cell = cellExposure[key] + amount;
        if (cell > assets * maxCellBps / BPS) revert CellCapExceeded();
        lockedExposure = locked;
        cellExposure[key] = cell;
    }

    /// @inheritdoc ICoverPool
    function release(uint256 key, uint256 amount) external onlyBook {
        _reduceExposure(key, amount);
    }

    /// @inheritdoc ICoverPool
    /// @dev If the token refuses the transfer (for example because the issuer has blocked `to`) the amount is
    /// set aside under `deferred[to]` instead of reverting, so one undeliverable payout cannot keep a policy
    /// open and its exposure reserved forever.
    ///
    /// A caller cannot force the deferral by starving the transfer of gas: the call receives 63/64 of the
    /// remaining gas, and the 1/64 left after an out-of-gas transfer cannot pay for the storage writes below.
    function pay(address to, uint256 key, uint256 amount) external onlyBook nonReentrant {
        _reduceExposure(key, amount);
        if (amount == 0) return;
        if (!IERC20(asset()).trySafeTransfer(to, amount)) {
            deferred[to] += amount;
            totalDeferred += amount;
            emit PayoutDeferred(to, amount);
        }
    }

    // ───────────────────────────── deferred payouts ─────────────────────────────

    /// @notice Delivers the payouts set aside for `to`. Anyone may call; the money only ever goes to `to`.
    /// @return amount The amount transferred.
    function claimDeferred(address to) external nonReentrant returns (uint256 amount) {
        amount = deferred[to];
        if (amount == 0) revert NothingDeferred();
        deferred[to] = 0;
        totalDeferred -= amount;
        emit DeferredClaimed(to, amount);
        IERC20(asset()).safeTransfer(to, amount);
    }

    // ───────────────────────────── vault ─────────────────────────────

    /// @notice Assets owned by the share holders: the token balance minus deferred payouts.
    function totalAssets() public view override returns (uint256) {
        return IERC20(asset()).balanceOf(address(this)) - totalDeferred;
    }

    /// @notice Assets that back no open policy and can be withdrawn.
    function freeAssets() public view returns (uint256) {
        uint256 assets = totalAssets();
        uint256 locked = lockedExposure;
        return assets > locked ? assets - locked : 0;
    }

    /// @notice Largest withdrawal `owner` can make now: their share of the pool, capped by `freeAssets`.
    function maxWithdraw(address owner) public view override returns (uint256) {
        return Math.min(_convertToAssets(balanceOf(owner), Math.Rounding.Floor), freeAssets());
    }

    /// @notice Largest redemption `owner` can make now, in shares.
    function maxRedeem(address owner) public view override returns (uint256) {
        return Math.min(balanceOf(owner), _convertToShares(freeAssets(), Math.Rounding.Floor));
    }

    /// @notice Deposits `assets` from the caller and mints shares to `receiver`.
    function deposit(uint256 assets, address receiver) public override nonReentrant returns (uint256) {
        return super.deposit(assets, receiver);
    }

    /// @notice Mints exactly `shares` to `receiver`, pulling the required assets from the caller.
    function mint(uint256 shares, address receiver) public override nonReentrant returns (uint256) {
        return super.mint(shares, receiver);
    }

    /// @notice Withdraws `assets` to `receiver`, burning shares of `owner`.
    /// @dev Reverts with `ExposureLocked` when `assets` exceeds `freeAssets`.
    function withdraw(uint256 assets, address receiver, address owner) public override nonReentrant returns (uint256) {
        if (assets > freeAssets()) revert ExposureLocked();
        return super.withdraw(assets, receiver, owner);
    }

    /// @notice Redeems `shares` of `owner` and sends the assets to `receiver`.
    /// @dev Reverts with `ExposureLocked` when the shares are worth more than `freeAssets`.
    function redeem(uint256 shares, address receiver, address owner) public override nonReentrant returns (uint256) {
        if (previewRedeem(shares) > freeAssets()) revert ExposureLocked();
        return super.redeem(shares, receiver, owner);
    }

    /// @notice Deposits `assets` from `receiver` using an ERC-3009 authorization they signed for this pool,
    /// and mints the shares to them. Anyone may submit it, so a relayer can pay the gas.
    /// @dev The authorization can only be consumed here (`receiveWithAuthorization` requires the payee to be
    /// the caller), and the shares can only go to the account that pays.
    /// @param assets Amount to deposit; must equal the authorized value.
    /// @param receiver The depositor: signer of the authorization and recipient of the shares.
    /// @param validAfter Authorization validity start.
    /// @param validBefore Authorization validity end.
    /// @param nonce Authorization nonce.
    /// @return shares The shares minted.
    function depositWithAuthorization(
        uint256 assets,
        address receiver,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external nonReentrant returns (uint256 shares) {
        shares = previewDeposit(assets);

        IERC20 token = IERC20(asset());
        uint256 balanceBefore = token.balanceOf(address(this));
        IERC3009(address(token)).receiveWithAuthorization(
            receiver, address(this), assets, validAfter, validBefore, nonce, v, r, s
        );
        if (token.balanceOf(address(this)) - balanceBefore != assets) revert DepositNotReceived();

        _mint(receiver, shares);
        emit Deposit(msg.sender, receiver, assets, shares);
    }

    // ───────────────────────────── administration ─────────────────────────────

    /// @notice Wires the policy book. Can be done once.
    function setBook(address book_) external onlyOwner {
        if (book_ == address(0)) revert ZeroAddress();
        if (book != address(0)) revert BookAlreadySet();
        book = book_;
        emit BookSet(book_);
    }

    /// @notice Sets the global utilization cap. Applies to exposure locked from now on.
    function setMaxUtilizationBps(uint16 bps) external onlyOwner {
        if (bps > BPS) revert BpsInvalid();
        maxUtilizationBps = bps;
        emit MaxUtilizationSet(bps);
    }

    /// @notice Sets the per-cell cap. Applies to exposure locked from now on.
    function setMaxCellBps(uint16 bps) external onlyOwner {
        if (bps > BPS) revert BpsInvalid();
        maxCellBps = bps;
        emit MaxCellSet(bps);
    }

    // ───────────────────────────── internals ─────────────────────────────

    function _reduceExposure(uint256 key, uint256 amount) private {
        uint256 cell = cellExposure[key];
        uint256 locked = lockedExposure;
        if (amount > cell || amount > locked) revert ExposureUnderflow();
        unchecked {
            cellExposure[key] = cell - amount;
            lockedExposure = locked - amount;
        }
    }

    function _decimalsOffset() internal pure override returns (uint8) {
        return 6;
    }
}
