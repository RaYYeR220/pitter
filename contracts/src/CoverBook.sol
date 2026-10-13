// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import {ICoverPool} from "./interfaces/ICoverPool.sol";
import {IERC3009} from "./interfaces/IERC3009.sol";
import {IWeatherIndex} from "./interfaces/IWeatherIndex.sol";
import {Quote} from "./Types.sol";

/// @title CoverBook
/// @notice Sells and settles per-minute parametric weather cover.
///
/// A policy covers one key (trigger and cell) over a minute-aligned window `[start, end)` and pays
/// `ratePerSecond` for every second the weather index confirms as wet inside the window, up to
/// `ratePerSecond * (end - start)`. That maximum is reserved in the pool at purchase, so a sale that the pool
/// cannot back reverts instead of creating an unbacked promise. There are no refunds and no cancellations.
///
/// Prices come from the underwriter key as EIP-712 quotes. A quote can be used once.
///
/// @dev Invariants:
/// - the pool's `lockedExposure` equals the sum of `maxPayout - paid` over open policies, and the same holds
///   per key for `cellExposure`;
/// - a policy is never paid more than its maximum payout, and never for time the index has not reported;
/// - `settledUntil` only moves forward and never passes `end`;
/// - a key is in the active set exactly while it has an open policy.
contract CoverBook is EIP712, Ownable2Step, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;
    using EnumerableSet for EnumerableSet.UintSet;

    struct Policy {
        address holder;
        uint64 start;
        bool closed;
        uint256 key;
        uint128 ratePerSecond;
        uint128 premium;
        uint128 paid;
        uint64 end;
        uint64 settledUntil;
    }

    /// @notice EIP-712 type hash of a quote.
    bytes32 public constant QUOTE_TYPEHASH = keccak256(
        "Quote(address holder,uint256 key,uint64 start,uint64 end,uint128 ratePerSecond,uint128 premium,uint64 expiry,bytes32 salt)"
    );

    /// @notice Highest fee the owner can set, in basis points of the premium.
    uint16 public constant MAX_FEE_BPS = 2000;

    /// @notice Shortest grace period the owner can set before an unfinished policy may be expired.
    uint64 public constant MIN_EXPIRY_GRACE = 1 hours;

    uint256 private constant BPS = 10_000;
    uint64 private constant MINUTE = 60;

    /// @notice The dollar token premiums and payouts are made in.
    IERC20 public immutable token;

    /// @notice The pool that backs the policies.
    ICoverPool public immutable pool;

    /// @notice The weather index policies settle against.
    IWeatherIndex public immutable index;

    /// @notice Key that signs quotes.
    address public underwriter;

    /// @notice Minimum time between a purchase and the start of its window, in seconds.
    uint64 public minLead;

    /// @notice Largest number of keys that may have open policies at once.
    uint32 public maxActiveCells = 64;

    /// @notice Recipient of the protocol fee.
    address public treasury;

    /// @notice Share of every premium sent to the treasury, in basis points.
    uint16 public feeBps = 500;

    /// @notice Shortest window that can be bought, in seconds.
    uint64 public minDuration = 60;

    /// @notice Longest window that can be bought, in seconds.
    uint64 public maxDuration = 12 hours;

    /// @notice Sales stop when the index heartbeat is older than this, in seconds.
    uint64 public maxOracleAge = 20 minutes;

    /// @notice Time after a window's end at which the policy may be closed without the index having reported
    /// the rest of the window.
    uint64 public expiryGrace = 24 hours;

    /// @notice Largest maximum payout a single policy may have.
    uint256 public maxPolicyPayout;

    /// @notice Smallest premium a policy can be sold for. Every policy holds a place among the active cells
    /// until it is settled, so a floor puts a price on occupying them.
    uint128 public minPremium;

    /// @notice Number of policies ever sold. Policy ids run from 1 to this value.
    uint256 public policyCount;

    /// @notice Whether a quote digest has been used.
    mapping(bytes32 digest => bool) public quoteUsed;

    /// @notice Number of open policies for a key.
    mapping(uint256 key => uint256) public openPolicies;

    mapping(uint256 id => Policy) private _policies;
    EnumerableSet.UintSet private _activeCells;

    event PolicyBought(
        uint256 indexed id,
        address indexed holder,
        uint256 indexed key,
        uint64 start,
        uint64 end,
        uint128 ratePerSecond,
        uint128 premium,
        uint256 maxPayout
    );

    /// @notice A policy was settled up to `settledUntil`, paying `paid`. `closed` is set on the last settlement.
    event PolicySettled(uint256 indexed id, address indexed holder, uint256 paid, uint64 settledUntil, bool closed);

    event UnderwriterSet(address indexed underwriter);
    event TreasurySet(address indexed treasury);
    event FeeSet(uint256 feeBps);
    event MinLeadSet(uint256 minLead);
    event DurationBoundsSet(uint256 minDuration, uint256 maxDuration);
    event MaxPolicyPayoutSet(uint256 maxPolicyPayout);
    event MinPremiumSet(uint256 minPremium);
    event MaxOracleAgeSet(uint256 maxOracleAge);
    event MaxActiveCellsSet(uint256 maxActiveCells);
    event ExpiryGraceSet(uint256 expiryGrace);

    error QuoteExpired();
    error BadQuoteSignature();
    error QuoteUsed();
    error WindowInvalid();
    error LeadTooShort();
    error PolicyTooLarge();
    error PremiumTooSmall();
    error OracleStale();
    error TooManyCells();
    error PremiumNotReceived();
    error PolicyUnknown();
    error ExpiryNotReached();
    error ZeroAddress();
    error ConfigInvalid();

    /// @param token_ The dollar token (ERC-20 with ERC-3009).
    /// @param pool_ The pool that backs the policies; it must name this contract as its book.
    /// @param index_ The weather index.
    /// @param underwriter_ Key that signs quotes.
    /// @param treasury_ Recipient of the protocol fee.
    /// @param minLead_ Minimum time between a purchase and the start of its window.
    /// @param maxPolicyPayout_ Largest maximum payout a single policy may have.
    /// @param initialOwner Account that manages the configuration.
    constructor(
        IERC20 token_,
        ICoverPool pool_,
        IWeatherIndex index_,
        address underwriter_,
        address treasury_,
        uint64 minLead_,
        uint256 maxPolicyPayout_,
        address initialOwner
    ) EIP712("Cover", "1") Ownable(initialOwner) {
        if (
            address(token_) == address(0) || address(pool_) == address(0) || address(index_) == address(0)
                || underwriter_ == address(0) || treasury_ == address(0)
        ) revert ZeroAddress();
        if (maxPolicyPayout_ > type(uint128).max) revert ConfigInvalid();

        token = token_;
        pool = pool_;
        index = index_;
        underwriter = underwriter_;
        treasury = treasury_;
        minLead = minLead_;
        maxPolicyPayout = maxPolicyPayout_;
    }

    // ───────────────────────────── purchase ─────────────────────────────

    /// @notice Buys the policy described by `q`, with the caller paying the premium through an allowance.
    /// The policy belongs to `q.holder`, who need not be the caller.
    /// @param q Quote signed by the underwriter.
    /// @param quoteSig The underwriter's signature over `hashQuote(q)` (ECDSA or ERC-1271).
    /// @return id The new policy id.
    function buy(Quote calldata q, bytes calldata quoteSig) external nonReentrant returns (uint256 id) {
        id = _open(q, hashQuote(q), quoteSig);

        (uint256 fee, uint256 net) = _split(q.premium);
        if (fee != 0) token.safeTransferFrom(msg.sender, treasury, fee);
        if (net != 0) token.safeTransferFrom(msg.sender, address(pool), net);
    }

    /// @notice Buys the policy described by `q`, with `q.holder` paying the premium through an ERC-3009
    /// authorization. Anyone may submit it, so a relayer can pay the gas.
    /// @dev The authorization's nonce must be `hashQuote(q)`: the holder's one signature both pays the premium
    /// and commits to these exact terms, and it cannot be spent on anything else. Whoever submits it, the
    /// outcome is the policy the holder signed for.
    /// @param q Quote signed by the underwriter.
    /// @param quoteSig The underwriter's signature over `hashQuote(q)` (ECDSA or ERC-1271).
    /// @param validAfter Authorization validity start.
    /// @param validBefore Authorization validity end.
    /// @return id The new policy id.
    function buyWithAuthorization(
        Quote calldata q,
        bytes calldata quoteSig,
        uint256 validAfter,
        uint256 validBefore,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external nonReentrant returns (uint256 id) {
        bytes32 digest = hashQuote(q);
        id = _open(q, digest, quoteSig);

        uint256 balanceBefore = token.balanceOf(address(this));
        IERC3009(address(token))
            .receiveWithAuthorization(q.holder, address(this), q.premium, validAfter, validBefore, digest, v, r, s);
        if (token.balanceOf(address(this)) < balanceBefore + q.premium) revert PremiumNotReceived();

        (uint256 fee, uint256 net) = _split(q.premium);
        if (fee != 0) token.safeTransfer(treasury, fee);
        if (net != 0) token.safeTransfer(address(pool), net);
    }

    // ───────────────────────────── settlement ─────────────────────────────

    /// @notice Pays the holder of policy `id` for the wet seconds the index has confirmed since the last
    /// settlement, and closes the policy once its whole window is settled. Anyone may call.
    /// @dev Does nothing and returns zero when there is no newly reported time or the policy is closed.
    /// @return paid Amount paid to the holder by this call.
    function settle(uint256 id) external nonReentrant returns (uint256 paid) {
        return _settle(id, false);
    }

    /// @notice Settles several policies in one transaction. Closed policies are skipped.
    function settleMany(uint256[] calldata ids) external nonReentrant {
        uint256 count = ids.length;
        for (uint256 i = 0; i < count; ++i) {
            _settle(ids[i], false);
        }
    }

    /// @notice Closes policy `id` once `expiryGrace` has passed since the end of its window, even if the index
    /// never reported the rest of the window. Whatever the index did confirm is paid first; the remaining
    /// exposure is released back to the pool. Anyone may call.
    /// @dev Reverts with `ExpiryNotReached` before `end + expiryGrace`. Does nothing for a closed policy.
    function expire(uint256 id) external nonReentrant {
        _settle(id, true);
    }

    // ───────────────────────────── views ─────────────────────────────

    /// @notice Amount `settle(id)` would pay right now.
    function claimable(uint256 id) external view returns (uint256) {
        Policy storage p = _policies[id];
        if (p.closed) return 0;
        uint64 settledUntil = p.settledUntil;
        uint64 upTo = _confirmedUntil(p.key, p.end);
        if (upTo <= settledUntil) return 0;
        return _payout(p, settledUntil, upTo, _maxPayout(p) - p.paid);
    }

    /// @notice The policy with the given id. All fields are zero for an id that was never sold.
    /// @return holder Recipient of the payouts.
    /// @return key Insured trigger and cell.
    /// @return start Window start.
    /// @return end Window end (exclusive).
    /// @return ratePerSecond Payout per confirmed wet second.
    /// @return premium Premium paid.
    /// @return maxPayout `ratePerSecond * (end - start)`.
    /// @return paid Total paid out so far.
    /// @return settledUntil Timestamp up to which the window has been settled.
    /// @return closed Whether the policy is finished and its exposure released.
    function policies(uint256 id)
        external
        view
        returns (
            address holder,
            uint256 key,
            uint64 start,
            uint64 end,
            uint128 ratePerSecond,
            uint128 premium,
            uint256 maxPayout,
            uint256 paid,
            uint64 settledUntil,
            bool closed
        )
    {
        Policy storage p = _policies[id];
        return
            (
                p.holder,
                p.key,
                p.start,
                p.end,
                p.ratePerSecond,
                p.premium,
                _maxPayout(p),
                p.paid,
                p.settledUntil,
                p.closed
            );
    }

    /// @notice Keys that currently have at least one open policy. The oracle reports these.
    function activeCells() external view returns (uint256[] memory keys) {
        return _activeCells.values();
    }

    /// @notice EIP-712 digest of a quote: what the underwriter signs, and the ERC-3009 nonce the holder uses
    /// in `buyWithAuthorization`.
    function hashQuote(Quote calldata q) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(QUOTE_TYPEHASH, q)));
    }

    /// @notice EIP-712 domain separator of this book (`name` "Cover", `version` "1").
    function DOMAIN_SEPARATOR() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    // ───────────────────────────── administration ─────────────────────────────

    /// @notice Replaces the quote signer. Quotes signed by the previous key stop being accepted.
    function setUnderwriter(address underwriter_) external onlyOwner {
        if (underwriter_ == address(0)) revert ZeroAddress();
        underwriter = underwriter_;
        emit UnderwriterSet(underwriter_);
    }

    /// @notice Sets the recipient of the protocol fee.
    function setTreasury(address treasury_) external onlyOwner {
        if (treasury_ == address(0)) revert ZeroAddress();
        treasury = treasury_;
        emit TreasurySet(treasury_);
    }

    /// @notice Sets the protocol fee, at most `MAX_FEE_BPS`.
    function setFeeBps(uint16 feeBps_) external onlyOwner {
        if (feeBps_ > MAX_FEE_BPS) revert ConfigInvalid();
        feeBps = feeBps_;
        emit FeeSet(feeBps_);
    }

    /// @notice Sets the minimum time between a purchase and the start of its window.
    function setMinLead(uint64 minLead_) external onlyOwner {
        minLead = minLead_;
        emit MinLeadSet(minLead_);
    }

    /// @notice Sets the shortest and longest window that can be bought.
    function setDurationBounds(uint64 minDuration_, uint64 maxDuration_) external onlyOwner {
        if (minDuration_ < MINUTE || minDuration_ > maxDuration_) revert ConfigInvalid();
        minDuration = minDuration_;
        maxDuration = maxDuration_;
        emit DurationBoundsSet(minDuration_, maxDuration_);
    }

    /// @notice Sets the largest maximum payout of a single policy. Zero stops sales.
    function setMaxPolicyPayout(uint256 maxPolicyPayout_) external onlyOwner {
        if (maxPolicyPayout_ > type(uint128).max) revert ConfigInvalid();
        maxPolicyPayout = maxPolicyPayout_;
        emit MaxPolicyPayoutSet(maxPolicyPayout_);
    }

    /// @notice Sets the smallest premium a policy can be sold for. Zero removes the floor.
    function setMinPremium(uint128 minPremium_) external onlyOwner {
        minPremium = minPremium_;
        emit MinPremiumSet(minPremium_);
    }

    /// @notice Sets how old the index heartbeat may be before sales stop.
    function setMaxOracleAge(uint64 maxOracleAge_) external onlyOwner {
        if (maxOracleAge_ == 0) revert ConfigInvalid();
        maxOracleAge = maxOracleAge_;
        emit MaxOracleAgeSet(maxOracleAge_);
    }

    /// @notice Sets how many keys may have open policies at once. Keys that are already active stay active.
    function setMaxActiveCells(uint32 maxActiveCells_) external onlyOwner {
        maxActiveCells = maxActiveCells_;
        emit MaxActiveCellsSet(maxActiveCells_);
    }

    /// @notice Sets the grace period before an unfinished policy may be expired, at least `MIN_EXPIRY_GRACE`.
    function setExpiryGrace(uint64 expiryGrace_) external onlyOwner {
        if (expiryGrace_ < MIN_EXPIRY_GRACE) revert ConfigInvalid();
        expiryGrace = expiryGrace_;
        emit ExpiryGraceSet(expiryGrace_);
    }

    // ───────────────────────────── internals ─────────────────────────────

    /// @dev Validates the quote, records the policy and reserves its maximum payout in the pool. The caller
    /// collects the premium afterwards; if that fails the whole purchase reverts.
    function _open(Quote calldata q, bytes32 digest, bytes calldata quoteSig) private returns (uint256 id) {
        if (block.timestamp > q.expiry) revert QuoteExpired();
        if (!SignatureChecker.isValidSignatureNowCalldata(underwriter, digest, quoteSig)) revert BadQuoteSignature();
        if (quoteUsed[digest]) revert QuoteUsed();
        if (q.holder == address(0)) revert ZeroAddress();

        if (q.start % MINUTE != 0 || q.end % MINUTE != 0 || q.end <= q.start) revert WindowInvalid();
        uint64 duration = q.end - q.start;
        if (duration < minDuration || duration > maxDuration) revert WindowInvalid();

        if (q.start < block.timestamp + minLead) revert LeadTooShort();

        uint256 maxPayout = uint256(q.ratePerSecond) * duration;
        if (maxPayout > maxPolicyPayout) revert PolicyTooLarge();
        if (q.premium < minPremium) revert PremiumTooSmall();

        if (block.timestamp > uint256(index.heartbeat()) + maxOracleAge) revert OracleStale();

        if (openPolicies[q.key] == 0) {
            if (_activeCells.length() >= maxActiveCells) revert TooManyCells();
            _activeCells.add(q.key);
        }
        ++openPolicies[q.key];

        quoteUsed[digest] = true;
        id = ++policyCount;
        _policies[id] = Policy({
            holder: q.holder,
            start: q.start,
            closed: false,
            key: q.key,
            ratePerSecond: q.ratePerSecond,
            premium: q.premium,
            paid: 0,
            end: q.end,
            settledUntil: q.start
        });
        emit PolicyBought(id, q.holder, q.key, q.start, q.end, q.ratePerSecond, q.premium, maxPayout);

        pool.lock(q.key, maxPayout);
    }

    /// @dev Settles policy `id` up to the latest confirmed time. With `expiring` set the policy is closed
    /// regardless of how much of its window was confirmed, provided the grace period is over.
    ///
    /// Effects first, then the pool calls: by the time money moves the policy already reflects it.
    function _settle(uint256 id, bool expiring) private returns (uint256 paid) {
        if (id == 0 || id > policyCount) revert PolicyUnknown();
        Policy storage p = _policies[id];
        if (p.closed) return 0;

        uint256 key = p.key;
        uint64 end = p.end;
        if (expiring && block.timestamp < uint256(end) + expiryGrace) revert ExpiryNotReached();

        uint64 settledUntil = p.settledUntil;
        uint64 upTo = _confirmedUntil(key, end);
        uint256 remaining = _maxPayout(p) - p.paid;

        if (upTo > settledUntil) {
            paid = _payout(p, settledUntil, upTo, remaining);
            settledUntil = upTo;
            p.settledUntil = upTo;
            if (paid != 0) p.paid += SafeCast.toUint128(paid);
        } else if (!expiring) {
            return 0;
        }

        bool closing = expiring || settledUntil == end;
        if (closing) {
            p.closed = true;
            if (--openPolicies[key] == 0) _activeCells.remove(key);
        }
        address holder = p.holder;
        emit PolicySettled(id, holder, paid, settledUntil, closing);

        if (paid != 0) pool.pay(holder, key, paid);
        if (closing && remaining != paid) pool.release(key, remaining - paid);
    }

    /// @dev Latest timestamp a policy for `key` ending at `end` can be settled to: time that has passed, is
    /// inside the window and has been reported by the index.
    function _confirmedUntil(uint256 key, uint64 end) private view returns (uint64 upTo) {
        upTo = index.lastTo(key);
        if (upTo > end) upTo = end;
        if (upTo > block.timestamp) upTo = SafeCast.toUint64(block.timestamp);
    }

    /// @dev Payout for the wet seconds confirmed in `[from, to]`, never more than `remaining`. The index
    /// rounds wet seconds down, and cannot report more than elapsed time, so the cap only binds if the index
    /// misbehaves.
    function _payout(Policy storage p, uint64 from, uint64 to, uint256 remaining) private view returns (uint256) {
        uint256 amount = index.wetSeconds(p.key, from, to) * p.ratePerSecond;
        return amount > remaining ? remaining : amount;
    }

    /// @dev Splits a premium into the treasury fee and the pool's part. The fee rounds down.
    function _split(uint256 premium) private view returns (uint256 fee, uint256 net) {
        fee = premium * feeBps / BPS;
        net = premium - fee;
    }

    function _maxPayout(Policy storage p) private view returns (uint256) {
        return uint256(p.ratePerSecond) * (p.end - p.start);
    }
}
