// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IReceiver} from "../../src/interfaces/IReceiver.sol";

/// @dev Stand-in for a simulation forwarder: it relays whatever any caller hands it, without verifying who
/// produced the report.
contract PermissionlessForwarder {
    function report(address receiver, bytes calldata metadata, bytes calldata rawReport) external {
        IReceiver(receiver).onReport(metadata, rawReport);
    }
}
