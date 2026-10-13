// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {CoverBook} from "../src/CoverBook.sol";
import {CoverPool} from "../src/CoverPool.sol";
import {IWeatherIndex} from "../src/interfaces/IWeatherIndex.sol";
import {TestDollar} from "../src/TestDollar.sol";
import {Quote, Reading} from "../src/Types.sol";
import {ContractSigner} from "./mocks/ContractSigner.sol";
import {SilentDollar} from "./mocks/SilentDollar.sol";
import {CoverFixture} from "./utils/CoverFixture.sol";

contract CoverBookBuyTest is CoverFixture {
    // ───────────────────────────── quote hashing ─────────────────────────────

    function test_DomainSeparator() public view {
        bytes32 expected = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("Cover"),
                keccak256("1"),
                block.chainid,
                address(book)
            )
        );
        assertEq(book.DOMAIN_SEPARATOR(), expected);
    }

    function test_QuoteTypeHash() public view {
        assertEq(book.QUOTE_TYPEHASH(), QUOTE_TYPEHASH);
    }

    function test_HashQuote_MatchesTheManualDigest() public {
        Quote memory q = _standardQuote(0);
        assertEq(book.hashQuote(q), _quoteDigest(bookDomain, q));
    }

    function test_HashQuote_MatchesTypedDataJson() public {
        Quote memory q = _standardQuote(0);
        string memory json = string.concat(
            '{"types":{"EIP712Domain":[{"name":"name","type":"string"},{"name":"version","type":"string"},',
            '{"name":"chainId","type":"uint256"},{"name":"verifyingContract","type":"address"}],',
            '"Quote":[{"name":"holder","type":"address"},{"name":"key","type":"uint256"},',
            '{"name":"start","type":"uint64"},{"name":"end","type":"uint64"},',
            '{"name":"ratePerSecond","type":"uint128"},{"name":"premium","type":"uint128"},',
            '{"name":"expiry","type":"uint64"},{"name":"salt","type":"bytes32"}]},',
            '"primaryType":"Quote","domain":{"name":"Cover","version":"1","chainId":',
            vm.toString(block.chainid),
            ',"verifyingContract":"',
            vm.toString(address(book)),
            '"},"message":{"holder":"',
            vm.toString(q.holder),
            '","key":"',
            vm.toString(q.key)
        );
        json = string.concat(
            json,
            '","start":',
            vm.toString(uint256(q.start)),
            ',"end":',
            vm.toString(uint256(q.end)),
            ',"ratePerSecond":"',
            vm.toString(uint256(q.ratePerSecond)),
            '","premium":"',
            vm.toString(uint256(q.premium)),
            '","expiry":',
            vm.toString(uint256(q.expiry)),
            ',"salt":"',
            vm.toString(q.salt),
            '"}}'
        );
        assertEq(book.hashQuote(q), vm.eip712HashTypedData(json));
    }

    // ───────────────────────────── buy ─────────────────────────────

    function test_Buy_CreatesThePolicyAndSplitsThePremium() public {
        Quote memory q = _standardQuote(60);
        bytes memory signature = _signQuote(q);
        uint256 maxPayout = uint256(RATE) * 10 minutes;

        vm.expectEmit(address(book));
        emit CoverBook.PolicyBought(1, holder, KEY, q.start, q.end, RATE, PREMIUM, maxPayout);
        vm.prank(holder);
        uint256 id = book.buy(q, signature);

        assertEq(id, 1);
        assertEq(book.policyCount(), 1);
        assertTrue(book.quoteUsed(_quoteDigest(bookDomain, q)));

        PolicyView memory p = _policy(id);
        assertEq(p.holder, holder);
        assertEq(p.key, KEY);
        assertEq(p.start, q.start);
        assertEq(p.end, q.end);
        assertEq(p.ratePerSecond, RATE);
        assertEq(p.premium, PREMIUM);
        assertEq(p.maxPayout, maxPayout);
        assertEq(p.paid, 0);
        assertEq(p.settledUntil, q.start);
        assertFalse(p.closed);

        // 5% of the premium is the fee; the rest belongs to the pool.
        assertEq(dollar.balanceOf(treasury), PREMIUM * 5 / 100);
        assertEq(dollar.balanceOf(address(pool)), POOL_DEPOSIT + PREMIUM * 95 / 100);
        assertEq(dollar.balanceOf(holder), HOLDER_FUNDS - PREMIUM);
        assertEq(dollar.balanceOf(address(book)), 0);

        assertEq(pool.lockedExposure(), maxPayout);
        assertEq(pool.cellExposure(KEY), maxPayout);

        uint256[] memory cells = book.activeCells();
        assertEq(cells.length, 1);
        assertEq(cells[0], KEY);
        assertEq(book.openPolicies(KEY), 1);
    }

    function test_Buy_AnyoneCanPayForAHolder() public {
        Quote memory q = _standardQuote(60);
        bytes memory signature = _signQuote(q);
        vm.prank(attacker);
        dollar.approve(address(book), type(uint256).max);

        vm.prank(attacker);
        uint256 id = book.buy(q, signature);

        assertEq(_policy(id).holder, holder);
        assertEq(dollar.balanceOf(attacker), HOLDER_FUNDS - PREMIUM);
        assertEq(dollar.balanceOf(holder), HOLDER_FUNDS);
    }

    function test_Buy_FeeRoundsInThePoolsFavour() public {
        Quote memory q = _quote(holder, KEY, _now(), _now() + 10 minutes, RATE, 19);
        _buy(q);

        // 5% of 19 units is 0.95: the treasury gets nothing, the pool gets all of it.
        assertEq(dollar.balanceOf(treasury), 0);
        assertEq(dollar.balanceOf(address(pool)), POOL_DEPOSIT + 19);
    }

    function test_Buy_AcceptsAContractUnderwriter() public {
        ContractSigner wallet = new ContractSigner(underwriter);
        vm.prank(owner);
        book.setUnderwriter(address(wallet));

        uint256 id = _buy(_standardQuote(0));
        assertEq(id, 1);

        Quote memory forged = _standardQuote(0);
        bytes memory signature = _signDigest(attackerKey, _quoteDigest(bookDomain, forged));
        vm.expectRevert(CoverBook.BadQuoteSignature.selector);
        vm.prank(holder);
        book.buy(forged, signature);
    }

    function test_Buy_RevertWhen_QuoteExpired() public {
        Quote memory q = _standardQuote(10 minutes);
        bytes memory signature = _signQuote(q);

        vm.warp(q.expiry + 1);
        _heartbeat();
        vm.expectRevert(CoverBook.QuoteExpired.selector);
        vm.prank(holder);
        book.buy(q, signature);
    }

    function test_Buy_AcceptsAQuoteAtItsExpiry() public {
        Quote memory q = _standardQuote(10 minutes);
        bytes memory signature = _signQuote(q);

        vm.warp(q.expiry);
        _heartbeat();
        vm.prank(holder);
        assertEq(book.buy(q, signature), 1);
    }

    function test_Buy_RevertWhen_QuoteSignedBySomeoneElse() public {
        Quote memory q = _standardQuote(0);
        bytes memory signature = _signDigest(attackerKey, _quoteDigest(bookDomain, q));

        vm.expectRevert(CoverBook.BadQuoteSignature.selector);
        vm.prank(holder);
        book.buy(q, signature);
    }

    function test_Buy_RevertWhen_SignatureIsMalformed() public {
        Quote memory q = _standardQuote(0);

        vm.expectRevert(CoverBook.BadQuoteSignature.selector);
        vm.prank(holder);
        book.buy(q, hex"");

        vm.expectRevert(CoverBook.BadQuoteSignature.selector);
        vm.prank(holder);
        book.buy(q, hex"deadbeef");
    }

    function test_Buy_RevertWhen_AnyTermDiffersFromTheSignedQuote() public {
        Quote memory signed = _standardQuote(60);
        bytes memory signature = _signQuote(signed);

        Quote memory q = _copy(signed);
        q.holder = attacker;
        _expectBadSignature(q, signature);

        q = _copy(signed);
        q.key = OTHER_KEY;
        _expectBadSignature(q, signature);

        q = _copy(signed);
        q.start -= 60;
        _expectBadSignature(q, signature);

        q = _copy(signed);
        q.end += 60;
        _expectBadSignature(q, signature);

        q = _copy(signed);
        q.ratePerSecond *= 2;
        _expectBadSignature(q, signature);

        q = _copy(signed);
        q.premium -= 1;
        _expectBadSignature(q, signature);

        q = _copy(signed);
        q.expiry += 1 days;
        _expectBadSignature(q, signature);

        q = _copy(signed);
        q.salt = bytes32(uint256(777));
        _expectBadSignature(q, signature);
    }

    function test_Buy_RevertWhen_QuoteWasSignedForAnotherBook() public {
        CoverBook other = new CoverBook(dollar, pool, index, underwriter, treasury, 0, MAX_POLICY_PAYOUT, owner);
        Quote memory q = _standardQuote(0);
        bytes memory signature = _signDigest(underwriterKey, _quoteDigest(other.DOMAIN_SEPARATOR(), q));

        vm.expectRevert(CoverBook.BadQuoteSignature.selector);
        vm.prank(holder);
        book.buy(q, signature);
    }

    function test_Buy_RevertWhen_QuoteUsed() public {
        Quote memory q = _standardQuote(60);
        bytes memory signature = _signQuote(q);
        vm.prank(holder);
        book.buy(q, signature);

        vm.expectRevert(CoverBook.QuoteUsed.selector);
        vm.prank(holder);
        book.buy(q, signature);

        vm.expectRevert(CoverBook.QuoteUsed.selector);
        vm.prank(attacker);
        book.buy(q, signature);

        assertEq(book.policyCount(), 1);
    }

    function test_Buy_RevertWhen_HolderIsZero() public {
        Quote memory q = _quote(address(0), KEY, _now(), _now() + 10 minutes, RATE, PREMIUM);
        bytes memory signature = _signQuote(q);

        vm.expectRevert(CoverBook.ZeroAddress.selector);
        vm.prank(holder);
        book.buy(q, signature);
    }

    function test_Buy_IdenticalTermsWithAnotherSaltAreANewQuote() public {
        Quote memory first = _standardQuote(60);
        Quote memory second = _copy(first);
        second.salt = bytes32(uint256(first.salt) + 1);

        assertEq(_buy(first), 1);
        assertEq(_buy(second), 2);
    }

    function test_Buy_RevertWhen_WindowIsNotMinuteAligned() public {
        Quote memory q = _quote(holder, KEY, _now() + 1, _now() + 10 minutes, RATE, PREMIUM);
        _expectBuyRevert(q, CoverBook.WindowInvalid.selector);

        q = _quote(holder, KEY, _now(), _now() + 10 minutes + 59, RATE, PREMIUM);
        _expectBuyRevert(q, CoverBook.WindowInvalid.selector);
    }

    function test_Buy_RevertWhen_WindowIsEmptyOrInverted() public {
        Quote memory q = _quote(holder, KEY, _now() + 60, _now() + 60, RATE, PREMIUM);
        _expectBuyRevert(q, CoverBook.WindowInvalid.selector);

        q = _quote(holder, KEY, _now() + 120, _now() + 60, RATE, PREMIUM);
        _expectBuyRevert(q, CoverBook.WindowInvalid.selector);
    }

    function test_Buy_RevertWhen_WindowIsShorterThanTheMinimum() public {
        vm.prank(owner);
        book.setDurationBounds(5 minutes, 12 hours);

        Quote memory q = _quote(holder, KEY, _now(), _now() + 4 minutes, RATE, PREMIUM);
        _expectBuyRevert(q, CoverBook.WindowInvalid.selector);

        _buy(_quote(holder, KEY, _now(), _now() + 5 minutes, RATE, PREMIUM));
    }

    function test_Buy_RevertWhen_WindowIsLongerThanTheMaximum() public {
        Quote memory q = _quote(holder, KEY, _now(), _now() + 12 hours + 60, 1, PREMIUM);
        _expectBuyRevert(q, CoverBook.WindowInvalid.selector);

        _buy(_quote(holder, KEY, _now(), _now() + 12 hours, 1, PREMIUM));
    }

    function test_Buy_OneMinuteIsTheShortestWindow() public {
        uint256 id = _buy(_quote(holder, KEY, _now(), _now() + 60, RATE, PREMIUM));
        assertEq(_policy(id).maxPayout, uint256(RATE) * 60);
    }

    function test_Buy_AcceptsAWindowEndingExactlyAtTheHorizon() public {
        // The longest window, starting as late as the horizon of twelve and a half hours allows.
        uint64 end = _now() + 12 hours + 30 minutes;
        uint256 id = _buy(_quote(holder, KEY, end - 12 hours, end, 1, PREMIUM));
        assertEq(_policy(id).end, _now() + book.maxHorizon());
    }

    function test_Buy_RevertWhen_WindowEndsBeyondTheHorizon() public {
        uint64 end = _now() + 12 hours + 31 minutes;
        Quote memory q = _quote(holder, KEY, end - 12 hours, end, 1, PREMIUM);
        _expectBuyRevert(q, CoverBook.WindowTooFar.selector);

        // The same limit guards the gasless path.
        bytes memory signature = _signQuote(q);
        (Authorization memory a, uint8 v, bytes32 r, bytes32 s) = _premiumAuthorization(q, holderKey);
        vm.expectRevert(CoverBook.WindowTooFar.selector);
        vm.prank(relayer);
        book.buyWithAuthorization(q, signature, a.validAfter, a.validBefore, v, r, s);

        assertEq(book.policyCount(), 0);
    }

    function test_Buy_RevertWhen_AShortWindowStartsFarAhead() public {
        // Ten minutes of cover a day from now: short enough, but the capital behind it may be gone by then.
        Quote memory q = _quote(holder, KEY, _now() + 1 days, _now() + 1 days + 10 minutes, RATE, PREMIUM);
        _expectBuyRevert(q, CoverBook.WindowTooFar.selector);
    }

    function test_Buy_TheHorizonMovesWithTheClock() public {
        uint64 end = _now() + 12 hours + 31 minutes;
        Quote memory q = _quote(holder, KEY, end - 10 minutes, end, RATE, PREMIUM);
        _expectBuyRevert(q, CoverBook.WindowTooFar.selector);

        vm.warp(_now() + 60);
        assertEq(_buy(q), 1);
    }

    function test_Buy_RevertWhen_LeadTooShort() public {
        vm.prank(owner);
        book.setMinLead(10 minutes);

        Quote memory q = _standardQuote(10 minutes - 60);
        _expectBuyRevert(q, CoverBook.LeadTooShort.selector);

        // A window that has already started is refused even without a configured lead.
        vm.prank(owner);
        book.setMinLead(0);
        q = _quote(holder, KEY, _now() - 60, _now() + 10 minutes, RATE, PREMIUM);
        _expectBuyRevert(q, CoverBook.LeadTooShort.selector);
    }

    function test_Buy_AcceptsAWindowStartingExactlyAtTheLead() public {
        vm.prank(owner);
        book.setMinLead(10 minutes);
        assertEq(_buy(_standardQuote(10 minutes)), 1);
    }

    function test_Buy_RevertWhen_PolicyTooLarge() public {
        // 500 dollars over ten minutes is the largest policy the book accepts.
        uint128 rate = uint128(MAX_POLICY_PAYOUT / 10 minutes) + 1;
        Quote memory q = _quote(holder, KEY, _now(), _now() + 10 minutes, rate, PREMIUM);
        _expectBuyRevert(q, CoverBook.PolicyTooLarge.selector);
    }

    function test_Buy_AcceptsAPolicyAtTheSizeLimit() public {
        vm.prank(owner);
        book.setMaxPolicyPayout(uint256(RATE) * 10 minutes);
        assertEq(_buy(_standardQuote(0)), 1);

        Quote memory q = _quote(holder, KEY, _now(), _now() + 10 minutes, RATE + 1, PREMIUM);
        _expectBuyRevert(q, CoverBook.PolicyTooLarge.selector);
    }

    function test_Buy_RevertWhen_PremiumTooSmall() public {
        vm.prank(owner);
        book.setMinPremium(1e6);

        Quote memory q = _quote(holder, KEY, _now(), _now() + 10 minutes, RATE, 1e6 - 1);
        _expectBuyRevert(q, CoverBook.PremiumTooSmall.selector);

        // The same floor guards the gasless path.
        bytes memory signature = _signQuote(q);
        (Authorization memory a, uint8 v, bytes32 r, bytes32 s) = _premiumAuthorization(q, holderKey);
        vm.expectRevert(CoverBook.PremiumTooSmall.selector);
        vm.prank(relayer);
        book.buyWithAuthorization(q, signature, a.validAfter, a.validBefore, v, r, s);

        assertEq(book.activeCells().length, 0);
    }

    function test_Buy_AcceptsAPremiumAtTheFloor() public {
        vm.prank(owner);
        book.setMinPremium(1e6);
        assertEq(_buy(_quote(holder, KEY, _now(), _now() + 10 minutes, RATE, 1e6)), 1);
    }

    function test_Buy_AFloorMakesHoldingEveryCellSlotCostly() public {
        vm.startPrank(owner);
        book.setMinPremium(2e6);
        book.setMaxActiveCells(4);
        vm.stopPrank();

        // Occupying every slot now costs the floor each time, however small the policies are.
        for (uint256 i = 0; i < 4; ++i) {
            _buy(_quote(holder, KEY + i, _now(), _now() + 60, 1, 2e6));
        }
        assertEq(dollar.balanceOf(holder), HOLDER_FUNDS - 8e6);

        Quote memory q = _quote(holder, KEY + 4, _now(), _now() + 60, 1, 2e6);
        _expectBuyRevert(q, CoverBook.TooManyCells.selector);
    }

    function test_Buy_RevertWhen_OracleStale() public {
        vm.warp(T0 + 20 minutes + 60);
        Quote memory q = _standardQuote(0);
        _expectBuyRevert(q, CoverBook.OracleStale.selector);

        _heartbeat();
        assertEq(_buy(q), 1);
    }

    function test_Buy_AcceptsAHeartbeatAtTheAgeLimit() public {
        vm.warp(T0 + 20 minutes);
        assertEq(_buy(_standardQuote(0)), 1);
    }

    function test_Buy_AWithheldReportCannotMakeAStaleOracleLookAlive() public {
        // The reporter signs a heartbeat that never lands; then the oracle goes quiet.
        vm.warp(T0 + 60);
        bytes memory withheld = _signedReport(reporterKey, indexDomain, new Reading[](0), _now());

        // Twenty-five minutes on, someone delivers the old report. It is accepted, but it says nothing new
        // about whether the oracle is alive now.
        vm.warp(T0 + 25 minutes);
        vm.prank(attacker);
        index.submit(withheld);
        assertEq(index.heartbeat(), T0 + 60);

        Quote memory q = _standardQuote(0);
        _expectBuyRevert(q, CoverBook.OracleStale.selector);
    }

    function test_Buy_RevertWhen_OracleNeverReported() public {
        CoverBook fresh = _freshBookWithSilentOracle();
        Quote memory q = _standardQuote(0);
        bytes memory signature = _signDigest(underwriterKey, _quoteDigest(fresh.DOMAIN_SEPARATOR(), q));

        vm.expectRevert(CoverBook.OracleStale.selector);
        vm.prank(holder);
        fresh.buy(q, signature);
    }

    function test_Buy_RevertWhen_TooManyCells() public {
        vm.prank(owner);
        book.setMaxActiveCells(2);

        _buy(_quote(holder, KEY, _now(), _now() + 10 minutes, RATE, PREMIUM));
        _buy(_quote(holder, OTHER_KEY, _now(), _now() + 10 minutes, RATE, PREMIUM));

        Quote memory third = _quote(holder, OTHER_KEY + 1, _now(), _now() + 10 minutes, RATE, PREMIUM);
        _expectBuyRevert(third, CoverBook.TooManyCells.selector);

        // A cell that is already active can take more policies.
        _buy(_quote(holder, KEY, _now(), _now() + 10 minutes, RATE, PREMIUM));
        assertEq(book.activeCells().length, 2);
        assertEq(book.openPolicies(KEY), 2);
    }

    function test_Buy_RevertWhen_GlobalCapExceeded() public {
        vm.startPrank(owner);
        pool.setMaxUtilizationBps(1);
        vm.stopPrank();

        // One basis point of the pool is 10 dollars; the standard policy can pay 6.
        _buy(_standardQuote(0));
        Quote memory q = _standardQuote(0);
        _expectBuyRevert(q, CoverPool.GlobalCapExceeded.selector);
    }

    function test_Buy_RevertWhen_CellCapExceeded() public {
        vm.prank(owner);
        pool.setMaxCellBps(1);

        _buy(_standardQuote(0));
        Quote memory q = _standardQuote(0);
        _expectBuyRevert(q, CoverPool.CellCapExceeded.selector);

        // The refusal is per cell: the same policy in another cell is sold.
        _buy(_quote(holder, OTHER_KEY, _now(), _now() + 10 minutes, RATE, PREMIUM));
    }

    function test_Buy_ARefusedSaleLeavesNoTrace() public {
        vm.prank(owner);
        pool.setMaxCellBps(0);
        Quote memory q = _standardQuote(0);
        _expectBuyRevert(q, CoverPool.CellCapExceeded.selector);

        assertEq(book.policyCount(), 0);
        assertFalse(book.quoteUsed(_quoteDigest(bookDomain, q)));
        assertEq(book.activeCells().length, 0);
        assertEq(book.openPolicies(KEY), 0);
        assertEq(pool.lockedExposure(), 0);
        assertEq(dollar.balanceOf(holder), HOLDER_FUNDS);

        // The quote is still good once there is capacity.
        vm.prank(owner);
        pool.setMaxCellBps(2500);
        assertEq(_buy(q), 1);
    }

    function test_Buy_RevertWhen_PayerHasNotApprovedThePremium() public {
        Quote memory q = _standardQuote(0);
        bytes memory signature = _signQuote(q);

        vm.expectRevert(
            abi.encodeWithSelector(
                IERC20Errors.ERC20InsufficientAllowance.selector, address(book), 0, PREMIUM * 5 / 100
            )
        );
        vm.prank(attacker);
        book.buy(q, signature);

        assertEq(book.policyCount(), 0);
        assertEq(pool.lockedExposure(), 0);
        assertFalse(book.quoteUsed(_quoteDigest(bookDomain, q)));
    }

    function test_Buy_RevertWhen_PayerCannotAffordThePremium() public {
        Quote memory q = _quote(holder, KEY, _now(), _now() + 10 minutes, RATE, uint128(HOLDER_FUNDS) + 1e6);
        bytes memory signature = _signQuote(q);

        vm.expectRevert();
        vm.prank(holder);
        book.buy(q, signature);

        assertEq(book.policyCount(), 0);
        assertEq(dollar.balanceOf(treasury), 0);
    }

    function test_Buy_ChecksRunInTheDocumentedOrder() public {
        vm.startPrank(owner);
        book.setMinLead(10 minutes);
        book.setMinPremium(10);
        book.setServedOnly(true);
        book.setMaxActiveCells(0);
        pool.setMaxCellBps(0);
        book.setDurationBounds(60, 20 minutes);
        book.setMaxHorizon(20 minutes);
        vm.stopPrank();

        // Start with a quote that violates every rule after the signature check, then repair one rule at a time.
        Quote memory q = _quote(holder, KEY, _now() + 61, _now() + 13 hours, type(uint128).max, PREMIUM);
        q.expiry = _now() + 1 days;
        bytes memory forged = _signDigest(attackerKey, _quoteDigest(bookDomain, q));

        vm.warp(T0 + 30 minutes);
        uint64 nowTs = _now();

        // Expired and forged: expiry is reported first.
        Quote memory expired = _copy(q);
        expired.expiry = nowTs - 1;
        vm.expectRevert(CoverBook.QuoteExpired.selector);
        vm.prank(holder);
        book.buy(expired, forged);

        vm.expectRevert(CoverBook.BadQuoteSignature.selector);
        vm.prank(holder);
        book.buy(q, forged);

        _expectBuyRevert(q, CoverBook.WindowInvalid.selector);

        q.start = nowTs + 60;
        q.end = nowTs + 60 + 20 minutes;
        _expectBuyRevert(q, CoverBook.WindowTooFar.selector);

        q.end = nowTs + 60 + 10 minutes;
        _expectBuyRevert(q, CoverBook.LeadTooShort.selector);

        q.start = nowTs + 10 minutes;
        q.end = nowTs + 20 minutes;
        _expectBuyRevert(q, CoverBook.PolicyTooLarge.selector);

        q.ratePerSecond = RATE;
        q.premium = 9;
        _expectBuyRevert(q, CoverBook.PremiumTooSmall.selector);

        q.premium = PREMIUM;
        _expectBuyRevert(q, CoverBook.AreaNotServed.selector);

        vm.prank(owner);
        book.setServedOnly(false);
        _expectBuyRevert(q, CoverBook.OracleStale.selector);

        _heartbeat();
        _expectBuyRevert(q, CoverBook.TooManyCells.selector);

        vm.prank(owner);
        book.setMaxActiveCells(64);
        _expectBuyRevert(q, CoverPool.CellCapExceeded.selector);

        vm.prank(owner);
        pool.setMaxCellBps(2500);
        assertEq(_buy(q), 1);

        // A used quote is reported before anything about its window.
        vm.warp(q.start + 60);
        _heartbeat();
        _expectBuyRevert(q, CoverBook.QuoteUsed.selector);
    }

    // ───────────────────────────── buyWithAuthorization ─────────────────────────────

    function test_BuyWithAuthorization_OneSignaturePaysForExactlyTheseTerms() public {
        vm.prank(holder);
        dollar.approve(address(book), 0);
        Quote memory q = _standardQuote(60);
        bytes32 digest = _quoteDigest(bookDomain, q);

        uint256 id = _buyWithAuthorization(q, holderKey, relayer);

        assertEq(id, 1);
        PolicyView memory p = _policy(id);
        assertEq(p.holder, holder);
        assertEq(p.premium, PREMIUM);
        assertEq(dollar.balanceOf(holder), HOLDER_FUNDS - PREMIUM);
        assertEq(dollar.balanceOf(relayer), 0);
        assertEq(dollar.balanceOf(treasury), PREMIUM * 5 / 100);
        assertEq(dollar.balanceOf(address(pool)), POOL_DEPOSIT + PREMIUM * 95 / 100);
        assertEq(dollar.balanceOf(address(book)), 0);
        assertTrue(dollar.authorizationState(holder, digest));
        assertTrue(book.quoteUsed(digest));
        assertEq(pool.lockedExposure(), p.maxPayout);
    }

    function test_BuyWithAuthorization_AStrangerSubmittingItOnlyBuysTheSignedPolicy() public {
        Quote memory q = _standardQuote(60);

        uint256 id = _buyWithAuthorization(q, holderKey, attacker);

        PolicyView memory p = _policy(id);
        assertEq(p.holder, holder);
        assertEq(p.key, q.key);
        assertEq(p.start, q.start);
        assertEq(p.end, q.end);
        assertEq(p.ratePerSecond, q.ratePerSecond);
        assertEq(dollar.balanceOf(holder), HOLDER_FUNDS - q.premium);
        assertEq(dollar.balanceOf(attacker), HOLDER_FUNDS);
    }

    function test_BuyWithAuthorization_RevertWhen_PaymentWasSignedForOtherTerms() public {
        // The holder authorizes payment for a ten-minute policy.
        Quote memory signedFor = _standardQuote(60);
        (Authorization memory a, uint8 v, bytes32 r, bytes32 s) = _premiumAuthorization(signedFor, holderKey);

        // Someone pairs that payment with a different, genuinely underwritten quote at the same price.
        Quote memory other = _quote(holder, KEY, signedFor.start, signedFor.start + 60, 1, PREMIUM);
        other.expiry = signedFor.expiry;
        bytes memory signature = _signQuote(other);

        vm.expectRevert(TestDollar.InvalidAuthorizationSignature.selector);
        vm.prank(attacker);
        book.buyWithAuthorization(other, signature, a.validAfter, a.validBefore, v, r, s);

        assertEq(book.policyCount(), 0);
        assertEq(dollar.balanceOf(holder), HOLDER_FUNDS);
    }

    function test_BuyWithAuthorization_RevertWhen_PaymentWasSignedBySomeoneElse() public {
        Quote memory q = _standardQuote(60);
        bytes memory signature = _signQuote(q);
        (Authorization memory a, uint8 v, bytes32 r, bytes32 s) = _premiumAuthorization(q, attackerKey);

        vm.expectRevert(TestDollar.InvalidAuthorizationSignature.selector);
        vm.prank(relayer);
        book.buyWithAuthorization(q, signature, a.validAfter, a.validBefore, v, r, s);
    }

    function test_BuyWithAuthorization_RevertWhen_Replayed() public {
        Quote memory q = _standardQuote(60);
        bytes memory signature = _signQuote(q);
        (Authorization memory a, uint8 v, bytes32 r, bytes32 s) = _premiumAuthorization(q, holderKey);
        vm.prank(relayer);
        book.buyWithAuthorization(q, signature, a.validAfter, a.validBefore, v, r, s);

        vm.expectRevert(CoverBook.QuoteUsed.selector);
        vm.prank(relayer);
        book.buyWithAuthorization(q, signature, a.validAfter, a.validBefore, v, r, s);

        // Nor can the same quote be bought again by paying directly.
        vm.expectRevert(CoverBook.QuoteUsed.selector);
        vm.prank(holder);
        book.buy(q, signature);
    }

    function test_BuyWithAuthorization_RevertWhen_QuoteWasAlreadyBoughtDirectly() public {
        Quote memory q = _standardQuote(60);
        bytes memory signature = _signQuote(q);
        (Authorization memory a, uint8 v, bytes32 r, bytes32 s) = _premiumAuthorization(q, holderKey);
        vm.prank(holder);
        book.buy(q, signature);

        vm.expectRevert(CoverBook.QuoteUsed.selector);
        vm.prank(relayer);
        book.buyWithAuthorization(q, signature, a.validAfter, a.validBefore, v, r, s);

        assertEq(dollar.balanceOf(holder), HOLDER_FUNDS - PREMIUM);
        assertFalse(dollar.authorizationState(holder, a.nonce));
    }

    function test_BuyWithAuthorization_RevertWhen_HolderCannotPay_AndNothingIsCreated() public {
        Quote memory q = _quote(holder, KEY, _now(), _now() + 10 minutes, RATE, uint128(HOLDER_FUNDS) + 1);
        bytes memory signature = _signQuote(q);
        (Authorization memory a, uint8 v, bytes32 r, bytes32 s) = _premiumAuthorization(q, holderKey);

        vm.expectRevert(
            abi.encodeWithSelector(
                IERC20Errors.ERC20InsufficientBalance.selector, holder, HOLDER_FUNDS, HOLDER_FUNDS + 1
            )
        );
        vm.prank(relayer);
        book.buyWithAuthorization(q, signature, a.validAfter, a.validBefore, v, r, s);

        assertEq(book.policyCount(), 0);
        assertEq(pool.lockedExposure(), 0);
        assertEq(book.activeCells().length, 0);
        assertFalse(book.quoteUsed(a.nonce));
        assertFalse(dollar.authorizationState(holder, a.nonce));
    }

    function test_BuyWithAuthorization_RevertWhen_PaymentAuthorizationExpired() public {
        Quote memory q = _standardQuote(10 minutes);
        bytes memory signature = _signQuote(q);
        (Authorization memory a,,,) = _premiumAuthorization(q, holderKey);
        a.validBefore = _now() + 30;
        (uint8 v, bytes32 r, bytes32 s) = _signReceiveAuthorization(holderKey, dollarDomain, a);

        vm.warp(_now() + 30);
        vm.expectRevert(abi.encodeWithSelector(TestDollar.AuthorizationExpired.selector, a.validBefore));
        vm.prank(relayer);
        book.buyWithAuthorization(q, signature, a.validAfter, a.validBefore, v, r, s);
    }

    function test_BuyWithAuthorization_RevertWhen_SaleIsRefused_AndThePaymentStaysUnused() public {
        vm.prank(owner);
        pool.setMaxCellBps(0);
        Quote memory q = _standardQuote(60);
        bytes memory signature = _signQuote(q);
        (Authorization memory a, uint8 v, bytes32 r, bytes32 s) = _premiumAuthorization(q, holderKey);

        vm.expectRevert(CoverPool.CellCapExceeded.selector);
        vm.prank(relayer);
        book.buyWithAuthorization(q, signature, a.validAfter, a.validBefore, v, r, s);

        assertEq(dollar.balanceOf(holder), HOLDER_FUNDS);
        assertFalse(dollar.authorizationState(holder, a.nonce));
    }

    function test_BuyWithAuthorization_PaymentCannotBeTakenOutsideTheBook() public {
        Quote memory q = _standardQuote(60);
        (Authorization memory a, uint8 v, bytes32 r, bytes32 s) = _premiumAuthorization(q, holderKey);

        vm.expectRevert(abi.encodeWithSelector(TestDollar.CallerMustBePayee.selector, attacker, address(book)));
        vm.prank(attacker);
        dollar.receiveWithAuthorization(holder, address(book), q.premium, a.validAfter, a.validBefore, a.nonce, v, r, s);

        vm.expectRevert(TestDollar.InvalidAuthorizationSignature.selector);
        vm.prank(attacker);
        dollar.transferWithAuthorization(
            holder, address(book), q.premium, a.validAfter, a.validBefore, a.nonce, v, r, s
        );
    }

    function test_BuyWithAuthorization_RevertWhen_TheTokenDoesNotDeliverThePremium() public {
        SilentDollar silent = new SilentDollar();
        CoverPool silentPool = new CoverPool(silent, owner, treasury, "Cover Pool Share", "cvUSD");
        CoverBook silentBook =
            new CoverBook(silent, silentPool, index, underwriter, treasury, 0, MAX_POLICY_PAYOUT, owner);
        vm.prank(owner);
        silentPool.setBook(address(silentBook));
        silent.mint(address(silentPool), POOL_DEPOSIT);

        Quote memory q = _standardQuote(0);
        bytes memory signature = _signDigest(underwriterKey, _quoteDigest(silentBook.DOMAIN_SEPARATOR(), q));

        vm.expectRevert(CoverBook.PremiumNotReceived.selector);
        vm.prank(relayer);
        silentBook.buyWithAuthorization(q, signature, 0, type(uint256).max, 27, bytes32(0), bytes32(0));

        assertEq(silentBook.policyCount(), 0);
        assertEq(silentPool.lockedExposure(), 0);
    }

    // ───────────────────────────── helpers ─────────────────────────────

    function _copy(Quote memory q) private pure returns (Quote memory) {
        return Quote(q.holder, q.key, q.start, q.end, q.ratePerSecond, q.premium, q.expiry, q.salt);
    }

    function _expectBadSignature(Quote memory q, bytes memory signature) private {
        vm.expectRevert(CoverBook.BadQuoteSignature.selector);
        vm.prank(holder);
        book.buy(q, signature);
    }

    function _expectBuyRevert(Quote memory q, bytes4 selector) private {
        bytes memory signature = _signQuote(q);
        vm.expectRevert(selector);
        vm.prank(holder);
        book.buy(q, signature);
    }

    function _freshBookWithSilentOracle() private returns (CoverBook) {
        IWeatherIndex silent = IWeatherIndex(address(new SilentIndex()));
        return new CoverBook(dollar, pool, silent, underwriter, treasury, 0, MAX_POLICY_PAYOUT, owner);
    }
}

/// @dev An index that has never accepted a report.
contract SilentIndex {
    function heartbeat() external pure returns (uint64) {
        return 0;
    }

    function lastTo(uint256) external pure returns (uint64) {
        return 0;
    }

    function wetSeconds(uint256, uint64, uint64) external pure returns (uint256) {
        return 0;
    }
}
