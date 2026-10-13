// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @notice Terms of one cover purchase, signed by the underwriter.
/// @dev `key` identifies what is insured: `(uint256(triggerId) << 64) | cellId`. Trigger 1 is rain of at least
/// 1.0 mm/h; `cellId` is `(latIndex << 32) | lonIndex` on a 0.05 degree grid.
struct Quote {
    address holder; // receives the payouts; pays the premium in `buyWithAuthorization`
    uint256 key; // insured trigger and cell
    uint64 start; // window start, unix seconds, multiple of 60
    uint64 end; // window end (exclusive), unix seconds, multiple of 60
    uint128 ratePerSecond; // token base units paid per wet second inside the window
    uint128 premium; // token base units charged for the window
    uint64 expiry; // last timestamp at which the quote can be used
    bytes32 salt; // makes otherwise identical quotes distinct
}

/// @notice One oracle observation: `wetSeconds` of the interval `[from, to]` met the trigger for `key`.
struct Reading {
    uint256 key;
    uint64 from;
    uint64 to;
    uint32 wetSeconds;
}
