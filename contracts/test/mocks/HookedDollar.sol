// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

interface ITransferHook {
    function onTransfer(address from, address to, uint256 value) external;
}

/// @dev A token that calls back into accounts that registered a hook, on both sides of every transfer. USDC
/// has no such callbacks; this exists to prove the system does not rely on that.
contract HookedDollar is ERC20 {
    mapping(address account => address) public hookOf;

    constructor() ERC20("Hooked Dollar", "hUSD") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setHook(address account, address hook) external {
        hookOf[account] = hook;
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        address hook = hookOf[from];
        if (hook != address(0)) ITransferHook(hook).onTransfer(from, to, value);
        hook = hookOf[to];
        if (hook != address(0) && to != from) ITransferHook(hook).onTransfer(from, to, value);
    }
}
