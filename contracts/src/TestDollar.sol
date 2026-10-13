// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IERC3009} from "./interfaces/IERC3009.sol";

/// @title TestDollar
/// @notice Six-decimal dollar token for test networks. It mirrors the parts of Circle's FiatToken the product
/// uses: EIP-2612 `permit` and ERC-3009 authorizations, with the same type hashes and validity rules, under the
/// EIP-712 domain `{name: "Test Dollar", version: "1"}`.
/// @dev Has no value. Anyone can mint through `drip`, limited per recipient.
contract TestDollar is ERC20, ERC20Permit, Ownable2Step, IERC3009 {
    /// @notice EIP-712 type hash of `TransferWithAuthorization`, as published in EIP-3009.
    bytes32 public constant TRANSFER_WITH_AUTHORIZATION_TYPEHASH = keccak256(
        "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );

    /// @notice EIP-712 type hash of `ReceiveWithAuthorization`, as published in EIP-3009.
    bytes32 public constant RECEIVE_WITH_AUTHORIZATION_TYPEHASH = keccak256(
        "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );

    /// @notice EIP-712 type hash of `CancelAuthorization`, as published in EIP-3009.
    bytes32 public constant CANCEL_AUTHORIZATION_TYPEHASH =
        keccak256("CancelAuthorization(address authorizer,bytes32 nonce)");

    /// @notice Amount minted by one `drip`.
    uint256 public constant DRIP_AMOUNT = 1_000e6;

    /// @notice Minimum time between two drips to the same recipient.
    uint256 public constant DRIP_INTERVAL = 1 days;

    /// @notice Earliest timestamp at which `drip` will serve a recipient again; zero if never served.
    mapping(address recipient => uint256) public nextDripAt;

    mapping(address authorizer => mapping(bytes32 nonce => bool)) private _authorizationStates;

    /// @notice Emitted when `drip` mints to `to`.
    event Dripped(address indexed to, uint256 amount);

    error AuthorizationNotYetValid(uint256 validAfter);
    error AuthorizationExpired(uint256 validBefore);
    error AuthorizationAlreadyUsed(address authorizer, bytes32 nonce);
    error InvalidAuthorizationSignature();
    error CallerMustBePayee(address caller, address payee);
    error DripLimited(address to, uint256 availableAt);

    /// @param initialOwner Account allowed to mint without limits.
    constructor(address initialOwner) ERC20("Test Dollar", "tUSD") ERC20Permit("Test Dollar") Ownable(initialOwner) {}

    /// @notice Token decimals, matching USDC.
    function decimals() public pure override returns (uint8) {
        return 6;
    }

    /// @notice Version of the EIP-712 signing domain.
    function version() external pure returns (string memory) {
        return "1";
    }

    /// @notice Mints `amount` to `to`.
    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }

    /// @notice Mints `DRIP_AMOUNT` to `to`. Open to anyone, at most once per `DRIP_INTERVAL` for each recipient.
    function drip(address to) external {
        uint256 availableAt = nextDripAt[to];
        if (block.timestamp < availableAt) revert DripLimited(to, availableAt);
        nextDripAt[to] = block.timestamp + DRIP_INTERVAL;
        _mint(to, DRIP_AMOUNT);
        emit Dripped(to, DRIP_AMOUNT);
    }

    /// @inheritdoc IERC3009
    function authorizationState(address authorizer, bytes32 nonce) external view returns (bool) {
        return _authorizationStates[authorizer][nonce];
    }

    /// @inheritdoc IERC3009
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
    ) external {
        _useAuthorization(
            TRANSFER_WITH_AUTHORIZATION_TYPEHASH, from, to, value, validAfter, validBefore, nonce, v, r, s
        );
        _transfer(from, to, value);
    }

    /// @inheritdoc IERC3009
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
    ) external {
        if (msg.sender != to) revert CallerMustBePayee(msg.sender, to);
        _useAuthorization(RECEIVE_WITH_AUTHORIZATION_TYPEHASH, from, to, value, validAfter, validBefore, nonce, v, r, s);
        _transfer(from, to, value);
    }

    /// @inheritdoc IERC3009
    function cancelAuthorization(address authorizer, bytes32 nonce, uint8 v, bytes32 r, bytes32 s) external {
        if (_authorizationStates[authorizer][nonce]) revert AuthorizationAlreadyUsed(authorizer, nonce);
        _requireSigner(authorizer, keccak256(abi.encode(CANCEL_AUTHORIZATION_TYPEHASH, authorizer, nonce)), v, r, s);
        _authorizationStates[authorizer][nonce] = true;
        emit AuthorizationCanceled(authorizer, nonce);
    }

    /// @dev Validates the time window, the nonce and the signature, then burns the nonce.
    function _useAuthorization(
        bytes32 typeHash,
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) private {
        if (block.timestamp <= validAfter) revert AuthorizationNotYetValid(validAfter);
        if (block.timestamp >= validBefore) revert AuthorizationExpired(validBefore);
        if (_authorizationStates[from][nonce]) revert AuthorizationAlreadyUsed(from, nonce);
        _requireSigner(from, keccak256(abi.encode(typeHash, from, to, value, validAfter, validBefore, nonce)), v, r, s);
        _authorizationStates[from][nonce] = true;
        emit AuthorizationUsed(from, nonce);
    }

    function _requireSigner(address signer, bytes32 structHash, uint8 v, bytes32 r, bytes32 s) private view {
        (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecover(_hashTypedDataV4(structHash), v, r, s);
        if (err != ECDSA.RecoverError.NoError || recovered != signer) revert InvalidAuthorizationSignature();
    }
}
