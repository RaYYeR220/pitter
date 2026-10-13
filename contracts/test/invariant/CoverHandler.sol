// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {CoverBook} from "../../src/CoverBook.sol";
import {CoverPool} from "../../src/CoverPool.sol";
import {Quote, Reading} from "../../src/Types.sol";
import {WeatherIndex} from "../../src/WeatherIndex.sol";
import {BlockableDollar} from "../mocks/BlockableDollar.sol";
import {Signing} from "../utils/Signing.sol";

/// @dev Drives the whole system with bounded random actions: purchases on both payment paths (inside, at and
/// beyond the cover horizon), replays of used quotes, oracle reports (genuine and forged), settlements,
/// expiries, LP deposits, redemption requests, cancellations and claims, direct donations, issuer blocks on
/// holders and clock movement.
///
/// Every action either must succeed or may only be refused for a reason the handler has checked. Anything
/// else is counted in a ghost counter that the invariants require to stay at zero.
contract CoverHandler is Signing {
    struct Purchase {
        Quote quote;
        bytes quoteSig;
        uint256 validBefore;
        uint8 v;
        bytes32 r;
        bytes32 s;
    }

    BlockableDollar internal immutable dollar;
    WeatherIndex internal immutable index;
    CoverPool internal immutable pool;
    CoverBook internal immutable book;
    address internal immutable owner;
    uint256 internal immutable underwriterKey;
    uint256 internal immutable reporterKey;

    address internal relayer = makeAddr("handler relayer");
    address internal keeper = makeAddr("handler keeper");
    address internal donor = makeAddr("handler donor");
    uint256 internal forgerKey = uint256(keccak256("handler forger"));

    uint256 public constant HOLDER_FUNDS = 1_000_000e6;
    uint256 public constant LP_FUNDS = 1_000_000e6;

    address[] public holders;
    mapping(address holder => uint256) internal holderKeys;
    address[] public lps;
    mapping(address lp => uint256) internal lpKeys;
    uint256[] public keys;

    Purchase[] internal purchases;
    uint256 internal salt;

    // Ghost accounting.
    mapping(uint256 id => uint256) public paidTo;
    mapping(address holder => uint256) public premiumsPaid;
    mapping(address holder => uint256) public payoutsOwed;
    mapping(uint256 id => uint256) public boughtAt;
    mapping(address lp => uint256) public requestedAt;

    // Counters that must stay at zero.
    uint256 public unexpectedReverts;
    uint256 public unjustifiedRefusals;
    uint256 public capBreaches;
    uint256 public horizonBreaches;
    uint256 public replaysAccepted;
    uint256 public forgeriesAccepted;
    uint256 public earlyExpiries;
    uint256 public overWithdrawals;
    uint256 public earlyClaims;
    uint256 public claimsAheadOfCover;
    uint256 public overpaidClaims;
    uint256 public surplusLeftBehind;
    uint256 public claimableMismatches;

    // Activity counters.
    uint256 public bought;
    uint256 public refused;
    uint256 public reports;
    uint256 public settlements;
    uint256 public expiries;
    uint256 public deferrals;
    uint256 public capProbes;
    uint256 public horizonProbes;
    uint256 public refusedTooFar;
    uint256 public requests;
    uint256 public cancellations;
    uint256 public claims;

    constructor(
        BlockableDollar dollar_,
        WeatherIndex index_,
        CoverPool pool_,
        CoverBook book_,
        address owner_,
        uint256 underwriterKey_,
        uint256 reporterKey_
    ) {
        dollar = dollar_;
        index = index_;
        pool = pool_;
        book = book_;
        owner = owner_;
        underwriterKey = underwriterKey_;
        reporterKey = reporterKey_;

        for (uint256 i = 0; i < 3; ++i) {
            (address holder, uint256 key) = makeAddrAndKey(string.concat("handler holder ", vm.toString(i)));
            holders.push(holder);
            holderKeys[holder] = key;
            vm.prank(owner_);
            dollar_.mint(holder, HOLDER_FUNDS);
            vm.prank(holder);
            dollar_.approve(address(book_), type(uint256).max);
        }
        for (uint256 i = 0; i < 2; ++i) {
            (address lp, uint256 key) = makeAddrAndKey(string.concat("handler lp ", vm.toString(i)));
            lps.push(lp);
            lpKeys[lp] = key;
            vm.prank(owner_);
            dollar_.mint(lp, LP_FUNDS);
            vm.prank(lp);
            dollar_.approve(address(pool_), type(uint256).max);
        }
        vm.prank(owner_);
        dollar_.mint(donor, LP_FUNDS);
        for (uint256 i = 0; i < 4; ++i) {
            keys.push((uint256(1) << 64) | (uint256(1000 + i) << 32) | 400);
        }
    }

    function holderCount() external view returns (uint256) {
        return holders.length;
    }

    function lpCount() external view returns (uint256) {
        return lps.length;
    }

    function keyCount() external view returns (uint256) {
        return keys.length;
    }

    function _now() internal view returns (uint64) {
        return uint64(vm.getBlockTimestamp());
    }

    // ───────────────────────────── clock ─────────────────────────────

    function warp(uint256 delta) external {
        vm.warp(_now() + bound(delta, 1, 15 minutes));
    }

    function warpFar(uint256 delta) external {
        vm.warp(_now() + bound(delta, 30 minutes, 3 hours));
    }

    // ───────────────────────────── oracle ─────────────────────────────

    /// @dev Reports are issued at the current second; the clock ticks forward when that second is taken.
    function _issue(Reading[] memory readings, uint256 signerKey) internal returns (bytes memory) {
        if (index.lastIssuedAt() >= _now()) vm.warp(uint256(index.lastIssuedAt()) + 1);
        return _signedReport(signerKey, index.DOMAIN_SEPARATOR(), readings, _now());
    }

    function heartbeat() public {
        index.submit(_issue(new Reading[](0), reporterKey));
        ++reports;
    }

    function report(uint256 keySeed, uint256 shapeSeed, uint256 wetSeed) external {
        uint256 key = keys[keySeed % keys.length];
        bytes memory payload = _issue(_nextReading(key, shapeSeed, wetSeed), reporterKey);
        vm.prank(keeper);
        index.submit(payload);
        ++reports;
    }

    /// @dev A report nobody with the reporter key signed must never be accepted.
    function forgeReport(uint256 keySeed, uint256 shapeSeed) external {
        uint256 key = keys[keySeed % keys.length];
        Reading[] memory readings = _nextReading(key, shapeSeed, type(uint256).max);
        bytes memory payload = _signedReport(forgerKey, index.DOMAIN_SEPARATOR(), readings, _now() + 1);
        try index.submit(payload) {
            ++forgeriesAccepted;
        } catch {}
    }

    /// @dev The next valid reading for `key`: it ends now and starts at the last reported time, occasionally
    /// after a gap, with seed-chosen wetness (all of it when `wetSeed` is the maximum).
    function _nextReading(uint256 key, uint256 shapeSeed, uint256 wetSeed) internal returns (Reading[] memory) {
        uint64 last = index.lastTo(key);
        if (last >= _now()) vm.warp(uint256(last) + 1);
        uint64 nowTs = _now();

        uint64 from;
        if (last == 0) from = nowTs - uint64(1 + shapeSeed % 600);
        else if (shapeSeed % 4 == 0) from = last + uint64((shapeSeed >> 8) % (nowTs - last));
        else if (shapeSeed % 4 == 1) from = last - uint64((shapeSeed >> 8) % 60);
        else from = last;

        uint64 effectiveFrom = (last == 0 || from > last) ? from : last;
        uint64 span = nowTs - effectiveFrom;
        uint32 wet;
        if (wetSeed == type(uint256).max || wetSeed % 4 == 0) wet = uint32(span);
        else if (wetSeed % 4 == 1) wet = 0;
        else wet = uint32((wetSeed >> 8) % (span + 1));

        return _readings(Reading(key, from, nowTs, wet));
    }

    // ───────────────────────────── purchases ─────────────────────────────

    function buy(
        uint256 holderSeed,
        uint256 keySeed,
        uint256 delaySeed,
        uint256 minutesSeed,
        uint256 rateSeed,
        uint256 premiumSeed,
        bool viaAuthorization,
        bool refreshOracle
    ) external {
        if (refreshOracle && _oracleStale()) heartbeat();

        uint64 start = (_now() + 59) / 60 * 60 + 60 * uint64(delaySeed % 6);
        uint64 duration = 60 * uint64(1 + minutesSeed % 90);
        _attempt(
            Quote({
                holder: holders[holderSeed % holders.length],
                key: keys[keySeed % keys.length],
                start: start,
                end: start + duration,
                ratePerSecond: uint128(bound(rateSeed, 1, book.maxPolicyPayout() / duration)),
                premium: uint128(bound(premiumSeed, 0, 20e6)),
                expiry: _now() + 5 minutes,
                salt: bytes32(++salt)
            }),
            viaAuthorization
        );
    }

    /// @dev Asks for a policy just larger than the cell can still take. It must be refused, also when the pool
    /// holds plenty of capital that is on its way out.
    function buyAboveTheCellCap(uint256 holderSeed, uint256 keySeed, uint256 excessSeed, bool viaAuthorization)
        external
    {
        if (_oracleStale()) heartbeat();

        uint256 key = keys[keySeed % keys.length];
        uint256 cap = pool.activeAssets() * pool.maxCellBps() / 10_000;
        uint256 used = pool.cellExposure(key);
        uint64 duration = 1 hours;
        uint256 rate = (cap > used ? cap - used : 0) / duration + 1 + excessSeed % 100;
        // Above the book's own size limit the refusal would say nothing about the pool.
        if (rate * duration > book.maxPolicyPayout()) return;

        uint64 start = (_now() + 59) / 60 * 60;
        ++capProbes;
        _attempt(
            Quote({
                holder: holders[holderSeed % holders.length],
                key: key,
                start: start,
                end: start + duration,
                ratePerSecond: uint128(rate),
                premium: 1e6,
                expiry: _now() + 5 minutes,
                salt: bytes32(++salt)
            }),
            viaAuthorization
        );
    }

    /// @dev Asks for a window that ends in the last minute the horizon allows, or one or two minutes past it.
    /// Only the first may be sold.
    function buyAtTheHorizon(
        uint256 holderSeed,
        uint256 keySeed,
        uint256 minutesSeed,
        uint256 beyondSeed,
        bool viaAuthorization
    ) external {
        if (_oracleStale()) heartbeat();

        uint64 horizon = book.maxHorizon();
        uint64 end = (_now() + horizon) / 60 * 60 + 60 * uint64(beyondSeed % 3);
        // A minute short of the horizon at most, so that the window starts in the future.
        uint64 duration = 60 * uint64(1 + minutesSeed % (horizon / 60 - 1));
        ++horizonProbes;
        _attempt(
            Quote({
                holder: holders[holderSeed % holders.length],
                key: keys[keySeed % keys.length],
                start: end - duration,
                end: end,
                ratePerSecond: 1,
                premium: 1e6,
                expiry: _now() + 5 minutes,
                salt: bytes32(++salt)
            }),
            viaAuthorization
        );
    }

    function _tooFar(Quote memory quote) internal view returns (bool) {
        return quote.end > _now() + book.maxHorizon();
    }

    /// @dev Submits a purchase and checks the outcome against the state it met: a sale must end within the
    /// horizon and fit under both caps of the active assets, and a refusal must have a cause.
    function _attempt(Quote memory quote, bool viaAuthorization) internal {
        address holder = quote.holder;
        Purchase memory p;
        p.quote = quote;
        bytes32 digest = _quoteDigest(book.DOMAIN_SEPARATOR(), p.quote);
        p.quoteSig = _signDigest(underwriterKey, digest);
        p.validBefore = p.quote.expiry;
        (p.v, p.r, p.s) = _signReceiveAuthorization(
            holderKeys[holder],
            dollar.DOMAIN_SEPARATOR(),
            Authorization(holder, address(book), p.quote.premium, 0, p.validBefore, digest)
        );

        uint256 maxPayout = uint256(p.quote.ratePerSecond) * (p.quote.end - p.quote.start);
        uint256 assetsBefore = pool.activeAssets();
        uint256 lockedBefore = pool.lockedExposure();
        uint256 cellBefore = pool.cellExposure(p.quote.key);
        bool stale = _oracleStale();

        bool ok;
        bytes memory err;
        if (viaAuthorization) {
            vm.prank(relayer);
            try book.buyWithAuthorization(p.quote, p.quoteSig, 0, p.validBefore, p.v, p.r, p.s) returns (uint256 id) {
                ok = id == book.policyCount();
            } catch (bytes memory reason) {
                err = reason;
            }
        } else {
            vm.prank(holder);
            try book.buy(p.quote, p.quoteSig) returns (uint256 id) {
                ok = id == book.policyCount();
            } catch (bytes memory reason) {
                err = reason;
            }
        }

        if (ok) {
            ++bought;
            purchases.push(p);
            premiumsPaid[holder] += p.quote.premium;
            boughtAt[book.policyCount()] = _now();
            if (_tooFar(p.quote)) ++horizonBreaches;
            // The caps hold against the active assets the pool had when the exposure was locked.
            if (
                lockedBefore + maxPayout > assetsBefore * pool.maxUtilizationBps() / 10_000
                    || cellBefore + maxPayout > assetsBefore * pool.maxCellBps() / 10_000
            ) ++capBreaches;
            return;
        }

        ++refused;
        bytes4 selector = err.length >= 4 ? bytes4(err) : bytes4(0);
        if (selector == CoverBook.WindowTooFar.selector) {
            ++refusedTooFar;
            if (!_tooFar(p.quote)) ++unjustifiedRefusals;
        } else if (selector == CoverBook.OracleStale.selector) {
            if (!stale) ++unjustifiedRefusals;
        } else if (selector == CoverPool.GlobalCapExceeded.selector) {
            if (lockedBefore + maxPayout <= assetsBefore * pool.maxUtilizationBps() / 10_000) ++unjustifiedRefusals;
        } else if (selector == CoverPool.CellCapExceeded.selector) {
            if (cellBefore + maxPayout <= assetsBefore * pool.maxCellBps() / 10_000) ++unjustifiedRefusals;
        } else if (selector == BlockableDollar.AccountBlocked.selector) {
            if (!dollar.blocked(holder)) ++unjustifiedRefusals;
        } else {
            ++unexpectedReverts;
        }
    }

    /// @dev A quote that already produced a policy must be refused on both payment paths.
    function replay(uint256 purchaseSeed, bool viaAuthorization) external {
        if (purchases.length == 0) return;
        Purchase memory p = purchases[purchaseSeed % purchases.length];

        if (viaAuthorization) {
            vm.prank(relayer);
            try book.buyWithAuthorization(p.quote, p.quoteSig, 0, p.validBefore, p.v, p.r, p.s) {
                ++replaysAccepted;
            } catch {}
        } else {
            vm.prank(p.quote.holder);
            try book.buy(p.quote, p.quoteSig) {
                ++replaysAccepted;
            } catch {}
        }
    }

    // ───────────────────────────── settlement ─────────────────────────────

    function settle(uint256 idSeed) external {
        uint256 count = book.policyCount();
        if (count == 0) return;
        uint256 id = 1 + idSeed % count;
        (address holder,,,,,,,,,) = book.policies(id);
        uint256 expected = book.claimable(id);
        uint256 deferredBefore = pool.deferred(holder);

        vm.prank(keeper);
        uint256 paid = book.settle(id);

        if (paid != expected) ++claimableMismatches;
        if (pool.deferred(holder) != deferredBefore) ++deferrals;
        _recordPayout(id, holder, paid);
        ++settlements;
    }

    function settleMany(uint256 idSeed, uint256 lengthSeed) external {
        uint256 count = book.policyCount();
        if (count == 0) return;
        uint256[] memory ids = new uint256[](1 + lengthSeed % 5);
        for (uint256 i = 0; i < ids.length; ++i) {
            ids[i] = 1 + uint256(keccak256(abi.encode(idSeed, i))) % count;
        }

        vm.prank(keeper);
        book.settleMany(ids);

        // Whatever each policy gained is its payout; an id listed twice gains nothing the second time.
        for (uint256 i = 0; i < ids.length; ++i) {
            (address holder,,,,,,, uint256 paidAfter,,) = book.policies(ids[i]);
            _recordPayout(ids[i], holder, paidAfter - paidTo[ids[i]]);
        }
        ++settlements;
    }

    function expire(uint256 idSeed) external {
        uint256 count = book.policyCount();
        if (count == 0) return;
        uint256 id = 1 + idSeed % count;
        (address holder,,, uint64 end,,,, uint256 paidBefore,, bool closed) = book.policies(id);

        if (!closed && _now() < uint256(end) + book.expiryGrace()) {
            try book.expire(id) {
                ++earlyExpiries;
            } catch {}
            return;
        }

        book.expire(id);
        (,,,,,,, uint256 paidAfter,, bool closedAfter) = book.policies(id);
        if (!closedAfter) ++unexpectedReverts;
        _recordPayout(id, holder, paidAfter - paidBefore);
        if (!closed) ++expiries;
    }

    function syncOldestOpen(uint256 steps) external {
        book.syncOldestOpen(bound(steps, 0, 64));
    }

    function _recordPayout(uint256 id, address holder, uint256 paid) internal {
        paidTo[id] += paid;
        payoutsOwed[holder] += paid;
    }

    // ───────────────────────────── liquidity ─────────────────────────────

    function deposit(uint256 lpSeed, uint256 amount, bool viaAuthorization) external {
        address lp = lps[lpSeed % lps.length];
        amount = bound(amount, 0, dollar.balanceOf(lp) / 4);
        if (viaAuthorization) {
            Authorization memory a = Authorization(lp, address(pool), amount, 0, _now() + 1 hours, bytes32(++salt));
            (uint8 v, bytes32 r, bytes32 s) = _signReceiveAuthorization(lpKeys[lp], dollar.DOMAIN_SEPARATOR(), a);
            vm.prank(relayer);
            pool.depositWithAuthorization(amount, lp, a.validAfter, a.validBefore, a.nonce, v, r, s);
        } else {
            vm.prank(lp);
            pool.deposit(amount, lp);
        }
    }

    function requestRedeem(uint256 lpSeed, uint256 shares) external {
        address lp = lps[lpSeed % lps.length];
        uint256 balance = pool.balanceOf(lp);
        if (balance == 0) return;
        shares = bound(shares, 1, balance);
        vm.prank(lp);
        pool.requestRedeem(shares, lp, lp);
        requestedAt[lp] = _now();
        ++requests;
    }

    function cancelRedeem(uint256 lpSeed) external {
        address lp = lps[lpSeed % lps.length];
        (uint256 requested,,,) = pool.redeemRequests(lp);
        if (requested == 0) return;
        vm.prank(lp);
        pool.cancelRedeemRequest();
        ++cancellations;
    }

    /// @dev A claim that went through must not have left a policy sold before its request open.
    function _checkCoverClosed(uint256 lastPolicy, uint256 claimed) internal {
        if (claimed != 0 && lastPolicy != 0 && book.oldestOpenId() <= lastPolicy) ++claimsAheadOfCover;
    }

    /// @dev Claims part of a matured request in shares. The payout may not exceed what the shares are worth
    /// now, nor their part of what the request was worth when it was made.
    function claimRedeem(uint256 lpSeed, uint256 shares) external {
        address lp = lps[lpSeed % lps.length];
        shares = bound(shares, 0, pool.maxRedeem(lp));
        (,,, uint256 lastPolicy) = pool.redeemRequests(lp);
        _checkCoverClosed(lastPolicy, shares);
        (uint256 requested, uint256 atRequest,,) = pool.redeemRequests(lp);
        uint256 fair = pool.convertToAssets(shares);
        uint256 balanceBefore = dollar.balanceOf(lp);
        uint256 treasuryBefore = _treasuryHolds();

        vm.prank(lp);
        uint256 assets = pool.redeem(shares, lp, lp);

        if (assets > fair || dollar.balanceOf(lp) - balanceBefore != assets) ++overpaidClaims;
        if (requested != 0 && assets * requested > atRequest * shares) ++overpaidClaims;
        _checkNothingLeftBehind(fair, assets + _treasuryHolds() - treasuryBefore);
        if (shares != 0) ++claims;
    }

    /// @dev Claims part of a matured request in assets.
    function claimWithdraw(uint256 lpSeed, uint256 assets) external {
        address lp = lps[lpSeed % lps.length];
        assets = bound(assets, 0, pool.maxWithdraw(lp));
        (,,, uint256 lastPolicy) = pool.redeemRequests(lp);
        _checkCoverClosed(lastPolicy, assets);
        uint256 poolAssets = pool.totalAssets();
        uint256 supply = pool.totalSupply();
        uint256 balanceBefore = dollar.balanceOf(lp);
        uint256 treasuryBefore = _treasuryHolds();

        vm.prank(lp);
        uint256 shares = pool.withdraw(assets, lp, lp);

        // Value of the burned shares at the price before the claim.
        uint256 fair = shares * (poolAssets + 1) / (supply + 1e6);
        if (assets > fair || dollar.balanceOf(lp) - balanceBefore != assets) ++overpaidClaims;
        if (assets != 0) _checkNothingLeftBehind(fair, assets + _treasuryHolds() - treasuryBefore);
        if (assets != 0) ++claims;
    }

    /// @dev A request cannot be claimed before its notice is over.
    function claimEarly(uint256 lpSeed) external {
        address lp = lps[lpSeed % lps.length];
        (uint256 requested,, uint64 claimableAt,) = pool.redeemRequests(lp);
        if (requested == 0 || _now() >= claimableAt) return;
        vm.prank(lp);
        try pool.redeem(requested, lp, lp) {
            ++earlyClaims;
        } catch {}
    }

    function _treasuryHolds() internal view returns (uint256) {
        address treasury = pool.treasury();
        return dollar.balanceOf(treasury) + pool.deferred(treasury);
    }

    /// @dev What the claimed shares were worth leaves the pool: paid to the provider, the rest to the treasury.
    /// Only rounding may stay behind with the providers who remain, and nothing may leave beyond the value.
    function _checkNothingLeftBehind(uint256 fair, uint256 out) internal {
        if (out > fair) ++overpaidClaims;
        else if (fair - out > 2) ++surplusLeftBehind;
    }

    /// @dev A matured request cannot be claimed while a policy sold before it is open.
    function claimAheadOfCover(uint256 lpSeed) external {
        address lp = lps[lpSeed % lps.length];
        (uint256 requested,, uint64 claimableAt,) = pool.redeemRequests(lp);
        if (requested == 0 || _now() < claimableAt || !pool.claimBlockedByCover(lp)) return;
        vm.prank(lp);
        try pool.redeem(requested, lp, lp) {
            ++claimsAheadOfCover;
        } catch (bytes memory reason) {
            if (bytes4(reason) != CoverPool.CoverStillOpen.selector) ++unexpectedReverts;
        }
    }

    /// @dev Asking for more than the limit must be refused, whatever backs the excess.
    function claimTooMuch(uint256 lpSeed, uint256 excess) external {
        address lp = lps[lpSeed % lps.length];
        uint256 amount = pool.maxWithdraw(lp) + bound(excess, 1, 1_000e6);
        vm.prank(lp);
        try pool.withdraw(amount, lp, lp) {
            ++overWithdrawals;
        } catch {}
    }

    /// @dev Shares that were never handed in cannot be redeemed, however long they have been held.
    function exitWithoutNotice(uint256 lpSeed, uint256 shares) external {
        address lp = lps[lpSeed % lps.length];
        (uint256 requested,,,) = pool.redeemRequests(lp);
        shares = requested + bound(shares, 1, 1_000e12);
        vm.prank(lp);
        try pool.redeem(shares, lp, lp) {
            ++overWithdrawals;
        } catch {}
    }

    function donate(uint256 amount) external {
        amount = bound(amount, 0, 100e6);
        vm.prank(donor);
        dollar.transfer(address(pool), amount);
    }

    // ───────────────────────────── issuer blocks ─────────────────────────────

    function setBlocked(uint256 holderSeed, bool blocked) external {
        vm.prank(owner);
        dollar.setBlocked(holders[holderSeed % holders.length], blocked);
    }

    function claimDeferred(uint256 holderSeed) external {
        address holder = holders[holderSeed % holders.length];
        if (pool.deferred(holder) == 0 || dollar.blocked(holder)) return;
        pool.claimDeferred(holder);
    }

    function _oracleStale() internal view returns (bool) {
        return _now() > uint256(index.heartbeat()) + book.maxOracleAge();
    }
}
