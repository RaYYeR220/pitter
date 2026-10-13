// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";

/// @title Chainlink report receiver
/// @notice Consumer interface a Chainlink forwarder calls to deliver a workflow report.
interface IReceiver is IERC165 {
    /// @notice Handles an incoming report.
    /// @param metadata Workflow metadata attached by the forwarder.
    /// @param report Workflow-defined report payload.
    function onReport(bytes calldata metadata, bytes calldata report) external;
}
