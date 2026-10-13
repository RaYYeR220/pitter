// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @title ERC-7540 asynchronous redemption
/// @notice The request side of an asynchronous ERC-4626 vault: shares are handed in first and the assets are
/// claimed later through `redeem` or `withdraw`. Interface id `0x620ee8e4`.
interface IERC7540Redeem {
    /// @notice `owner` handed `shares` in for redemption; `controller` holds the claim.
    event RedeemRequest(
        address indexed controller, address indexed owner, uint256 indexed requestId, address sender, uint256 shares
    );

    /// @notice Requests the redemption of `shares` of `owner`, to be claimed by `controller`.
    /// @return requestId Identifier of the request.
    function requestRedeem(uint256 shares, address controller, address owner) external returns (uint256 requestId);

    /// @notice Shares of the request that cannot be claimed yet.
    function pendingRedeemRequest(uint256 requestId, address controller) external view returns (uint256 pendingShares);

    /// @notice Shares of the request that can be claimed now.
    function claimableRedeemRequest(uint256 requestId, address controller)
        external
        view
        returns (uint256 claimableShares);
}
