// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {Quote, Reading} from "../../src/Types.sol";

/// @dev EIP-712 signing helpers shared by the test suites. Digests are rebuilt here from the type strings (and,
/// for the token standards, from the literals published in EIP-3009 and EIP-2612) so the suites check the
/// contracts against the specifications, not against themselves.
abstract contract Signing is Test {
    bytes32 internal constant READING_TYPEHASH =
        keccak256("Reading(uint256 key,uint64 from,uint64 to,uint32 wetSeconds)");
    bytes32 internal constant REPORT_TYPEHASH = keccak256(
        "Report(Reading[] readings,uint64 issuedAt)Reading(uint256 key,uint64 from,uint64 to,uint32 wetSeconds)"
    );

    bytes32 internal constant QUOTE_TYPEHASH = keccak256(
        "Quote(address holder,uint256 key,uint64 start,uint64 end,uint128 ratePerSecond,uint128 premium,uint64 expiry,bytes32 salt)"
    );
    bytes32 internal constant TRANSFER_WITH_AUTHORIZATION_TYPEHASH =
        0x7c7c6cdb67a18743f49ec6fa9b35f50d52ed05cbed4cc592e13b44501c1a2267;
    bytes32 internal constant RECEIVE_WITH_AUTHORIZATION_TYPEHASH =
        0xd099cc98ef71107a616c4f0f941f04c322d8e254fe26b3c6668db87aae413de8;
    bytes32 internal constant CANCEL_AUTHORIZATION_TYPEHASH =
        0x158b0a9edf7a828aad02f63cd515c68ef2f50ba807396f6d12842833a1597429;
    bytes32 internal constant PERMIT_TYPEHASH = 0x6e71edae12b1b97f4d1f60370fef10105fa2faae0126114a169c64845d6126c9;

    struct Authorization {
        address from;
        address to;
        uint256 value;
        uint256 validAfter;
        uint256 validBefore;
        bytes32 nonce;
    }

    function _typedDigest(bytes32 domainSeparator, bytes32 structHash) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
    }

    function _signAuthorization(uint256 privateKey, bytes32 domainSeparator, bytes32 typeHash, Authorization memory a)
        internal
        pure
        returns (uint8 v, bytes32 r, bytes32 s)
    {
        bytes32 structHash =
            keccak256(abi.encode(typeHash, a.from, a.to, a.value, a.validAfter, a.validBefore, a.nonce));
        return vm.sign(privateKey, _typedDigest(domainSeparator, structHash));
    }

    function _signTransferAuthorization(uint256 privateKey, bytes32 domainSeparator, Authorization memory a)
        internal
        pure
        returns (uint8 v, bytes32 r, bytes32 s)
    {
        return _signAuthorization(privateKey, domainSeparator, TRANSFER_WITH_AUTHORIZATION_TYPEHASH, a);
    }

    function _signReceiveAuthorization(uint256 privateKey, bytes32 domainSeparator, Authorization memory a)
        internal
        pure
        returns (uint8 v, bytes32 r, bytes32 s)
    {
        return _signAuthorization(privateKey, domainSeparator, RECEIVE_WITH_AUTHORIZATION_TYPEHASH, a);
    }

    function _signCancelAuthorization(uint256 privateKey, bytes32 domainSeparator, address authorizer, bytes32 nonce)
        internal
        pure
        returns (uint8 v, bytes32 r, bytes32 s)
    {
        bytes32 structHash = keccak256(abi.encode(CANCEL_AUTHORIZATION_TYPEHASH, authorizer, nonce));
        return vm.sign(privateKey, _typedDigest(domainSeparator, structHash));
    }

    function _signPermit(
        uint256 privateKey,
        bytes32 domainSeparator,
        address owner,
        address spender,
        uint256 value,
        uint256 nonce,
        uint256 deadline
    ) internal pure returns (uint8 v, bytes32 r, bytes32 s) {
        bytes32 structHash = keccak256(abi.encode(PERMIT_TYPEHASH, owner, spender, value, nonce, deadline));
        return vm.sign(privateKey, _typedDigest(domainSeparator, structHash));
    }

    function _signDigest(uint256 privateKey, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(privateKey, digest);
        return abi.encodePacked(r, s, v);
    }

    // ───────────────────────────── quotes ─────────────────────────────

    function _quoteDigest(bytes32 domainSeparator, Quote memory q) internal pure returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(QUOTE_TYPEHASH, q.holder, q.key, q.start, q.end, q.ratePerSecond, q.premium, q.expiry, q.salt)
        );
        return _typedDigest(domainSeparator, structHash);
    }

    // ───────────────────────────── weather reports ─────────────────────────────

    function _reportDigest(bytes32 domainSeparator, Reading[] memory readings, uint64 issuedAt)
        internal
        pure
        returns (bytes32)
    {
        bytes32[] memory hashes = new bytes32[](readings.length);
        for (uint256 i = 0; i < readings.length; ++i) {
            hashes[i] = keccak256(
                abi.encode(READING_TYPEHASH, readings[i].key, readings[i].from, readings[i].to, readings[i].wetSeconds)
            );
        }
        bytes32 structHash = keccak256(abi.encode(REPORT_TYPEHASH, keccak256(abi.encodePacked(hashes)), issuedAt));
        return _typedDigest(domainSeparator, structHash);
    }

    /// @dev Payload accepted by `WeatherIndex.submit` and `WeatherIndex.onReport`, signed with `privateKey`.
    function _signedReport(uint256 privateKey, bytes32 domainSeparator, Reading[] memory readings, uint64 issuedAt)
        internal
        pure
        returns (bytes memory)
    {
        bytes memory signature = _signDigest(privateKey, _reportDigest(domainSeparator, readings, issuedAt));
        return abi.encode(readings, issuedAt, signature);
    }

    function _readings(Reading memory a) internal pure returns (Reading[] memory list) {
        list = new Reading[](1);
        list[0] = a;
    }

    function _readings(Reading memory a, Reading memory b) internal pure returns (Reading[] memory list) {
        list = new Reading[](2);
        list[0] = a;
        list[1] = b;
    }
}
