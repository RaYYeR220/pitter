// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @title ERC-3009 "Transfer With Authorization"
/// @notice The subset of the standard this system relies on, as implemented by Circle's FiatToken (native USDC).
interface IERC3009 {
    /// @notice Emitted when an authorization is consumed.
    event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce);

    /// @notice Emitted when an authorization is cancelled before use.
    event AuthorizationCanceled(address indexed authorizer, bytes32 indexed nonce);

    /// @notice Executes a transfer signed by `from`. Anyone may submit it.
    /// @param from Payer and signer of the authorization.
    /// @param to Payee.
    /// @param value Amount to transfer.
    /// @param validAfter The authorization is valid strictly after this timestamp.
    /// @param validBefore The authorization is valid strictly before this timestamp.
    /// @param nonce Unique 32-byte nonce chosen by the signer.
    function transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;

    /// @notice Executes a transfer signed by `from`. Only the payee `to` may submit it, which prevents a third
    /// party from front-running the payee's own call.
    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;

    /// @notice Cancels an unused authorization, signed by `authorizer`.
    function cancelAuthorization(address authorizer, bytes32 nonce, uint8 v, bytes32 r, bytes32 s) external;

    /// @notice Whether `nonce` of `authorizer` has been used or cancelled.
    function authorizationState(address authorizer, bytes32 nonce) external view returns (bool);
}
