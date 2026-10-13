// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @title Cover pool exposure interface
/// @notice What the policy book needs from the capital pool.
interface ICoverPool {
    /// @notice Reserves `amount` of pool assets against `key`. Reverts when a cap would be exceeded.
    function lock(uint256 key, uint256 amount) external;

    /// @notice Frees `amount` of exposure reserved against `key` without paying it out.
    function release(uint256 key, uint256 amount) external;

    /// @notice Pays `amount` of reserved exposure for `key` to `to`.
    function pay(address to, uint256 key, uint256 amount) external;

    /// @notice Time a liquidity provider waits between asking to leave and leaving, in seconds.
    function redeemNotice() external view returns (uint64);
}
