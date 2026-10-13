// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Script, console2} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {CoverBook} from "../src/CoverBook.sol";
import {CoverPool} from "../src/CoverPool.sol";
import {TestDollar} from "../src/TestDollar.sol";
import {WeatherIndex} from "../src/WeatherIndex.sol";

/// @title Deploy
/// @notice Deploys the weather index, the pool and the book, wires them together and records the addresses in
/// `deployments/<chainId>.json`.
///
/// Environment:
/// - `REPORTER`     required  key that signs oracle reports
/// - `UNDERWRITER`  required  key that signs quotes
/// - `TREASURY`     required  recipient of the protocol fee
/// - `TOKEN`        optional  dollar token; when unset a TestDollar is deployed, on test networks only
/// - `FORWARDERS`   optional  comma-separated Chainlink forwarders allowed to deliver reports; may be empty
/// - `OWNER`        optional  final owner of every contract; defaults to the deployer
/// - `MIN_LEAD`     optional  seconds between a purchase and its window; defaults to 600 on mainnet, else 0
/// - `MAX_POLICY_PAYOUT` optional  largest payout of one policy in token base units; defaults to 500e6
/// - `MIN_PREMIUM`  optional  smallest premium of one policy in token base units; defaults to none
/// - `REDEEM_NOTICE` optional  seconds a liquidity provider waits between asking to leave and leaving;
///                            defaults to the pool's 13 hours
/// - `MAX_HORIZON`  optional  seconds ahead of its purchase a policy may end: at least the longest window
///                            (12 hours), at most the redemption notice; defaults to the book's 12 hours 30
///                            minutes
/// - `SHARE_NAME`, `SHARE_SYMBOL` optional  pool share token metadata
///
/// The deployer owns the contracts while wiring them. When `OWNER` is another account, ownership is offered
/// to it at the end and it must call `acceptOwnership()` on each contract.
contract Deploy is Script {
    uint256 internal constant MONAD_MAINNET = 143;
    uint256 internal constant MONAD_TESTNET = 10143;
    uint256 internal constant LOCAL = 31337;

    struct Params {
        address token;
        address reporter;
        address[] forwarders;
        address underwriter;
        address treasury;
        address owner;
        uint64 minLead;
        uint256 maxPolicyPayout;
        uint128 minPremium;
        uint64 redeemNotice;
        uint64 maxHorizon;
        string shareName;
        string shareSymbol;
    }

    struct Deployment {
        address token;
        bool testDollar;
        WeatherIndex index;
        CoverPool pool;
        CoverBook book;
    }

    error TokenRequired(uint256 chainId);
    error HorizonBeyondNotice(uint256 maxHorizon, uint256 redeemNotice);

    function run() external returns (Deployment memory d) {
        vm.startBroadcast();
        (, address deployer,) = vm.readCallers();
        Params memory p = paramsFromEnv(deployer);
        d = deploy(p, deployer);
        vm.stopBroadcast();

        console2.log("token        ", d.token);
        console2.log("WeatherIndex ", address(d.index));
        console2.log("CoverPool    ", address(d.pool));
        console2.log("CoverBook    ", address(d.book));

        if (!vm.isContext(VmSafe.ForgeContext.ScriptDryRun)) _write(d, p, deployer);
    }

    /// @notice Reads the deployment parameters from the environment.
    function paramsFromEnv(address deployer) public view returns (Params memory p) {
        p.token = vm.envOr("TOKEN", address(0));
        p.reporter = vm.envAddress("REPORTER");
        p.underwriter = vm.envAddress("UNDERWRITER");
        p.treasury = vm.envAddress("TREASURY");
        p.owner = vm.envOr("OWNER", deployer);
        p.minLead = uint64(vm.envOr("MIN_LEAD", block.chainid == MONAD_MAINNET ? uint256(600) : uint256(0)));
        p.maxPolicyPayout = vm.envOr("MAX_POLICY_PAYOUT", uint256(500e6));
        p.minPremium = uint128(vm.envOr("MIN_PREMIUM", uint256(0)));
        p.redeemNotice = uint64(vm.envOr("REDEEM_NOTICE", uint256(0)));
        p.maxHorizon = uint64(vm.envOr("MAX_HORIZON", uint256(0)));
        p.shareName = vm.envOr("SHARE_NAME", string("Cover Pool Share"));
        p.shareSymbol = vm.envOr("SHARE_SYMBOL", string("cvUSD"));
        if (bytes(vm.envOr("FORWARDERS", string(""))).length != 0) {
            p.forwarders = vm.envAddress("FORWARDERS", ",");
        }
    }

    /// @notice Deploys and wires the system. `deployer` is the account sending the transactions; it owns the
    /// contracts until the hand-over at the end.
    function deploy(Params memory p, address deployer) public returns (Deployment memory d) {
        if (p.token == address(0)) {
            if (block.chainid != MONAD_TESTNET && block.chainid != LOCAL) revert TokenRequired(block.chainid);
            d.token = address(new TestDollar(deployer));
            d.testDollar = true;
        } else {
            d.token = p.token;
        }

        d.index = new WeatherIndex(deployer, p.reporter);
        for (uint256 i = 0; i < p.forwarders.length; ++i) {
            d.index.setForwarder(p.forwarders[i], true);
        }

        d.pool = new CoverPool(IERC20(d.token), deployer, p.shareName, p.shareSymbol);
        d.book = new CoverBook(
            IERC20(d.token), d.pool, d.index, p.underwriter, p.treasury, p.minLead, p.maxPolicyPayout, deployer
        );
        d.pool.setBook(address(d.book));
        // The horizon and the notice bound each other: the horizon comes down before the notice and goes up
        // after it.
        if (p.maxHorizon != 0 && p.maxHorizon < d.book.maxHorizon()) d.book.setMaxHorizon(p.maxHorizon);
        if (p.redeemNotice != 0) d.pool.setRedeemNotice(p.redeemNotice);
        if (p.maxHorizon > d.book.maxHorizon()) d.book.setMaxHorizon(p.maxHorizon);
        checkHorizon(d.pool, d.book);
        if (p.minPremium != 0) d.book.setMinPremium(p.minPremium);

        if (p.owner != deployer) {
            d.index.transferOwnership(p.owner);
            d.pool.transferOwnership(p.owner);
            d.book.transferOwnership(p.owner);
            if (d.testDollar) TestDollar(d.token).transferOwnership(p.owner);
        }
    }

    /// @notice Fails unless capital that asks to leave stays at least as long as the book sells cover ahead.
    function checkHorizon(CoverPool pool, CoverBook book) public view {
        uint256 horizon = book.maxHorizon();
        uint256 notice = pool.redeemNotice();
        if (notice < horizon) revert HorizonBeyondNotice(horizon, notice);
    }

    function _write(Deployment memory d, Params memory p, address deployer) internal {
        string memory root = "deployment";
        vm.serializeUint(root, "chainId", block.chainid);
        vm.serializeUint(root, "startBlock", block.number);
        vm.serializeAddress(root, "deployer", deployer);
        vm.serializeAddress(root, "owner", p.owner);
        vm.serializeAddress(root, "token", d.token);
        vm.serializeBool(root, "testDollar", d.testDollar);
        vm.serializeAddress(root, "weatherIndex", address(d.index));
        vm.serializeAddress(root, "coverPool", address(d.pool));
        vm.serializeAddress(root, "coverBook", address(d.book));
        vm.serializeAddress(root, "reporter", p.reporter);
        vm.serializeAddress(root, "forwarders", p.forwarders);
        vm.serializeAddress(root, "underwriter", p.underwriter);
        vm.serializeAddress(root, "treasury", p.treasury);
        vm.serializeUint(root, "minLead", p.minLead);
        vm.serializeUint(root, "maxPolicyPayout", p.maxPolicyPayout);
        vm.serializeUint(root, "minPremium", p.minPremium);
        vm.serializeUint(root, "maxHorizon", d.book.maxHorizon());
        string memory json = vm.serializeUint(root, "redeemNotice", d.pool.redeemNotice());

        vm.createDir("deployments", true);
        string memory path = string.concat("deployments/", vm.toString(block.chainid), ".json");
        vm.writeJson(json, path);
        console2.log("written      ", path);
    }
}
