// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {IReceiver} from "../src/interfaces/IReceiver.sol";
import {Reading} from "../src/Types.sol";
import {WeatherIndex} from "../src/WeatherIndex.sol";
import {ContractSigner} from "./mocks/ContractSigner.sol";
import {PermissionlessForwarder} from "./mocks/PermissionlessForwarder.sol";
import {Signing} from "./utils/Signing.sol";

abstract contract WeatherIndexFixture is Signing {
    WeatherIndex internal index;

    address internal owner = makeAddr("owner");
    address internal forwarder = makeAddr("forwarder");
    address internal keeper = makeAddr("keeper");
    address internal reporter;
    uint256 internal reporterKey;
    address internal attacker;
    uint256 internal attackerKey;

    uint256 internal constant KEY = (uint256(1) << 64) | (uint256(1044) << 32) | 420;
    uint256 internal constant OTHER_KEY = (uint256(1) << 64) | (uint256(1045) << 32) | 421;
    uint64 internal constant T0 = 1_760_000_400;

    bytes32 internal domain;
    uint64 internal issued;

    function setUp() public virtual {
        vm.warp(T0);
        (reporter, reporterKey) = makeAddrAndKey("reporter");
        (attacker, attackerKey) = makeAddrAndKey("attacker");
        index = new WeatherIndex(owner, reporter);
        vm.prank(owner);
        index.setForwarder(forwarder, true);
        domain = index.DOMAIN_SEPARATOR();
    }

    function _now() internal view returns (uint64) {
        return uint64(vm.getBlockTimestamp());
    }

    /// @dev Next acceptable `issuedAt`: the current time, or one past the previous report when the clock has
    /// not moved.
    function _nextIssuedAt() internal returns (uint64) {
        uint64 nowTs = _now();
        issued = issued >= nowTs ? issued + 1 : nowTs;
        return issued;
    }

    function _payload(Reading[] memory readings) internal returns (bytes memory) {
        return _signedReport(reporterKey, domain, readings, _nextIssuedAt());
    }

    function _submit(Reading[] memory readings) internal {
        bytes memory payload = _payload(readings);
        vm.prank(keeper);
        index.submit(payload);
    }

    function _submit(uint256 key, uint64 from, uint64 to, uint32 wet) internal {
        _submit(_readings(Reading(key, from, to, wet)));
    }

    function _assertCheckpoint(uint256 key, uint256 i, uint64 timestamp, uint256 cumulative) internal view {
        (uint64 ts, uint256 cum) = index.checkpointAt(key, i);
        assertEq(ts, timestamp, "checkpoint timestamp");
        assertEq(cum, cumulative, "checkpoint cumulative");
    }
}

