// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @title Cover book interface
/// @notice What the capital pool needs from the policy book.
interface ICoverBook {
    /// @notice Furthest ahead of its purchase a window may end, in seconds.
    function maxHorizon() external view returns (uint64);

    /// @notice Number of policies ever sold. Policy ids run from 1 to this value.
    function policyCount() external view returns (uint256);

    /// @notice A policy id at or below the oldest open policy: every policy with a smaller id is closed.
    /// `policyCount() + 1` once every policy is closed and the mark has caught up.
    function oldestOpenId() external view returns (uint256);
}
