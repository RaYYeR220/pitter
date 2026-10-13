// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {TestDollar} from "../../src/TestDollar.sol";

/// @dev Test dollar with an issuer-style block list: transfers from or to a blocked account revert.
contract BlockableDollar is TestDollar {
    mapping(address account => bool) public blocked;

    error AccountBlocked(address account);

    constructor(address initialOwner) TestDollar(initialOwner) {}

    function setBlocked(address account, bool isBlocked) external onlyOwner {
        blocked[account] = isBlocked;
    }

    function _update(address from, address to, uint256 value) internal override {
        if (blocked[from]) revert AccountBlocked(from);
        if (blocked[to]) revert AccountBlocked(to);
        super._update(from, to, value);
    }
}
