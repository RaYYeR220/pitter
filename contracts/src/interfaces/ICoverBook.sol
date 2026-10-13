// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @title Cover book horizon interface
/// @notice What the capital pool needs from the policy book.
interface ICoverBook {
    /// @notice Furthest ahead of its purchase a window may end, in seconds.
    function maxHorizon() external view returns (uint64);
}
