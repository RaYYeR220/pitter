// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {IReceiver} from "./interfaces/IReceiver.sol";
import {IWeatherIndex} from "./interfaces/IWeatherIndex.sol";
import {Reading} from "./Types.sol";

/// @title WeatherIndex
/// @notice On-chain record of how long each insured trigger was met in each cell. For every key
/// `(triggerId << 64) | cellId` it keeps a timeline of checkpoints `(timestamp, cumulative wet seconds)` and
/// answers how many wet seconds fall between two timestamps.
///
/// Reports arrive either through an allowlisted Chainlink forwarder (`onReport`) or directly (`submit`). A
/// forwarder only proves that *a* workflow produced the bytes, and a simulation forwarder proves nothing at
/// all, so every report carries its own EIP-712 signature from the `reporter` key, and that signature is
/// checked on both paths, always. The allowlist is a second gate on `onReport`, not a substitute.
///
/// @dev Invariants:
/// - a timeline only ever grows forward in time, so `wetSeconds(key, a, b)` is final once `b <= lastTo(key)`;
/// - a reading can never add more wet seconds than the time it newly covers, so
///   `wetSeconds(key, a, b) <= b - a` for every range;
/// - a report is accepted at most once (`issuedAt` strictly increases);
/// - `heartbeat` never runs ahead of the chain clock and never moves backwards.
contract WeatherIndex is IReceiver, IWeatherIndex, EIP712, Ownable2Step {
    struct Checkpoint {
        uint64 timestamp;
        uint192 cumulative;
    }

    /// @notice EIP-712 type hash of one reading.
    bytes32 public constant READING_TYPEHASH =
        keccak256("Reading(uint256 key,uint64 from,uint64 to,uint32 wetSeconds)");

    /// @notice EIP-712 type hash of a report.
    bytes32 public constant REPORT_TYPEHASH = keccak256(
        "Report(Reading[] readings,uint64 issuedAt)Reading(uint256 key,uint64 from,uint64 to,uint32 wetSeconds)"
    );

    /// @notice How far ahead of the chain clock a report's `issuedAt` may be.
    uint64 public constant MAX_CLOCK_SKEW = 60;

    /// @notice Key that signs reports. The zero address disables every signed path.
    address public reporter;

    /// @notice `issuedAt` of the last accepted report.
    uint64 public lastIssuedAt;

    /// @inheritdoc IWeatherIndex
    uint64 public heartbeat;

    /// @notice Oldest `issuedAt`, relative to the chain clock, that is still accepted.
    uint64 public maxReportAge = 30 minutes;

    /// @notice Forwarders allowed to call `onReport`.
    mapping(address forwarder => bool) public isForwarder;

    mapping(uint256 key => Checkpoint[]) private _checkpoints;

    /// @notice A reading was recorded. `from` is where the reading took effect, which is later than the
    /// reported start when the reading overlapped time that was already on the timeline.
    event WeatherReported(uint256 indexed key, uint64 from, uint64 to, uint32 wetSeconds, uint256 cumulative);

    /// @notice A report was accepted; `timestamp` is the new heartbeat.
    event Heartbeat(uint256 timestamp);

    event ForwarderSet(address indexed forwarder, bool allowed);
    event ReporterSet(address indexed reporter);
    event MaxReportAgeSet(uint64 maxReportAge);

    error NotForwarder();
    error BadReporterSignature();
    error StaleReport();
    error ReportFromFuture();
    error ReportTooOld();
    error ReadingNotNewer(uint256 key);
    error ReadingInFuture(uint256 key);
    error ReadingWindowInvalid(uint256 key);
    error ReadingTooWet(uint256 key);
    error MaxReportAgeInvalid();

    /// @param initialOwner Account that manages forwarders, the reporter key and the report limits.
    /// @param reporter_ Key whose signature authenticates reports. Zero leaves every signed path closed until
    /// the owner sets one.
    // forge-lint: disable-next-line(missing-zero-check)
    constructor(address initialOwner, address reporter_) EIP712("WeatherIndex", "1") Ownable(initialOwner) {
        reporter = reporter_;
        emit ReporterSet(reporter_);
    }

    // ───────────────────────────── reports ─────────────────────────────

    /// @notice Chainlink forwarder entry point.
    /// @dev Reverts with `NotForwarder` unless the caller is allowlisted, and `BadReporterSignature` unless the
    /// report carries the reporter's signature.
    /// @param metadata Workflow metadata attached by the forwarder; unused, as the signature authenticates.
    /// @param report `abi.encode(Reading[] readings, uint64 issuedAt, bytes signature)`.
    function onReport(bytes calldata metadata, bytes calldata report) external {
        metadata;
        if (!isForwarder[msg.sender]) revert NotForwarder();
        _ingest(report);
    }

    /// @notice Delivers a report directly. Anyone may call; the reporter's signature is always verified.
    /// @param report `abi.encode(Reading[] readings, uint64 issuedAt, bytes signature)`.
    function submit(bytes calldata report) external {
        _ingest(report);
    }

    /// @notice EIP-712 digest the reporter signs for a report.
    function hashReport(Reading[] calldata readings, uint64 issuedAt) external view returns (bytes32 digest) {
        return _hashReport(readings, issuedAt);
    }

    /// @notice EIP-712 domain separator of this index (`name` "WeatherIndex", `version` "1").
    function DOMAIN_SEPARATOR() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    // ───────────────────────────── views ─────────────────────────────

    /// @inheritdoc IWeatherIndex
    /// @dev Cumulative wet time is interpolated linearly inside a reported interval and is flat before the
    /// first and after the last checkpoint. The value at `b` is rounded down and the value at `a` is rounded
    /// up, so the result never exceeds what was reported and splitting a range into pieces never yields more
    /// than the whole range.
    function wetSeconds(uint256 key, uint64 a, uint64 b) external view returns (uint256) {
        if (b <= a) return 0;
        Checkpoint[] storage timeline = _checkpoints[key];
        uint256 upper = _cumulativeAt(timeline, b, false);
        if (upper == 0) return 0;
        uint256 lower = _cumulativeAt(timeline, a, true);
        return upper > lower ? upper - lower : 0;
    }

    /// @inheritdoc IWeatherIndex
    function lastTo(uint256 key) public view returns (uint64) {
        Checkpoint[] storage timeline = _checkpoints[key];
        uint256 n = timeline.length;
        return n == 0 ? 0 : timeline[n - 1].timestamp;
    }

    /// @notice Number of checkpoints stored for `key`.
    function checkpointCount(uint256 key) external view returns (uint256) {
        return _checkpoints[key].length;
    }

    /// @notice Checkpoint `i` of `key`.
    function checkpointAt(uint256 key, uint256 i) external view returns (uint64 timestamp, uint256 cumulative) {
        Checkpoint storage checkpoint = _checkpoints[key][i];
        return (checkpoint.timestamp, checkpoint.cumulative);
    }

    /// @inheritdoc IERC165
    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == type(IReceiver).interfaceId || interfaceId == type(IERC165).interfaceId;
    }

    // ───────────────────────────── administration ─────────────────────────────

    /// @notice Allows or removes a forwarder for `onReport`.
    function setForwarder(address forwarder, bool allowed) external onlyOwner {
        // forge-lint: disable-next-line(missing-events-access-control)
        isForwarder[forwarder] = allowed;
        emit ForwarderSet(forwarder, allowed);
    }

    /// @notice Replaces the reporter key. Reports signed by the previous key stop being accepted. Setting the
    /// zero address closes every signed path, which is the way to stop a leaked key before a new one exists.
    // forge-lint: disable-next-line(missing-zero-check)
    function setReporter(address reporter_) external onlyOwner {
        reporter = reporter_;
        emit ReporterSet(reporter_);
    }

    /// @notice Sets the maximum accepted report age in seconds.
    function setMaxReportAge(uint64 maxReportAge_) external onlyOwner {
        if (maxReportAge_ == 0) revert MaxReportAgeInvalid();
        maxReportAge = maxReportAge_;
        emit MaxReportAgeSet(maxReportAge_);
    }

    // ───────────────────────────── internals ─────────────────────────────

    /// @dev Shared by both entry points: orders the report, authenticates it, then records every reading. Any
    /// invalid reading reverts the whole report, leaving no partial state behind.
    function _ingest(bytes calldata report) private {
        (Reading[] memory readings, uint64 issuedAt, bytes memory signature) =
            abi.decode(report, (Reading[], uint64, bytes));

        if (issuedAt <= lastIssuedAt) revert StaleReport();
        if (issuedAt > block.timestamp + MAX_CLOCK_SKEW) revert ReportFromFuture();
        if (block.timestamp > issuedAt && block.timestamp - issuedAt > maxReportAge) revert ReportTooOld();

        address signer = reporter;
        if (
            signer == address(0)
                || !SignatureChecker.isValidSignatureNow(signer, _hashReport(readings, issuedAt), signature)
        ) revert BadReporterSignature();

        // Liveness is when the reporter spoke, not when its words arrived: a report held back and delivered
        // late must not make a silent oracle look alive.
        uint64 beat = issuedAt < block.timestamp ? issuedAt : SafeCast.toUint64(block.timestamp);
        lastIssuedAt = issuedAt;
        heartbeat = beat;

        uint256 count = readings.length;
        for (uint256 i = 0; i < count; ++i) {
            _record(readings[i]);
        }
        emit Heartbeat(beat);
    }

    /// @dev Appends one reading to its key's timeline. Readings for the same key inside one report are applied
    /// in order, each seeing the state left by the previous one, so time is never counted twice.
    function _record(Reading memory reading) private {
        Checkpoint[] storage timeline = _checkpoints[reading.key];
        uint256 n = timeline.length;
        uint64 last = 0;
        uint192 cumulative = 0;
        if (n != 0) {
            Checkpoint storage tip = timeline[n - 1];
            last = tip.timestamp;
            cumulative = tip.cumulative;
        }

        if (reading.to <= last) revert ReadingNotNewer(reading.key);
        if (reading.to > block.timestamp) revert ReadingInFuture(reading.key);
        if (reading.from >= reading.to) revert ReadingWindowInvalid(reading.key);

        // Time up to `last` is already final; only the part after it is new.
        uint64 from = (n == 0 || reading.from > last) ? reading.from : last;
        if (reading.wetSeconds > reading.to - from) revert ReadingTooWet(reading.key);

        if (n == 0) {
            timeline.push(Checkpoint(from, 0));
        } else if (from > last) {
            _extendFlat(timeline, from);
        }

        if (reading.wetSeconds == 0) {
            _extendFlat(timeline, reading.to);
        } else {
            cumulative += reading.wetSeconds;
            timeline.push(Checkpoint(reading.to, cumulative));
        }

        emit WeatherReported(reading.key, from, reading.to, reading.wetSeconds, cumulative);
    }

    /// @dev Carries the timeline forward to `timestamp` with no new wet time. When the timeline already ends
    /// in a dry stretch the last checkpoint is moved instead of adding one; the curve is the same either way.
    function _extendFlat(Checkpoint[] storage timeline, uint64 timestamp) private {
        uint256 n = timeline.length;
        Checkpoint storage tip = timeline[n - 1];
        uint192 cumulative = tip.cumulative;
        if (n >= 2 && timeline[n - 2].cumulative == cumulative) {
            tip.timestamp = timestamp;
        } else {
            timeline.push(Checkpoint(timestamp, cumulative));
        }
    }

    /// @dev Cumulative wet seconds at `t`. Probes backwards from the newest checkpoint in doubling steps, then
    /// bisects, because settlements almost always ask about recent time.
    function _cumulativeAt(Checkpoint[] storage timeline, uint64 t, bool roundUp) private view returns (uint256) {
        uint256 n = timeline.length;
        if (n == 0) return 0;

        Checkpoint memory right = timeline[n - 1];
        if (t >= right.timestamp) return right.cumulative;
        if (t <= timeline[0].timestamp) return 0;

        // Find `lo` and `hi = lo + 1` with timeline[lo].timestamp <= t < timeline[hi].timestamp.
        uint256 hi = n - 1;
        uint256 lo = 0;
        Checkpoint memory left;
        for (uint256 step = 1; step < hi; step <<= 1) {
            uint256 probe = hi - step;
            left = timeline[probe];
            if (left.timestamp <= t) {
                lo = probe;
                break;
            }
            hi = probe;
            right = left;
        }
        while (hi - lo > 1) {
            uint256 mid = (lo + hi) >> 1;
            Checkpoint memory middle = timeline[mid];
            if (middle.timestamp <= t) {
                lo = mid;
            } else {
                hi = mid;
                right = middle;
            }
        }
        left = timeline[lo];

        // Cumulative wet time never exceeds elapsed time, so the product stays far below 2^128.
        uint256 gained = uint256(right.cumulative - left.cumulative) * (t - left.timestamp);
        uint256 span = right.timestamp - left.timestamp;
        return left.cumulative + (roundUp ? Math.ceilDiv(gained, span) : gained / span);
    }

    function _hashReport(Reading[] memory readings, uint64 issuedAt) private view returns (bytes32) {
        uint256 count = readings.length;
        bytes32[] memory hashes = new bytes32[](count);
        for (uint256 i = 0; i < count; ++i) {
            Reading memory reading = readings[i];
            hashes[i] =
                keccak256(abi.encode(READING_TYPEHASH, reading.key, reading.from, reading.to, reading.wetSeconds));
        }
        return _hashTypedDataV4(keccak256(abi.encode(REPORT_TYPEHASH, keccak256(abi.encodePacked(hashes)), issuedAt)));
    }
}