contract WeatherIndexReportTest is WeatherIndexFixture {
    PermissionlessForwarder internal openForwarder;

    function setUp() public override {
        super.setUp();
        openForwarder = new PermissionlessForwarder();
        vm.warp(T0 + 300);
    }

    function _sample() internal pure returns (Reading[] memory) {
        return _readings(Reading(KEY, T0, T0 + 300, 120));
    }

    // ───────────────────────────── construction ─────────────────────────────

    function test_InitialState() public view {
        assertEq(index.owner(), owner);
        assertEq(index.reporter(), reporter);
        assertTrue(index.requireReporterSig());
        assertEq(index.maxReportAge(), 30 minutes);
        assertEq(index.heartbeat(), 0);
        assertEq(index.lastIssuedAt(), 0);
        assertTrue(index.isForwarder(forwarder));
        assertFalse(index.isForwarder(address(openForwarder)));
    }

    function test_DomainSeparator() public view {
        bytes32 expected = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("WeatherIndex"),
                keccak256("1"),
                block.chainid,
                address(index)
            )
        );
        assertEq(index.DOMAIN_SEPARATOR(), expected);
    }

    function test_TypeHashes() public view {
        assertEq(index.READING_TYPEHASH(), READING_TYPEHASH);
        assertEq(index.REPORT_TYPEHASH(), REPORT_TYPEHASH);
    }

    function test_HashReport_MatchesTheManualDigest() public view {
        Reading[] memory readings = _readings(Reading(KEY, T0, T0 + 300, 120), Reading(OTHER_KEY, T0 + 60, T0 + 300, 0));
        assertEq(index.hashReport(readings, T0 + 301), _reportDigest(domain, readings, T0 + 301));
        assertEq(index.hashReport(new Reading[](0), T0 + 301), _reportDigest(domain, new Reading[](0), T0 + 301));
    }

    function test_HashReport_MatchesTypedDataJson() public view {
        Reading[] memory readings = _readings(Reading(KEY, T0, T0 + 300, 120), Reading(OTHER_KEY, T0 + 60, T0 + 300, 0));
        uint64 issuedAt = T0 + 301;
        string memory json = string.concat(
            '{"types":{"EIP712Domain":[{"name":"name","type":"string"},{"name":"version","type":"string"},',
            '{"name":"chainId","type":"uint256"},{"name":"verifyingContract","type":"address"}],',
            '"Report":[{"name":"readings","type":"Reading[]"},{"name":"issuedAt","type":"uint64"}],',
            '"Reading":[{"name":"key","type":"uint256"},{"name":"from","type":"uint64"},',
            '{"name":"to","type":"uint64"},{"name":"wetSeconds","type":"uint32"}]},',
            '"primaryType":"Report","domain":{"name":"WeatherIndex","version":"1","chainId":',
            vm.toString(block.chainid),
            ',"verifyingContract":"',
            vm.toString(address(index)),
            '"},"message":{"readings":[',
            _readingJson(readings[0]),
            ",",
            _readingJson(readings[1]),
            '],"issuedAt":',
            vm.toString(uint256(issuedAt)),
            "}}"
        );
        assertEq(index.hashReport(readings, issuedAt), vm.eip712HashTypedData(json));
    }

    function _readingJson(Reading memory r) private pure returns (string memory) {
        return string.concat(
            '{"key":"',
            vm.toString(r.key),
            '","from":',
            vm.toString(uint256(r.from)),
            ',"to":',
            vm.toString(uint256(r.to)),
            ',"wetSeconds":',
            vm.toString(uint256(r.wetSeconds)),
            "}"
        );
    }

    // ───────────────────────────── forwarder path ─────────────────────────────

    function test_OnReport_AcceptsASignedReportFromAnAllowedForwarder() public {
        bytes memory payload = _payload(_sample());

        vm.expectEmit(address(index));
        emit WeatherIndex.WeatherReported(KEY, T0, T0 + 300, 120, 120);
        vm.expectEmit(address(index));
        emit WeatherIndex.Heartbeat(T0 + 300);
        vm.prank(forwarder);
        index.onReport(hex"c0ffee", payload);

        assertEq(index.lastTo(KEY), T0 + 300);
        assertEq(index.heartbeat(), T0 + 300);
        assertEq(index.lastIssuedAt(), issued);
    }

    function test_OnReport_RevertWhen_CallerIsNotAnAllowedForwarder() public {
        bytes memory payload = _payload(_sample());

        vm.expectRevert(WeatherIndex.NotForwarder.selector);
        vm.prank(keeper);
        index.onReport("", payload);

        vm.expectRevert(WeatherIndex.NotForwarder.selector);
        vm.prank(reporter);
        index.onReport("", payload);
    }

    function test_OnReport_RevertWhen_ForwarderWasRemoved() public {
        vm.prank(owner);
        index.setForwarder(forwarder, false);
        bytes memory payload = _payload(_sample());

        vm.expectRevert(WeatherIndex.NotForwarder.selector);
        vm.prank(forwarder);
        index.onReport("", payload);
    }

    function test_OnReport_RevertWhen_SignatureIsMissing() public {
        bytes memory payload = abi.encode(_sample(), _now(), bytes(""));

        vm.expectRevert(WeatherIndex.BadReporterSignature.selector);
        vm.prank(forwarder);
        index.onReport("", payload);
    }

    function test_OnReport_RevertWhen_SignedBySomeoneElse() public {
        bytes memory payload = _signedReport(attackerKey, domain, _sample(), _now());

        vm.expectRevert(WeatherIndex.BadReporterSignature.selector);
        vm.prank(forwarder);
        index.onReport("", payload);
    }

    function test_OnReport_AcceptsAnUnsignedReportWhenTheSignatureIsNotRequired() public {
        vm.prank(owner);
        index.setRequireReporterSig(false);
        bytes memory payload = abi.encode(_sample(), _now(), bytes(""));

        vm.prank(forwarder);
        index.onReport("", payload);

        assertEq(index.lastTo(KEY), T0 + 300);
        assertEq(index.wetSeconds(KEY, T0, T0 + 300), 120);
        assertEq(index.lastIssuedAt(), _now());
    }

    function test_OnReport_StillOrdersUnsignedReports() public {
        vm.prank(owner);
        index.setRequireReporterSig(false);
        bytes memory payload = abi.encode(new Reading[](0), _now(), bytes(""));
        vm.prank(forwarder);
        index.onReport("", payload);

        vm.expectRevert(WeatherIndex.StaleReport.selector);
        vm.prank(forwarder);
        index.onReport("", payload);
    }

    // ───────────────────────────── spoofing through an open forwarder ─────────────────────────────

    function test_Spoof_ForgedReportThroughAPermissionlessForwarderReverts() public {
        vm.prank(owner);
        index.setForwarder(address(openForwarder), true);

        Reading[] memory forged = _readings(Reading(KEY, T0, T0 + 300, 300));

        // The attacker signs the forged readings with their own key.
        bytes memory selfSigned = _signedReport(attackerKey, domain, forged, _now());
        vm.expectRevert(WeatherIndex.BadReporterSignature.selector);
        vm.prank(attacker);
        openForwarder.report(address(index), "", selfSigned);

        // The attacker lifts a genuine signature and swaps the readings underneath it.
        bytes memory genuineSignature = _signDigest(reporterKey, _reportDigest(domain, _sample(), _now()));
        vm.expectRevert(WeatherIndex.BadReporterSignature.selector);
        vm.prank(attacker);
        openForwarder.report(address(index), "", abi.encode(forged, _now(), genuineSignature));

        // No signature at all.
        vm.expectRevert(WeatherIndex.BadReporterSignature.selector);
        vm.prank(attacker);
        openForwarder.report(address(index), "", abi.encode(forged, _now(), bytes("")));

        assertEq(index.lastTo(KEY), 0);
        assertEq(index.heartbeat(), 0);
        assertEq(index.wetSeconds(KEY, T0, T0 + 300), 0);
    }

    function test_Spoof_ReplayThroughAPermissionlessForwarderReverts() public {
        vm.prank(owner);
        index.setForwarder(address(openForwarder), true);
        bytes memory payload = _payload(_sample());
        vm.prank(keeper);
        index.submit(payload);

        vm.expectRevert(WeatherIndex.StaleReport.selector);
        vm.prank(attacker);
        openForwarder.report(address(index), "", payload);
    }

    function test_Spoof_RelayingAGenuineReportOnlyDeliversIt() public {
        vm.prank(owner);
        index.setForwarder(address(openForwarder), true);
        bytes memory payload = _payload(_sample());

        vm.prank(attacker);
        openForwarder.report(address(index), "", payload);

        assertEq(index.wetSeconds(KEY, T0, T0 + 300), 120);
    }

    // ───────────────────────────── direct path ─────────────────────────────

    function test_Submit_AcceptsASignedReportFromAnyone() public {
        bytes memory payload = _payload(_sample());

        vm.prank(attacker);
        index.submit(payload);

        assertEq(index.lastTo(KEY), T0 + 300);
        assertEq(index.heartbeat(), T0 + 300);
    }

    function test_Submit_RevertWhen_SignatureIsBadEvenIfNotRequiredForForwarders() public {
        vm.prank(owner);
        index.setRequireReporterSig(false);

        bytes memory unsigned = abi.encode(_sample(), _now(), bytes(""));
        vm.expectRevert(WeatherIndex.BadReporterSignature.selector);
        index.submit(unsigned);

        bytes memory selfSigned = _signedReport(attackerKey, domain, _sample(), _now());
        vm.expectRevert(WeatherIndex.BadReporterSignature.selector);
        index.submit(selfSigned);
    }

    function test_Submit_RevertWhen_ReadingsDifferFromTheSignedOnes() public {
        bytes memory signature = _signDigest(reporterKey, _reportDigest(domain, _sample(), _now()));
        Reading[] memory tampered = _readings(Reading(KEY, T0, T0 + 300, 121));

        vm.expectRevert(WeatherIndex.BadReporterSignature.selector);
        index.submit(abi.encode(tampered, _now(), signature));
    }

    function test_Submit_RevertWhen_IssuedAtDiffersFromTheSignedOne() public {
        bytes memory signature = _signDigest(reporterKey, _reportDigest(domain, _sample(), _now()));

        vm.expectRevert(WeatherIndex.BadReporterSignature.selector);
        index.submit(abi.encode(_sample(), _now() + 1, signature));
    }

    function test_Submit_RevertWhen_SignedForAnotherIndex() public {
        WeatherIndex other = new WeatherIndex(owner, reporter);
        bytes memory payload = _signedReport(reporterKey, other.DOMAIN_SEPARATOR(), _sample(), _now());

        vm.expectRevert(WeatherIndex.BadReporterSignature.selector);
        index.submit(payload);
    }

    function test_Submit_RevertWhen_NoReporterIsConfigured() public {
        vm.prank(owner);
        index.setReporter(address(0));

        vm.expectRevert(WeatherIndex.BadReporterSignature.selector);
        index.submit(abi.encode(_sample(), _now(), bytes("")));

        // A malformed signature recovers to nothing; it must not match the empty reporter either.
        bytes memory junk = abi.encodePacked(bytes32(uint256(1)), bytes32(uint256(1)), uint8(27));
        vm.expectRevert(WeatherIndex.BadReporterSignature.selector);
        index.submit(abi.encode(_sample(), _now(), junk));
    }

    function test_Submit_AcceptsAContractReporter() public {
        ContractSigner wallet = new ContractSigner(reporter);
        vm.prank(owner);
        index.setReporter(address(wallet));

        index.submit(_payload(_sample()));
        assertEq(index.lastTo(KEY), T0 + 300);

        bytes memory forged = _signedReport(attackerKey, domain, new Reading[](0), _now() + 5);
        vm.expectRevert(WeatherIndex.BadReporterSignature.selector);
        index.submit(forged);
    }

    function test_Submit_RevertWhen_Replayed() public {
        bytes memory payload = _payload(_sample());
        index.submit(payload);

        vm.expectRevert(WeatherIndex.StaleReport.selector);
        index.submit(payload);
    }

    function test_Submit_RevertWhen_IssuedBeforeTheLastAcceptedReport() public {
        bytes memory older = _signedReport(reporterKey, domain, new Reading[](0), _now() - 10);
        bytes memory newer = _signedReport(reporterKey, domain, new Reading[](0), _now());
        index.submit(newer);

        vm.expectRevert(WeatherIndex.StaleReport.selector);
        index.submit(older);
    }

    function test_Submit_RevertWhen_IssuedInTheFuture() public {
        bytes memory payload = _signedReport(reporterKey, domain, new Reading[](0), _now() + 61);

        vm.expectRevert(WeatherIndex.ReportFromFuture.selector);
        index.submit(payload);
    }

    function test_Submit_ToleratesSixtySecondsOfClockSkew() public {
        index.submit(_signedReport(reporterKey, domain, new Reading[](0), _now() + 60));
        assertEq(index.lastIssuedAt(), _now() + 60);
    }

    function test_Submit_RevertWhen_TooOld() public {
        bytes memory payload = _signedReport(reporterKey, domain, new Reading[](0), _now());
        vm.warp(_now() + 30 minutes + 1);

        vm.expectRevert(WeatherIndex.ReportTooOld.selector);
        index.submit(payload);
    }

    function test_Submit_AcceptsAReportAtTheAgeLimit() public {
        bytes memory payload = _signedReport(reporterKey, domain, new Reading[](0), _now());
        vm.warp(_now() + 30 minutes);

        index.submit(payload);
        assertEq(index.heartbeat(), _now() - 30 minutes);
    }

    function test_Heartbeat_IsWhenTheReportWasIssuedNotWhenItLanded() public {
        uint64 issuedAt = _now();
        bytes memory payload = _signedReport(reporterKey, domain, new Reading[](0), issuedAt);
        vm.warp(issuedAt + 10 minutes);

        vm.expectEmit(address(index));
        emit WeatherIndex.Heartbeat(issuedAt);
        index.submit(payload);

        assertEq(index.heartbeat(), issuedAt);
        assertEq(index.lastIssuedAt(), issuedAt);
    }

    function test_Heartbeat_NeverRunsAheadOfTheClock() public {
        index.submit(_signedReport(reporterKey, domain, new Reading[](0), _now() + 60));
        assertEq(index.heartbeat(), _now());
        assertEq(index.lastIssuedAt(), _now() + 60);
    }

    function test_Heartbeat_OnlyMovesForward() public {
        index.submit(_signedReport(reporterKey, domain, new Reading[](0), _now() + 50));
        uint64 first = index.heartbeat();

        vm.warp(_now() + 10);
        index.submit(_signedReport(reporterKey, domain, new Reading[](0), _now() + 41));
        assertGt(index.heartbeat(), first);
        assertEq(index.heartbeat(), _now());
    }

    function test_Submit_EmptyReportIsAHeartbeat() public {
        bytes memory payload = _payload(new Reading[](0));

        vm.expectEmit(address(index));
        emit WeatherIndex.Heartbeat(T0 + 300);
        index.submit(payload);

        assertEq(index.heartbeat(), T0 + 300);
        assertEq(index.checkpointCount(KEY), 0);
    }

    function test_Submit_RevertWhen_PayloadIsMalformed() public {
        vm.expectRevert();
        index.submit(hex"1234");
    }

    // ───────────────────────────── administration ─────────────────────────────

    function test_SetForwarder() public {
        vm.expectEmit(address(index));
        emit WeatherIndex.ForwarderSet(keeper, true);
        vm.prank(owner);
        index.setForwarder(keeper, true);
        assertTrue(index.isForwarder(keeper));
        assertTrue(index.isForwarder(forwarder));

        vm.expectEmit(address(index));
        emit WeatherIndex.ForwarderSet(keeper, false);
        vm.prank(owner);
        index.setForwarder(keeper, false);
        assertFalse(index.isForwarder(keeper));
    }

    function test_SetForwarder_RevertWhen_CallerIsNotOwner() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, attacker));
        vm.prank(attacker);
        index.setForwarder(attacker, true);
    }

    function test_SetReporter() public {
        vm.expectEmit(address(index));
        emit WeatherIndex.ReporterSet(keeper);
        vm.prank(owner);
        index.setReporter(keeper);
        assertEq(index.reporter(), keeper);
    }

    function test_SetReporter_RevertWhen_CallerIsNotOwner() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, attacker));
        vm.prank(attacker);
        index.setReporter(attacker);
    }

    function test_SetReporter_InvalidatesThePreviousKey() public {
        bytes memory payload = _payload(_sample());
        vm.prank(owner);
        index.setReporter(keeper);

        vm.expectRevert(WeatherIndex.BadReporterSignature.selector);
        index.submit(payload);
    }

    function test_SetRequireReporterSig() public {
        vm.expectEmit(address(index));
        emit WeatherIndex.RequireReporterSigSet(false);
        vm.prank(owner);
        index.setRequireReporterSig(false);
        assertFalse(index.requireReporterSig());
    }

    function test_SetRequireReporterSig_RevertWhen_CallerIsNotOwner() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, attacker));
        vm.prank(attacker);
        index.setRequireReporterSig(false);
    }

    function test_SetMaxReportAge() public {
        vm.expectEmit(address(index));
        emit WeatherIndex.MaxReportAgeSet(5 minutes);
        vm.prank(owner);
        index.setMaxReportAge(5 minutes);
        assertEq(index.maxReportAge(), 5 minutes);

        bytes memory payload = _signedReport(reporterKey, domain, new Reading[](0), _now());
        vm.warp(_now() + 5 minutes + 1);
        vm.expectRevert(WeatherIndex.ReportTooOld.selector);
        index.submit(payload);
    }

    function test_SetMaxReportAge_RevertWhen_Zero() public {
        vm.expectRevert(WeatherIndex.MaxReportAgeInvalid.selector);
        vm.prank(owner);
        index.setMaxReportAge(0);
    }

    function test_SetMaxReportAge_RevertWhen_CallerIsNotOwner() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, attacker));
        vm.prank(attacker);
        index.setMaxReportAge(1);
    }

    function test_OwnershipTransferTakesTwoSteps() public {
        vm.prank(owner);
        index.transferOwnership(keeper);
        assertEq(index.owner(), owner);
        assertEq(index.pendingOwner(), keeper);

        vm.prank(keeper);
        index.acceptOwnership();
        assertEq(index.owner(), keeper);
    }

    function test_SupportsInterface() public view {
        assertTrue(index.supportsInterface(type(IReceiver).interfaceId));
        assertTrue(index.supportsInterface(type(IERC165).interfaceId));
        assertFalse(index.supportsInterface(0xffffffff));
        assertFalse(index.supportsInterface(0xdeadbeef));
        assertEq(type(IReceiver).interfaceId, IReceiver.onReport.selector);
    }
}

