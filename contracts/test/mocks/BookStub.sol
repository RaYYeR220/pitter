// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @dev Stands in for the book where only the pool is under test: an account the pool takes orders from, with
/// a cover horizon the test sets freely.
contract BookStub {
    uint64 public maxHorizon;

    function setMaxHorizon(uint64 maxHorizon_) external {
        maxHorizon = maxHorizon_;
    }
}
