// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {ICoverBook} from "./interfaces/ICoverBook.sol";
import {ICoverPool} from "./interfaces/ICoverPool.sol";
import {IERC3009} from "./interfaces/IERC3009.sol";
import {IERC7540Redeem} from "./interfaces/IERC7540Redeem.sol";

/// @title CoverPool
/// @notice ERC-4626 vault that underwrites the cover sold by the policy book. Liquidity providers deposit the
/// dollar token; premiums flow in and raise the share price; payouts flow out and lower it.
///
/// Every policy reserves its maximum payout here for as long as it is open. Reserved assets cannot leave the
/// pool, so a confirmed claim can always be paid.
///
/// Deposits are immediate. Leaving takes notice: a provider hands shares in with `requestRedeem`, the shares
/// wait in escrow for `redeemNotice`, and they can be redeemed once the notice is over and every policy sold
/// before the request is closed. Capital therefore cannot arrive, back a sale and leave in the same breath,
/// and a provider cannot step out ahead of a payout on cover its capital backed, whether that payout is on its
/// way or already confirmed and waiting to be settled. From the moment of the request the capital is
/// retiring:
/// - it no longer counts towards the caps, so no new cover is sold against it;
/// - it earns nothing further: it is paid the lower of its value at the request and its value at the claim,
///   and what its shares gained in between goes to the treasury. It does not stay in the share price, where
///   a buyer who holds the active shares would collect it back;
/// - it still bears every loss until it is claimed.
///
/// @dev Invariants:
/// - `lockedExposure` equals the sum of `cellExposure` over all keys;
/// - the pool's token balance is at least `lockedExposure + totalDeferred`;
/// - at the moment exposure is locked, `lockedExposure <= activeAssets * maxUtilizationBps / 10_000` and
///   `cellExposure[key] <= activeAssets * maxCellBps / 10_000`. Later requests, claims or payouts may leave the
///   ratios above the caps; they only gate new exposure;
/// - `escrowedShares` equals the sum of the shares of all redemption requests, and the pool holds them;
/// - a claim takes out what the claimed shares are worth, paid to the provider and the rest to the treasury,
///   less rounding: it neither dilutes nor enriches the providers who stay.
///
/// Shares carry six more decimals than the asset (virtual shares), which makes donation-based share price
/// manipulation uneconomic.
///
/// The redemption side uses the ERC-7540 names. It differs from that standard in three ways: a request becomes
/// claimable by the passage of time rather than by an operator's fulfilment, it is priced when it is claimed,
/// and there are no operators: only the controller itself can claim.
contract CoverPool is ERC4626, Ownable2Step, ReentrancyGuardTransient, ICoverPool, IERC7540Redeem, IERC165 {
    using SafeERC20 for IERC20;

    /// @dev One redemption request per controller. `assetsAtRequest` is what the escrowed shares were worth
    /// when the request was last added to; it caps what the request can be paid. `lastPolicyAtRequest` is the
    /// book's `policyCount` at that moment: the claim waits until every policy up to it is closed.
    struct PendingRedeem {
        uint128 shares;
        uint128 assetsAtRequest;
        uint64 claimableAt;
        uint64 lastPolicyAtRequest;
    }

    /// @notice Shortest redemption notice the owner can set.
    uint64 public constant MIN_REDEEM_NOTICE = 1 minutes;

    /// @notice Longest redemption notice the owner can set.
    uint64 public constant MAX_REDEEM_NOTICE = 7 days;

    /// @notice How much longer than the book's cover horizon the notice must be: time for the oracle to report
    /// the last interval of a window at the horizon and for a keeper to settle it.
    uint64 public constant NOTICE_MARGIN = 30 minutes;

    uint256 private constant BPS = 10_000;

    /// @notice The policy book: the only account allowed to lock, release and pay out exposure.
    address public book;

    /// @notice Receives what a capped claim's shares gained after the request.
    address public treasury;

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

    /// @notice Time a redemption request waits in escrow before it can be claimed, in seconds. It should
    /// exceed the longest time a policy can stay open after it is sold.
    uint64 public redeemNotice = 13 hours;

    /// @notice Shares held in escrow for redemption requests.
    uint256 public escrowedShares;

    /// @notice The redemption request of a controller: escrowed shares, their value when requested, the time
    /// from which they can be claimed and the last policy sold before the request.
    mapping(address controller => PendingRedeem) public redeemRequests;

    /// @notice The exposure reserved for `key` changed. Carries the new per-cell and global totals.
    event ExposureChanged(uint256 indexed key, uint256 cellExposure, uint256 lockedExposure);

    event BookSet(address indexed book);
    event MaxUtilizationSet(uint256 bps);
    event MaxCellSet(uint256 bps);

    /// @notice A payout to `to` could not be transferred and was set aside.
    event PayoutDeferred(address indexed to, uint256 amount);

    /// @notice A deferred payout was delivered to `to`.
    event DeferredClaimed(address indexed to, uint256 amount);

    /// @notice `controller` took the escrowed `shares` back.
    event RedeemRequestCancelled(address indexed controller, uint256 shares);

    event RedeemNoticeSet(uint256 notice);
    event TreasurySet(address indexed treasury);
    event SharesRescued(address indexed to, uint256 shares);

    /// @notice A claim of `controller` was capped at its value at the request; what its shares gained since,
    /// `amount`, went to `treasury`.
    event SurplusToTreasury(address indexed controller, address indexed treasury, uint256 amount);

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
    error ZeroShares();
    error ControllerNotAllowed();
    error NotController();
    error NoRedeemRequest();
    error InsufficientRequest();
    error NoticeNotOver();
    error CoverStillOpen();
    error NoticeInvalid();
    error PreviewUnavailable();
    error ExceedsStrayShares();

    modifier onlyBook() {
        if (msg.sender != book) revert NotBook();
        _;
    }

    /// @param asset_ The dollar token the pool holds.
    /// @param initialOwner Account that sets the caps and wires the book.
    /// @param treasury_ Recipient of the surplus of capped claims.
    /// @param name_ Share token name.
    /// @param symbol_ Share token symbol.
    constructor(IERC20 asset_, address initialOwner, address treasury_, string memory name_, string memory symbol_)
        ERC20(name_, symbol_)
        ERC4626(asset_)
        Ownable(initialOwner)
    {
        _setTreasury(treasury_);
    }

    // ───────────────────────────── exposure (book only) ─────────────────────────────

    /// @inheritdoc ICoverPool
    /// @dev Reverts with `GlobalCapExceeded` or `CellCapExceeded`. Both caps are taken on `activeAssets`,
    /// which leaves out capital that has asked to leave, and both round down.
    function lock(uint256 key, uint256 amount) external onlyBook {
        uint256 assets = activeAssets();
        uint256 locked = lockedExposure + amount;
        if (locked > assets * maxUtilizationBps / BPS) revert GlobalCapExceeded();
        uint256 cell = cellExposure[key] + amount;
        if (cell > assets * maxCellBps / BPS) revert CellCapExceeded();
        lockedExposure = locked;
        cellExposure[key] = cell;
        emit ExposureChanged(key, cell, locked);
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
    function pay(address to, uint256 key, uint256 amount) external nonReentrant onlyBook {
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

    /// @notice Assets that back no open policy. Claims of matured redemption requests are paid out of these.
    function freeAssets() public view returns (uint256) {
        uint256 assets = totalAssets();
        uint256 locked = lockedExposure;
        return assets > locked ? assets - locked : 0;
    }

    /// @notice Assets new cover can be sold against: everything except the capital in redemption escrow.
    /// @dev The retiring part rounds up, so the caps round down.
    function activeAssets() public view returns (uint256) {
        uint256 assets = totalAssets();
        uint256 retiring = _convertToAssets(escrowedShares, Math.Rounding.Ceil);
        return assets > retiring ? assets - retiring : 0;
    }

    /// @notice Deposits `assets` from the caller and mints shares to `receiver`.
    function deposit(uint256 assets, address receiver) public override nonReentrant returns (uint256) {
        return super.deposit(assets, receiver);
    }

    /// @notice Mints exactly `shares` to `receiver`, pulling the required assets from the caller.
    function mint(uint256 shares, address receiver) public override nonReentrant returns (uint256) {
        return super.mint(shares, receiver);
    }

    // ───────────────────────────── leaving the pool ─────────────────────────────

    /// @inheritdoc IERC7540Redeem
    /// @dev Moves `shares` of `owner` into escrow and adds them to the single request of `controller`, which
    /// becomes claimable `redeemNotice` from now, once every policy sold so far is closed. Adding to an
    /// existing request restarts the notice for all of it, re-marks all of it at the current share price and
    /// makes all of it wait for the policies sold until then.
    ///
    /// The caller must be `owner` or hold an allowance over the owner's shares. `controller` must be the owner
    /// or the caller: nobody can add to a stranger's request and so push its claim away.
    /// @return requestId Always zero.
    function requestRedeem(uint256 shares, address controller, address owner)
        external
        nonReentrant
        returns (uint256 requestId)
    {
        if (shares == 0) revert ZeroShares();
        if (controller != owner && controller != msg.sender) revert ControllerNotAllowed();
        if (owner != msg.sender) _spendAllowance(owner, msg.sender, shares);

        _transfer(owner, address(this), shares);
        escrowedShares += shares;

        PendingRedeem storage request = redeemRequests[controller];
        uint256 total = request.shares + shares;
        request.shares = SafeCast.toUint128(total);
        request.assetsAtRequest = SafeCast.toUint128(_convertToAssets(total, Math.Rounding.Floor));
        request.claimableAt = SafeCast.toUint64(block.timestamp + redeemNotice);
        address book_ = book;
        request.lastPolicyAtRequest = book_ == address(0) ? 0 : SafeCast.toUint64(ICoverBook(book_).policyCount());

        emit RedeemRequest(controller, owner, 0, msg.sender, shares);
        return 0;
    }

    /// @notice Takes the caller's whole redemption request out of escrow and returns the shares to them. The
    /// capital counts towards the caps again and earns again; leaving later needs a new request and a new
    /// notice.
    /// @return shares The shares returned.
    function cancelRedeemRequest() external nonReentrant returns (uint256 shares) {
        shares = redeemRequests[msg.sender].shares;
        if (shares == 0) revert NoRedeemRequest();
        delete redeemRequests[msg.sender];
        escrowedShares -= shares;
        _transfer(address(this), msg.sender, shares);
        emit RedeemRequestCancelled(msg.sender, shares);
    }

    /// @inheritdoc IERC7540Redeem
    /// @dev A controller has one request and its id is zero. It is pending until it can be claimed: while the
    /// notice runs and while cover sold before it is open.
    function pendingRedeemRequest(uint256 requestId, address controller) external view returns (uint256) {
        PendingRedeem storage request = redeemRequests[controller];
        return (requestId == 0 && !_claimable(request)) ? request.shares : 0;
    }

    /// @inheritdoc IERC7540Redeem
    function claimableRedeemRequest(uint256 requestId, address controller) external view returns (uint256) {
        PendingRedeem storage request = redeemRequests[controller];
        return (requestId == 0 && _claimable(request)) ? request.shares : 0;
    }

    /// @notice Whether the request of `controller` waits for a policy sold before it to close. A request
    /// made before any policy was sold never does.
    function claimBlockedByCover(address controller) external view returns (bool) {
        return _coverStillOpen(redeemRequests[controller]);
    }

    /// @notice Largest amount of assets `controller` can claim now. Zero while the notice runs or cover sold
    /// before the request is open.
    /// @dev A claim takes what its shares are worth out of `freeAssets`, the surplus of a capped claim
    /// included, so this is what `maxRedeem` shares pay.
    function maxWithdraw(address controller) public view override returns (uint256) {
        PendingRedeem storage request = redeemRequests[controller];
        if (!_claimable(request)) return 0;
        (uint256 worth, uint256 owed) = _requestValues(request);
        uint256 free = freeAssets();
        if (worth <= free) return owed;
        return Math.mulDiv(owed, Math.mulDiv(request.shares, free, worth), request.shares);
    }

    /// @notice Largest number of escrowed shares `controller` can claim now: those whose value fits in
    /// `freeAssets`. Zero while the notice runs or cover sold before the request is open.
    function maxRedeem(address controller) public view override returns (uint256) {
        PendingRedeem storage request = redeemRequests[controller];
        if (!_claimable(request)) return 0;
        (uint256 worth,) = _requestValues(request);
        uint256 free = freeAssets();
        return worth <= free ? request.shares : Math.mulDiv(request.shares, free, worth);
    }

    /// @notice Claims `shares` of the caller's matured redemption request and sends the assets to `receiver`.
    /// @dev Reverts with `NotController` unless the caller is `controller`, `InsufficientRequest` when more is
    /// claimed than was requested, `NoticeNotOver` before the request matures, `CoverStillOpen` while a policy
    /// sold before the request is open and `ExposureLocked` when what the shares are worth exceeds
    /// `freeAssets`. A partial claim leaves the rest claimable; a claim of nothing does nothing.
    /// @return assets The assets paid: the claimed part of the lower of the request's value at the request
    /// and its value now. When the first is lower, the rest of what the shares are worth goes to the
    /// treasury.
    function redeem(uint256 shares, address receiver, address controller)
        public
        override
        nonReentrant
        returns (uint256 assets)
    {
        if (msg.sender != controller) revert NotController();
        if (shares == 0) return 0;
        PendingRedeem storage request = redeemRequests[controller];
        uint256 requested = request.shares;
        if (shares > requested) revert InsufficientRequest();
        if (block.timestamp < request.claimableAt) revert NoticeNotOver();
        if (_coverStillOpen(request)) revert CoverStillOpen();

        (uint256 worth, uint256 owed) = _requestValues(request);
        assets = Math.mulDiv(owed, shares, requested);
        _claim(request, controller, receiver, assets, shares, worth, owed);
    }

    /// @notice Claims exactly `assets` from the caller's matured redemption request and sends them to
    /// `receiver`, burning as many escrowed shares as that takes.
    /// @dev Reverts like `redeem`; `InsufficientRequest` here means the request is worth less than `assets`.
    /// @return shares The escrowed shares burned.
    function withdraw(uint256 assets, address receiver, address controller)
        public
        override
        nonReentrant
        returns (uint256 shares)
    {
        if (msg.sender != controller) revert NotController();
        if (assets == 0) return 0;
        PendingRedeem storage request = redeemRequests[controller];
        (uint256 worth, uint256 owed) = _requestValues(request);
        if (assets > owed) revert InsufficientRequest();
        if (block.timestamp < request.claimableAt) revert NoticeNotOver();
        if (_coverStillOpen(request)) revert CoverStillOpen();

        shares = Math.mulDiv(assets, request.shares, owed, Math.Rounding.Ceil);
        _claim(request, controller, receiver, assets, shares, worth, owed);
    }

    /// @notice Always reverts: a redemption is priced when it is claimed, not when it is requested.
    function previewRedeem(uint256) public pure override returns (uint256) {
        revert PreviewUnavailable();
    }

    /// @notice Always reverts: a redemption is priced when it is claimed, not when it is requested.
    function previewWithdraw(uint256) public pure override returns (uint256) {
        revert PreviewUnavailable();
    }

    /// @inheritdoc IERC165
    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == type(IERC7540Redeem).interfaceId || interfaceId == type(IERC165).interfaceId;
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

        // Assets in before shares out, as in a plain deposit; the reentrancy guard covers the token call.
        IERC20 token = IERC20(asset());
        uint256 balanceBefore = token.balanceOf(address(this));
        // forge-lint: disable-start(reentrancy-no-eth)
        IERC3009(address(token))
            .receiveWithAuthorization(receiver, address(this), assets, validAfter, validBefore, nonce, v, r, s);
        // forge-lint: disable-end(reentrancy-no-eth)
        if (token.balanceOf(address(this)) < balanceBefore + assets) revert DepositNotReceived();

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

    /// @notice Sends `shares` held by the pool beyond the redemption escrow to `to`: shares transferred to the
    /// pool by mistake, which are neither a request nor anyone's claim. The escrow cannot be touched.
    function rescueShares(address to, uint256 shares) external onlyOwner nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        if (shares > balanceOf(address(this)) - escrowedShares) revert ExceedsStrayShares();
        _transfer(address(this), to, shares);
        emit SharesRescued(to, shares);
    }

    /// @notice Sets the recipient of the surplus of capped claims.
    function setTreasury(address treasury_) external onlyOwner {
        _setTreasury(treasury_);
    }

    /// @notice Sets the redemption notice. Once the book is wired it must outlast the book's cover horizon by
    /// `NOTICE_MARGIN`: capital that asks to leave after a sale stays until that cover has ended and been
    /// reported. Requests already made keep the notice they were given.
    function setRedeemNotice(uint64 notice) external onlyOwner {
        if (notice < MIN_REDEEM_NOTICE || notice > MAX_REDEEM_NOTICE) revert NoticeInvalid();
        address book_ = book;
        if (book_ != address(0) && notice < uint256(ICoverBook(book_).maxHorizon()) + NOTICE_MARGIN) {
            revert NoticeInvalid();
        }
        redeemNotice = notice;
        emit RedeemNoticeSet(notice);
    }

    // ───────────────────────────── internals ─────────────────────────────

    /// @dev Whether a policy sold before the request is still open.
    function _coverStillOpen(PendingRedeem storage request) private view returns (bool) {
        uint256 lastPolicy = request.lastPolicyAtRequest;
        return lastPolicy != 0 && ICoverBook(book).oldestOpenId() <= lastPolicy;
    }

    /// @dev Whether the notice is over and the cover sold before the request is closed.
    function _claimable(PendingRedeem storage request) private view returns (bool) {
        return block.timestamp >= request.claimableAt && !_coverStillOpen(request);
    }

    /// @dev What the whole of a request is worth now (`worth`) and what it may be paid (`owed`): no more than
    /// it was worth when it was requested.
    function _requestValues(PendingRedeem storage request) private view returns (uint256 worth, uint256 owed) {
        worth = _convertToAssets(request.shares, Math.Rounding.Floor);
        uint256 atRequest = request.assetsAtRequest;
        owed = worth > atRequest ? atRequest : worth;
    }

    /// @dev Burns `shares` out of escrow, pays `assets` and, when the request is capped (`owed < worth`), sends
    /// the rest of what the shares are worth to the treasury. The caller has checked the controller, the size
    /// of the request, the notice and the cover; `assets` is never more than the shares are worth.
    function _claim(
        PendingRedeem storage request,
        address controller,
        address receiver,
        uint256 assets,
        uint256 shares,
        uint256 worth,
        uint256 owed
    ) private {
        uint256 requested = request.shares;
        // Everything the shares are worth leaves the pool, so all of it has to be free.
        if (worth * shares > freeAssets() * requested) revert ExposureLocked();
        uint256 value = Math.mulDiv(worth, shares, requested);
        uint256 surplus = owed < worth ? value - assets : 0;

        if (shares == requested) {
            delete redeemRequests[controller];
        } else {
            uint256 remaining = requested - shares;
            request.assetsAtRequest = SafeCast.toUint128(Math.mulDiv(request.assetsAtRequest, remaining, requested));
            request.shares = SafeCast.toUint128(remaining);
        }
        escrowedShares -= shares;
        _burn(address(this), shares);

        emit Withdraw(msg.sender, receiver, controller, assets, shares);
        IERC20 token = IERC20(asset());
        token.safeTransfer(receiver, assets);

        if (surplus != 0) {
            address treasury_ = treasury;
            emit SurplusToTreasury(controller, treasury_, surplus);
            // A treasury the token refuses must not hold up the claim: the surplus waits, like a payout.
            if (!token.trySafeTransfer(treasury_, surplus)) {
                deferred[treasury_] += surplus;
                totalDeferred += surplus;
                emit PayoutDeferred(treasury_, surplus);
            }
        }
    }

    function _setTreasury(address treasury_) private {
        if (treasury_ == address(0)) revert ZeroAddress();
        treasury = treasury_;
        emit TreasurySet(treasury_);
    }

    function _reduceExposure(uint256 key, uint256 amount) private {
        uint256 cell = cellExposure[key];
        uint256 locked = lockedExposure;
        if (amount > cell || amount > locked) revert ExposureUnderflow();
        unchecked {
            cell -= amount;
            locked -= amount;
        }
        cellExposure[key] = cell;
        lockedExposure = locked;
        emit ExposureChanged(key, cell, locked);
    }

    function _decimalsOffset() internal pure override returns (uint8) {
        return 6;
    }
}
