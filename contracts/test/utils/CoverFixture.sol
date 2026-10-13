// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {CoverBook} from "../../src/CoverBook.sol";
import {CoverPool} from "../../src/CoverPool.sol";
import {Quote, Reading} from "../../src/Types.sol";
import {WeatherIndex} from "../../src/WeatherIndex.sol";
import {BlockableDollar} from "../mocks/BlockableDollar.sol";
import {Signing} from "./Signing.sol";

/// @dev The whole system wired together the way the deploy script wires it, with a funded pool, a funded
/// holder and a live oracle heartbeat.
abstract contract CoverFixture is Signing {
    struct PolicyView {
        address holder;
        uint256 key;
        uint64 start;
        uint64 end;
        uint128 ratePerSecond;
        uint128 premium;
        uint256 maxPayout;
        uint256 paid;
        uint64 settledUntil;
        bool closed;
    }

    BlockableDollar internal dollar;
    WeatherIndex internal index;
    CoverPool internal pool;
    CoverBook internal book;

    address internal owner = makeAddr("owner");
    address internal treasury = makeAddr("treasury");
    address internal relayer = makeAddr("relayer");
    address internal keeper = makeAddr("keeper");
    address internal lp = makeAddr("lp");
    address internal underwriter;
    uint256 internal underwriterKey;
    address internal reporter;
    uint256 internal reporterKey;
    address internal holder;
    uint256 internal holderKey;
    address internal attacker;
    uint256 internal attackerKey;

    uint256 internal constant KEY = (uint256(1) << 64) | (uint256(1044) << 32) | 420;
    uint256 internal constant OTHER_KEY = (uint256(1) << 64) | (uint256(1045) << 32) | 421;

    /// @dev Minute-aligned start of time for the suites.
    uint64 internal constant T0 = 1_760_000_400;
    uint256 internal constant POOL_DEPOSIT = 100_000e6;
    uint256 internal constant HOLDER_FUNDS = 10_000e6;
    uint256 internal constant MAX_POLICY_PAYOUT = 500e6;

    /// @dev One cent per wet second.
    uint128 internal constant RATE = 1e4;
    uint128 internal constant PREMIUM = 1e6;

    bytes32 internal bookDomain;
    bytes32 internal indexDomain;
    bytes32 internal dollarDomain;
    uint64 internal lastIssued;
    uint256 internal saltCounter;

    function setUp() public virtual {
        vm.warp(T0);
        (underwriter, underwriterKey) = makeAddrAndKey("underwriter");
        (reporter, reporterKey) = makeAddrAndKey("reporter");
        (holder, holderKey) = makeAddrAndKey("holder");
        (attacker, attackerKey) = makeAddrAndKey("attacker");

        dollar = new BlockableDollar(owner);
        index = new WeatherIndex(owner, reporter);
        pool = new CoverPool(dollar, owner, "Cover Pool Share", "cvUSD");
        book = new CoverBook(dollar, pool, index, underwriter, treasury, 0, MAX_POLICY_PAYOUT, owner);
        vm.prank(owner);
        pool.setBook(address(book));

        bookDomain = book.DOMAIN_SEPARATOR();
        indexDomain = index.DOMAIN_SEPARATOR();
        dollarDomain = dollar.DOMAIN_SEPARATOR();

        vm.startPrank(owner);
        dollar.mint(lp, POOL_DEPOSIT);
        dollar.mint(holder, HOLDER_FUNDS);
        dollar.mint(attacker, HOLDER_FUNDS);
        vm.stopPrank();

        vm.startPrank(lp);
        dollar.approve(address(pool), type(uint256).max);
        pool.deposit(POOL_DEPOSIT, lp);
        vm.stopPrank();

        vm.prank(holder);
        dollar.approve(address(book), type(uint256).max);

        _heartbeat();
    }

    function _now() internal view returns (uint64) {
        return uint64(vm.getBlockTimestamp());
    }

    // ───────────────────────────── oracle ─────────────────────────────

    function _nextIssuedAt() internal returns (uint64) {
        uint64 nowTs = _now();
        lastIssued = lastIssued >= nowTs ? lastIssued + 1 : nowTs;
        return lastIssued;
    }

    function _submitReport(Reading[] memory readings) internal {
        bytes memory payload = _signedReport(reporterKey, indexDomain, readings, _nextIssuedAt());
        vm.prank(keeper);
        index.submit(payload);
    }

    function _report(uint256 key, uint64 from, uint64 to, uint32 wet) internal {
        _submitReport(_readings(Reading(key, from, to, wet)));
    }

    function _heartbeat() internal {
        _submitReport(new Reading[](0));
    }

    // ───────────────────────────── quotes ─────────────────────────────

    function _quote(address holder_, uint256 key, uint64 start, uint64 end, uint128 rate, uint128 premium)
        internal
        returns (Quote memory)
    {
        return Quote({
            holder: holder_,
            key: key,
            start: start,
            end: end,
            ratePerSecond: rate,
            premium: premium,
            expiry: _now() + 5 minutes,
            salt: bytes32(++saltCounter)
        });
    }

    /// @dev Ten-minute policy for `holder` on KEY starting `startsIn` seconds from now.
    function _standardQuote(uint64 startsIn) internal returns (Quote memory) {
        uint64 start = _now() + startsIn;
        return _quote(holder, KEY, start, start + 10 minutes, RATE, PREMIUM);
    }

    function _signQuote(Quote memory q) internal view returns (bytes memory) {
        return _signDigest(underwriterKey, _quoteDigest(bookDomain, q));
    }

    function _buy(Quote memory q) internal returns (uint256 id) {
        bytes memory signature = _signQuote(q);
        vm.prank(q.holder);
        return book.buy(q, signature);
    }

    function _premiumAuthorization(Quote memory q, uint256 payerKey)
        internal
        view
        returns (Authorization memory a, uint8 v, bytes32 r, bytes32 s)
    {
        a = Authorization({
            from: q.holder,
            to: address(book),
            value: q.premium,
            validAfter: 0,
            validBefore: q.expiry,
            nonce: _quoteDigest(bookDomain, q)
        });
        (v, r, s) = _signReceiveAuthorization(payerKey, dollarDomain, a);
    }

    function _buyWithAuthorization(Quote memory q, uint256 payerKey, address submitter) internal returns (uint256 id) {
        bytes memory signature = _signQuote(q);
        (Authorization memory a, uint8 v, bytes32 r, bytes32 s) = _premiumAuthorization(q, payerKey);
        vm.prank(submitter);
        return book.buyWithAuthorization(q, signature, a.validAfter, a.validBefore, v, r, s);
    }

    // ───────────────────────────── views ─────────────────────────────

    function _policy(uint256 id) internal view returns (PolicyView memory p) {
        (p.holder, p.key, p.start, p.end, p.ratePerSecond, p.premium, p.maxPayout, p.paid, p.settledUntil, p.closed) =
            book.policies(id);
    }
}
