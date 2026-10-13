// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @dev Minimal ERC-1271 wallet: a signature is valid when it comes from the wallet's key.
contract ContractSigner is IERC1271 {
    address public immutable KEY_HOLDER;

    constructor(address keyHolder) {
        KEY_HOLDER = keyHolder;
    }

    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4) {
        (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecover(hash, signature);
        if (err == ECDSA.RecoverError.NoError && recovered == KEY_HOLDER) return IERC1271.isValidSignature.selector;
        return 0xffffffff;
    }
}