contract WeatherIndexTimelineTest is WeatherIndexFixture {
    function setUp() public override {
        super.setUp();
        vm.warp(T0 + 1 hours);
    }

    // ───────────────────────────── checkpoints ─────────────────────────────

    function test_FirstReading_OpensTheTimeline() public {
        _submit(KEY, T0, T0 + 300, 120);

        assertEq(index.lastTo(KEY), T0 + 300);
        assertEq(index.checkpointCount(KEY), 2);
        _assertCheckpoint(KEY, 0, T0, 0);
        _assertCheckpoint(KEY, 1, T0 + 300, 120);
    }

    function test_ContiguousReading_AppendsACheckpoint() public {
        _submit(KEY, T0, T0 + 300, 120);

        vm.expectEmit(address(index));
        emit WeatherIndex.WeatherReported(KEY, T0 + 300, T0 + 600, 300, 420);
        _submit(KEY, T0 + 300, T0 + 600, 300);

        assertEq(index.checkpointCount(KEY), 3);
        _assertCheckpoint(KEY, 2, T0 + 600, 420);
        assertEq(index.lastTo(KEY), T0 + 600);
    }

    function test_GapBetweenReadings_IsRecordedAsDry() public {
        _submit(KEY, T0, T0 + 300, 300);
        _submit(KEY, T0 + 600, T0 + 900, 300);

        assertEq(index.checkpointCount(KEY), 4);
        _assertCheckpoint(KEY, 2, T0 + 600, 300);
        _assertCheckpoint(KEY, 3, T0 + 900, 600);
        assertEq(index.wetSeconds(KEY, T0 + 300, T0 + 600), 0);
        assertEq(index.wetSeconds(KEY, T0, T0 + 900), 600);
    }

    function test_OverlappingReading_StartsAtTheLastCheckpoint() public {
        _submit(KEY, T0, T0 + 300, 100);

        vm.expectEmit(address(index));
        emit WeatherIndex.WeatherReported(KEY, T0 + 300, T0 + 600, 300, 400);
        _submit(KEY, T0 + 100, T0 + 600, 300);

        assertEq(index.checkpointCount(KEY), 3);
        assertEq(index.wetSeconds(KEY, T0, T0 + 300), 100);
        assertEq(index.wetSeconds(KEY, T0 + 300, T0 + 600), 300);
    }

    function test_OverlappingReading_RevertWhen_WetterThanTheUnreportedSpan() public {
        _submit(KEY, T0, T0 + 300, 100);

        bytes memory payload = _payload(_readings(Reading(KEY, T0 + 100, T0 + 600, 301)));
        vm.expectRevert(abi.encodeWithSelector(WeatherIndex.ReadingTooWet.selector, KEY));
        index.submit(payload);
    }

    function test_DryReadings_ExtendTheFlatSegmentInPlace() public {
        _submit(KEY, T0, T0 + 300, 0);
        assertEq(index.checkpointCount(KEY), 2);

        _submit(KEY, T0 + 300, T0 + 600, 0);
        _submit(KEY, T0 + 600, T0 + 900, 0);
        assertEq(index.checkpointCount(KEY), 2);
        _assertCheckpoint(KEY, 1, T0 + 900, 0);
        assertEq(index.lastTo(KEY), T0 + 900);

        _submit(KEY, T0 + 1000, T0 + 1200, 50);
        assertEq(index.checkpointCount(KEY), 3);
        _assertCheckpoint(KEY, 1, T0 + 1000, 0);
        _assertCheckpoint(KEY, 2, T0 + 1200, 50);

        _submit(KEY, T0 + 1200, T0 + 1500, 0);
        assertEq(index.checkpointCount(KEY), 4);
        _submit(KEY, T0 + 1500, T0 + 1800, 0);
        assertEq(index.checkpointCount(KEY), 4);
        _assertCheckpoint(KEY, 3, T0 + 1800, 50);

        assertEq(index.wetSeconds(KEY, T0, T0 + 1000), 0);
        assertEq(index.wetSeconds(KEY, T0 + 1000, T0 + 1100), 25);
        assertEq(index.wetSeconds(KEY, T0, T0 + 1800), 50);
    }

    function test_Reading_RevertWhen_NotNewerThanTheLastCheckpoint() public {
        _submit(KEY, T0, T0 + 300, 100);

        bytes memory same = _payload(_readings(Reading(KEY, T0, T0 + 300, 100)));
        vm.expectRevert(abi.encodeWithSelector(WeatherIndex.ReadingNotNewer.selector, KEY));
        index.submit(same);

        bytes memory older = _payload(_readings(Reading(KEY, T0, T0 + 299, 0)));
        vm.expectRevert(abi.encodeWithSelector(WeatherIndex.ReadingNotNewer.selector, KEY));
        index.submit(older);
    }

    function test_Reading_RevertWhen_EndsInTheFuture() public {
        bytes memory payload = _payload(_readings(Reading(KEY, T0, _now() + 1, 0)));
        vm.expectRevert(abi.encodeWithSelector(WeatherIndex.ReadingInFuture.selector, KEY));
        index.submit(payload);
    }

    function test_Reading_MayEndExactlyNow() public {
        _submit(KEY, _now() - 300, _now(), 300);
        assertEq(index.lastTo(KEY), _now());
    }

    function test_Reading_RevertWhen_WindowIsEmptyOrInverted() public {
        bytes memory empty = _payload(_readings(Reading(KEY, T0 + 300, T0 + 300, 0)));
        vm.expectRevert(abi.encodeWithSelector(WeatherIndex.ReadingWindowInvalid.selector, KEY));
        index.submit(empty);

        bytes memory inverted = _payload(_readings(Reading(KEY, T0 + 301, T0 + 300, 0)));
        vm.expectRevert(abi.encodeWithSelector(WeatherIndex.ReadingWindowInvalid.selector, KEY));
        index.submit(inverted);
    }

    function test_Reading_RevertWhen_WetterThanItsSpan() public {
        bytes memory payload = _payload(_readings(Reading(KEY, T0, T0 + 300, 301)));
        vm.expectRevert(abi.encodeWithSelector(WeatherIndex.ReadingTooWet.selector, KEY));
        index.submit(payload);
    }

    function test_Reading_MayBeWetForItsWholeSpan() public {
        _submit(KEY, T0, T0 + 300, 300);
        assertEq(index.wetSeconds(KEY, T0, T0 + 300), 300);
    }

    function test_Report_SecondReadingForAKeySeesTheFirst() public {
        _submit(_readings(Reading(KEY, T0, T0 + 300, 300), Reading(KEY, T0 + 100, T0 + 600, 300)));

        assertEq(index.checkpointCount(KEY), 3);
        assertEq(index.wetSeconds(KEY, T0, T0 + 600), 600);
        assertEq(index.lastTo(KEY), T0 + 600);
    }

    function test_Report_RevertWhen_AKeyIsRepeatedVerbatim() public {
        bytes memory payload = _payload(_readings(Reading(KEY, T0, T0 + 300, 300), Reading(KEY, T0, T0 + 300, 300)));
        vm.expectRevert(abi.encodeWithSelector(WeatherIndex.ReadingNotNewer.selector, KEY));
        index.submit(payload);
    }

    function test_Report_RevertWhen_ARepeatedKeyWouldCountTimeTwice() public {
        bytes memory payload = _payload(_readings(Reading(KEY, T0, T0 + 300, 300), Reading(KEY, T0, T0 + 400, 300)));
        vm.expectRevert(abi.encodeWithSelector(WeatherIndex.ReadingTooWet.selector, KEY));
        index.submit(payload);
    }

    function test_Report_RevertingReadingLeavesNoTrace() public {
        _submit(KEY, T0, T0 + 300, 100);
        uint64 heartbeatBefore = index.heartbeat();
        uint64 issuedBefore = index.lastIssuedAt();
        vm.warp(_now() + 600);

        bytes memory payload =
            _payload(_readings(Reading(OTHER_KEY, T0, T0 + 300, 10), Reading(KEY, T0 + 300, T0 + 600, 301)));
        vm.expectRevert(abi.encodeWithSelector(WeatherIndex.ReadingTooWet.selector, KEY));
        index.submit(payload);

        assertEq(index.heartbeat(), heartbeatBefore);
        assertEq(index.lastIssuedAt(), issuedBefore);
        assertEq(index.checkpointCount(OTHER_KEY), 0);
    }

    function test_KeysAreIndependent() public {
        _submit(_readings(Reading(KEY, T0, T0 + 300, 300), Reading(OTHER_KEY, T0 + 60, T0 + 240, 0)));

        assertEq(index.lastTo(KEY), T0 + 300);
        assertEq(index.lastTo(OTHER_KEY), T0 + 240);
        assertEq(index.wetSeconds(KEY, T0, T0 + 300), 300);
        assertEq(index.wetSeconds(OTHER_KEY, T0, T0 + 300), 0);
    }

    function test_CheckpointAt_RevertWhen_OutOfRange() public {
        _submit(KEY, T0, T0 + 300, 100);
        vm.expectRevert();
        index.checkpointAt(KEY, 2);
    }

    // ───────────────────────────── wetSeconds ─────────────────────────────

    function test_WetSeconds_IsZeroForAnUnknownKey() public view {
        assertEq(index.wetSeconds(KEY, 0, type(uint64).max), 0);
        assertEq(index.lastTo(KEY), 0);
        assertEq(index.checkpointCount(KEY), 0);
    }

    function test_WetSeconds_IsZeroForAnEmptyOrInvertedRange() public {
        _submit(KEY, T0, T0 + 300, 300);
        assertEq(index.wetSeconds(KEY, T0 + 100, T0 + 100), 0);
        assertEq(index.wetSeconds(KEY, T0 + 200, T0 + 100), 0);
    }

    function test_WetSeconds_IsFlatOutsideTheCheckpoints() public {
        _submit(KEY, T0, T0 + 300, 200);

        assertEq(index.wetSeconds(KEY, T0 - 1000, T0), 0);
        assertEq(index.wetSeconds(KEY, T0 + 300, T0 + 5000), 0);
        assertEq(index.wetSeconds(KEY, 0, type(uint64).max), 200);
    }

    function test_WetSeconds_InterpolatesInsideAnInterval() public {
        _submit(KEY, T0, T0 + 300, 150);

        assertEq(index.wetSeconds(KEY, T0, T0 + 100), 50);
        assertEq(index.wetSeconds(KEY, T0 + 100, T0 + 200), 50);
        assertEq(index.wetSeconds(KEY, T0 + 60, T0 + 300), 120);
        assertEq(index.wetSeconds(KEY, T0, T0 + 300), 150);
    }

    function test_WetSeconds_RoundsAgainstTheClaimant() public {
        // One wet second in every three.
        _submit(KEY, T0, T0 + 300, 100);

        // The start rounds up and the end rounds down.
        assertEq(index.wetSeconds(KEY, T0 + 1, T0 + 300), 99);
        assertEq(index.wetSeconds(KEY, T0, T0 + 299), 99);
        assertEq(index.wetSeconds(KEY, T0 + 1, T0 + 299), 98);
        assertEq(index.wetSeconds(KEY, T0 + 1, T0 + 2), 0);

        // Splitting a range never yields more than the range itself.
        uint256 whole = index.wetSeconds(KEY, T0, T0 + 300);
        uint256 parts = index.wetSeconds(KEY, T0, T0 + 100) + index.wetSeconds(KEY, T0 + 100, T0 + 200)
            + index.wetSeconds(KEY, T0 + 200, T0 + 300);
        assertEq(whole, 100);
        assertLe(parts, whole);
    }

    function test_WetSeconds_SpansSeveralIntervals() public {
        _submit(KEY, T0, T0 + 300, 300);
        _submit(KEY, T0 + 300, T0 + 600, 0);
        _submit(KEY, T0 + 600, T0 + 900, 150);

        assertEq(index.wetSeconds(KEY, T0 + 150, T0 + 750), 150 + 0 + 75);
        assertEq(index.wetSeconds(KEY, T0 + 299, T0 + 601), 1);
    }
}

