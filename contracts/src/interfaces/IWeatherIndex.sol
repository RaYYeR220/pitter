// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @title Weather index read interface
/// @notice What a consumer needs to price liveness and settle cover against the index.
interface IWeatherIndex {
    /// @notice When the last accepted report (empty ones included) was issued, or when it landed if it was
    /// issued ahead of the chain clock. Zero if none was ever accepted.
    function heartbeat() external view returns (uint64);

    /// @notice End of the last interval reported for `key`. Zero if the key was never reported.
    function lastTo(uint256 key) external view returns (uint64);

    /// @notice Wet seconds confirmed for `key` between `a` and `b`, rounded down.
    function wetSeconds(uint256 key, uint64 a, uint64 b) external view returns (uint256);
}
