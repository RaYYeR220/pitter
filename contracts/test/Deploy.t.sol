// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Deploy} from "../script/Deploy.s.sol";
import {CoverBook} from "../src/CoverBook.sol";
import {CoverPool} from "../src/CoverPool.sol";
import {TestDollar} from "../src/TestDollar.sol";
import {Quote, Reading} from "../src/Types.sol";
import {WeatherIndex} from "../src/WeatherIndex.sol";
import {Signing} from "./utils/Signing.sol";

contract DeployTest is Signing {
    Deploy internal script;

    address internal treasury = makeAddr("treasury");
    address internal finalOwner = makeAddr("final owner");
    address internal forwarderA = makeAddr("forwarder a");
    address internal forwarderB = makeAddr("forwarder b");
    address internal reporter;
    uint256 internal reporterKey;
    address internal underwriter;
    uint256 internal underwriterKey;

    function setUp() public {
        vm.warp(1_760_000_400);
        (reporter, reporterKey) = makeAddrAndKey("reporter");
        (underwriter, underwriterKey) = makeAddrAndKey("underwriter");
        script = new Deploy();
    }

    function _params() internal view returns (Deploy.Params memory p) {
        p.reporter = reporter;
        p.underwriter = underwriter;
        p.treasury = treasury;
        p.owner = address(script);
        p.minLead = 600;
        p.maxPolicyPayout = 250e6;
        p.shareName = "Cover Pool Share";
        p.shareSymbol = "cvUSD";
        p.forwarders = new address[](2);
        p.forwarders[0] = forwarderA;
        p.forwarders[1] = forwarderB;
    }

    function test_Deploy_WiresTheSystem() public {
        Deploy.Deployment memory d = script.deploy(_params(), address(script));

        assertTrue(d.testDollar);
        assertEq(TestDollar(d.token).owner(), address(script));

        assertEq(d.index.owner(), address(script));
        assertEq(d.index.reporter(), reporter);
        assertTrue(d.index.requireReporterSig());
        assertTrue(d.index.isForwarder(forwarderA));
        assertTrue(d.index.isForwarder(forwarderB));
        assertFalse(d.index.isForwarder(address(script)));

        assertEq(d.pool.owner(), address(script));
        assertEq(d.pool.asset(), d.token);
        assertEq(d.pool.book(), address(d.book));
        assertEq(d.pool.name(), "Cover Pool Share");
        assertEq(d.pool.symbol(), "cvUSD");

        assertEq(d.book.owner(), address(script));
        assertEq(address(d.book.token()), d.token);
        assertEq(address(d.book.pool()), address(d.pool));
        assertEq(address(d.book.index()), address(d.index));
        assertEq(d.book.underwriter(), underwriter);
        assertEq(d.book.treasury(), treasury);
        assertEq(d.book.minLead(), 600);
        assertEq(d.book.maxPolicyPayout(), 250e6);
    }

    function test_Deploy_OffersOwnershipToAnotherOwner() public {
        Deploy.Params memory p = _params();
        p.owner = finalOwner;
        Deploy.Deployment memory d = script.deploy(p, address(script));

        assertEq(d.index.pendingOwner(), finalOwner);
        assertEq(d.pool.pendingOwner(), finalOwner);
        assertEq(d.book.pendingOwner(), finalOwner);
        assertEq(TestDollar(d.token).pendingOwner(), finalOwner);
        assertEq(d.book.owner(), address(script));

        vm.startPrank(finalOwner);
        d.index.acceptOwnership();
        d.pool.acceptOwnership();
        d.book.acceptOwnership();
        TestDollar(d.token).acceptOwnership();
        vm.stopPrank();

        assertEq(d.index.owner(), finalOwner);
        assertEq(d.pool.owner(), finalOwner);
        assertEq(d.book.owner(), finalOwner);
        assertEq(TestDollar(d.token).owner(), finalOwner);
    }

    function test_Deploy_UsesAnExistingTokenWhenGiven() public {
        TestDollar existing = new TestDollar(address(this));
        Deploy.Params memory p = _params();
        p.token = address(existing);

        vm.chainId(143);
        Deploy.Deployment memory d = script.deploy(p, address(script));

        assertFalse(d.testDollar);
        assertEq(d.token, address(existing));
        assertEq(d.pool.asset(), address(existing));
        assertEq(existing.owner(), address(this));
    }

    function test_Deploy_DeploysTheTestDollarOnTheTestnet() public {
        vm.chainId(10143);
        Deploy.Deployment memory d = script.deploy(_params(), address(script));
        assertTrue(d.testDollar);
        assertEq(TestDollar(d.token).symbol(), "tUSD");
    }

    function test_Deploy_RevertWhen_NoTokenOnMainnet() public {
        vm.chainId(143);
        vm.expectRevert(abi.encodeWithSelector(Deploy.TokenRequired.selector, 143));
        script.deploy(_params(), address(script));
    }

    function test_Deploy_TheDeployedSystemSellsAndSettlesAPolicy() public {
        Deploy.Params memory p = _params();
        p.minLead = 0;
        Deploy.Deployment memory d = script.deploy(p, address(script));
        TestDollar dollar = TestDollar(d.token);
        (address holder, uint256 holderKey) = makeAddrAndKey("holder");
        address provider = makeAddr("provider");
        uint256 key = (uint256(1) << 64) | 7;

        // A provider funds the pool and a holder gets test dollars from the open drip.
        dollar.drip(provider);
        dollar.drip(holder);
        vm.startPrank(provider);
        dollar.approve(address(d.pool), type(uint256).max);
        d.pool.deposit(1_000e6, provider);
        vm.stopPrank();

        d.index.submit(_signedReport(reporterKey, d.index.DOMAIN_SEPARATOR(), new Reading[](0), 1_760_000_400));

        Quote memory q = Quote(holder, key, 1_760_000_400, 1_760_001_000, 1e4, 1e6, 1_760_000_700, bytes32(uint256(1)));
        bytes32 digest = _quoteDigest(d.book.DOMAIN_SEPARATOR(), q);
        (uint8 v, bytes32 r, bytes32 s) = _signReceiveAuthorization(
            holderKey, dollar.DOMAIN_SEPARATOR(), Authorization(holder, address(d.book), q.premium, 0, q.expiry, digest)
        );
        uint256 id = d.book.buyWithAuthorization(q, _signDigest(underwriterKey, digest), 0, q.expiry, v, r, s);

        vm.warp(q.end);
        d.index.submit(
            _signedReport(
                reporterKey, d.index.DOMAIN_SEPARATOR(), _readings(Reading(key, q.start, q.end, 600)), q.end
            )
        );
        assertEq(d.book.settle(id), 6e6);
        assertEq(dollar.balanceOf(holder), 1_000e6 - 1e6 + 6e6);
        assertEq(d.pool.lockedExposure(), 0);
    }

    /// @dev Both environment scenarios live in one test: the process environment is shared between tests.
    function test_Run_ReadsTheEnvironmentAndRecordsTheDeployment() public {
        vm.setEnv("REPORTER", vm.toString(reporter));
        vm.setEnv("UNDERWRITER", vm.toString(underwriter));
        vm.setEnv("TREASURY", vm.toString(treasury));
        vm.setEnv("OWNER", vm.toString(finalOwner));
        vm.setEnv("FORWARDERS", string.concat(vm.toString(forwarderA), ",", vm.toString(forwarderB)));
        vm.setEnv("MIN_LEAD", "120");
        vm.setEnv("MAX_POLICY_PAYOUT", "75000000");

        Deploy.Deployment memory d = script.run();

        assertTrue(d.testDollar);
        assertEq(d.index.reporter(), reporter);
        assertTrue(d.index.isForwarder(forwarderA));
        assertTrue(d.index.isForwarder(forwarderB));
        assertEq(d.book.underwriter(), underwriter);
        assertEq(d.book.treasury(), treasury);
        assertEq(d.book.minLead(), 120);
        assertEq(d.book.maxPolicyPayout(), 75e6);
        assertEq(d.book.pendingOwner(), finalOwner);
        assertEq(d.pool.book(), address(d.book));

        string memory path = string.concat("deployments/", vm.toString(block.chainid), ".json");
        string memory json = vm.readFile(path);
        assertEq(vm.parseJsonUint(json, ".chainId"), block.chainid);
        assertEq(vm.parseJsonAddress(json, ".token"), d.token);
        assertTrue(vm.parseJsonBool(json, ".testDollar"));
        assertEq(vm.parseJsonAddress(json, ".weatherIndex"), address(d.index));
        assertEq(vm.parseJsonAddress(json, ".coverPool"), address(d.pool));
        assertEq(vm.parseJsonAddress(json, ".coverBook"), address(d.book));
        assertEq(vm.parseJsonAddress(json, ".owner"), finalOwner);
        assertEq(vm.parseJsonAddress(json, ".reporter"), reporter);
        assertEq(vm.parseJsonAddress(json, ".underwriter"), underwriter);
        assertEq(vm.parseJsonAddressArray(json, ".forwarders").length, 2);
        assertEq(vm.parseJsonUint(json, ".minLead"), 120);
        assertEq(vm.parseJsonUint(json, ".maxPolicyPayout"), 75e6);
        vm.removeFile(path);

        // An empty forwarder list and the defaults for everything optional.
        vm.setEnv("FORWARDERS", "");
        Deploy.Params memory p = script.paramsFromEnv(address(this));
        assertEq(p.forwarders.length, 0);
        assertEq(p.token, address(0));
        assertEq(p.shareName, "Cover Pool Share");
        assertEq(p.shareSymbol, "cvUSD");
    }
}
