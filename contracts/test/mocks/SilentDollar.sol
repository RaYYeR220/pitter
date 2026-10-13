// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @dev A token whose `receiveWithAuthorization` returns without moving anything.
contract SilentDollar is ERC20 {
    constructor() ERC20("Silent Dollar", "sUSD") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function receiveWithAuthorization(address, address, uint256, uint256, uint256, bytes32, uint8, bytes32, bytes32)
        external {}
}