contract WeatherIndexFuzzTest is WeatherIndexFixture {
    struct Segment {
        uint64 from;
        uint64 to;
        uint32 wet;
    }

    Segment[] internal segments;
    uint256 internal totalWet;

    /// @dev Reports `count` readings for KEY with random gaps, overlaps and wetness and records the effective
    /// segments for the reference model.
    function _buildTimeline(uint256 seed, uint256 count) internal returns (uint64 end) {
        uint64 cursor = T0;
        for (uint256 i = 0; i < count; ++i) {
            seed = uint256(keccak256(abi.encode(seed, i)));
            uint64 gap = seed % 4 == 0 ? uint64((seed >> 8) % 600) : 0;
            uint64 span = uint64(1 + (seed >> 24) % 900);
            uint64 overlap = (i != 0 && seed % 4 == 1) ? uint64((seed >> 40) % 300) : 0;
            uint32 wet = uint32((seed >> 56) % (span + 1));
            uint256 mode = (seed >> 96) % 4;
            if (mode == 0) wet = 0;
            if (mode == 1) wet = uint32(span);

            uint64 effectiveFrom = cursor + gap;
            uint64 to = effectiveFrom + span;
            uint64 from = gap == 0 ? effectiveFrom - overlap : effectiveFrom;

            vm.warp(to);
            _submit(KEY, from, to, wet);
            segments.push(Segment(effectiveFrom, to, wet));
            totalWet += wet;
            cursor = to;
        }
        return cursor;
    }

    /// @dev Exact cumulative wet time at `t`, scaled by 1e18. Segments are disjoint, so at most one term is
    /// truncated and the result is within one unit of the true value.
    function _referenceCumulative(uint64 t) internal view returns (uint256 scaled) {
        uint256 n = segments.length;
        for (uint256 i = 0; i < n; ++i) {
            Segment memory seg = segments[i];
            if (t >= seg.to) {
                scaled += uint256(seg.wet) * 1e18;
            } else if (t > seg.from) {
                scaled += uint256(seg.wet) * (t - seg.from) * 1e18 / (seg.to - seg.from);
            }
        }
    }

    function testFuzz_WetSeconds_TracksTheReferenceFromBelow(uint256 seed, uint8 count, uint64 a, uint64 b) public {
        uint64 end = _buildTimeline(seed, bound(count, 1, 40));
        a = uint64(bound(a, T0 - 100, end + 100));
        b = uint64(bound(b, a, end + 100));

        uint256 actual = index.wetSeconds(KEY, a, b) * 1e18;
        uint256 exact = _referenceCumulative(b) - _referenceCumulative(a);

        assertLe(actual, exact + 1, "pays more than was reported");
        assertGt(actual + 2e18, exact, "loses two seconds or more to rounding");
    }

    function testFuzz_WetSeconds_NeverExceedsElapsedTime(uint256 seed, uint8 count, uint64 a, uint64 b) public {
        uint64 end = _buildTimeline(seed, bound(count, 1, 40));
        a = uint64(bound(a, T0 - 100, end + 100));
        b = uint64(bound(b, a, end + 100));

        assertLe(index.wetSeconds(KEY, a, b), b - a);
    }

    function testFuzz_WetSeconds_SplittingNeverPaysMore(uint256 seed, uint8 count, uint64 a, uint64 b, uint64 c)
        public
    {
        uint64 end = _buildTimeline(seed, bound(count, 1, 40));
        a = uint64(bound(a, T0 - 100, end + 100));
        c = uint64(bound(c, a, end + 100));
        b = uint64(bound(b, a, c));

        uint256 whole = index.wetSeconds(KEY, a, c);
        assertLe(index.wetSeconds(KEY, a, b) + index.wetSeconds(KEY, b, c), whole);
        assertLe(index.wetSeconds(KEY, a, b), whole);
        assertLe(index.wetSeconds(KEY, b, c), whole);
    }

    function testFuzz_WetSeconds_IsExactOnReportedBoundaries(uint256 seed, uint8 count) public {
        uint64 end = _buildTimeline(seed, bound(count, 1, 40));

        uint256 n = segments.length;
        for (uint256 i = 0; i < n; ++i) {
            assertEq(index.wetSeconds(KEY, segments[i].from, segments[i].to), segments[i].wet);
        }
        assertEq(index.wetSeconds(KEY, 0, type(uint64).max), totalWet);
        assertEq(index.wetSeconds(KEY, T0, end), totalWet);
        assertEq(index.lastTo(KEY), end);
    }

    function testFuzz_Reading_NeverAcceptsMoreWetnessThanTime(uint64 from, uint64 to, uint32 wet) public {
        vm.warp(T0 + 30 days);
        _submit(KEY, T0, T0 + 300, 100);

        from = uint64(bound(from, T0 - 1 days, T0 + 2 days));
        to = uint64(bound(to, T0 - 1 days, T0 + 2 days));
        uint64 effectiveFrom = from > T0 + 300 ? from : T0 + 300;

        bytes memory payload = _payload(_readings(Reading(KEY, from, to, wet)));
        bool acceptable = to > T0 + 300 && from < to && wet <= to - effectiveFrom;
        if (!acceptable) vm.expectRevert();
        index.submit(payload);

        if (acceptable) {
            assertEq(index.wetSeconds(KEY, T0 + 300, to), wet);
            assertLe(index.wetSeconds(KEY, 0, type(uint64).max), to - T0);
        }
    }
}
