// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @dev Stands in for the book where only the pool is under test: an account the pool takes orders from, with
/// a cover horizon, a policy count and an oldest-open mark the test sets freely.
contract BookStub {
    uint64 public maxHorizon;
    uint256 public policyCount;
    uint256 public oldestOpenId = 1;

    function setMaxHorizon(uint64 maxHorizon_) external {
        maxHorizon = maxHorizon_;
    }

    function setPolicyCount(uint256 policyCount_) external {
        policyCount = policyCount_;
    }

    function setOldestOpenId(uint256 oldestOpenId_) external {
        oldestOpenId = oldestOpenId_;
    }
}
