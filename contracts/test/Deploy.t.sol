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

    uint256 internal constant AREA_A = (uint256(1) << 64) | (uint256(5000) << 32);
    uint256 internal constant AREA_B = AREA_A + 1;

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

        // Off the main network, cover is not limited to served areas unless asked.
        assertFalse(d.book.servedOnly());
        assertEq(d.book.servedKeys().length, 0);

        // Left unset, the notice, the cover horizon and the premium floor keep their defaults.
        assertEq(d.pool.redeemNotice(), 13 hours);
        assertEq(d.book.maxHorizon(), 12 hours + 30 minutes);
        assertEq(d.book.minPremium(), 0);
    }

    function test_Deploy_AppliesTheNoticeTheHorizonAndThePremiumFloor() public {
        Deploy.Params memory p = _params();
        p.redeemNotice = 2 days;
        p.maxHorizon = 1 days;
        p.minPremium = 250_000;
        Deploy.Deployment memory d = script.deploy(p, address(script));

        assertEq(d.pool.redeemNotice(), 2 days);
        assertEq(d.book.maxHorizon(), 1 days);
        assertEq(d.book.minPremium(), 250_000);
    }

    function test_Deploy_ShortensTheHorizonBeforeTheNotice() public {
        // Both below their defaults: the notice can only follow the horizon down.
        Deploy.Params memory p = _params();
        p.redeemNotice = 12 hours + 30 minutes;
        p.maxHorizon = 12 hours;
        Deploy.Deployment memory d = script.deploy(p, address(script));

        assertEq(d.pool.redeemNotice(), 12 hours + 30 minutes);
        assertEq(d.book.maxHorizon(), 12 hours);
    }

    function test_Deploy_RevertWhen_TheHorizonOutlastsTheNotice() public {
        Deploy.Params memory p = _params();
        p.maxHorizon = 12 hours + 30 minutes + 1;
        vm.expectRevert(CoverBook.ConfigInvalid.selector);
        script.deploy(p, address(script));

        // A notice within the margin of the horizon the book starts with is refused as well.
        p.maxHorizon = 0;
        p.redeemNotice = 13 hours - 1;
        vm.expectRevert(CoverPool.NoticeInvalid.selector);
        script.deploy(p, address(script));
    }

    function test_CheckHorizon_RevertWhen_TheNoticeIsShorterThanTheHorizon() public {
        Deploy.Deployment memory d = script.deploy(_params(), address(script));
        script.checkHorizon(d.pool, d.book);

        vm.mockCall(address(d.pool), abi.encodeWithSignature("redeemNotice()"), abi.encode(uint64(13 hours - 1)));
        vm.expectRevert(
            abi.encodeWithSelector(Deploy.HorizonBeyondNotice.selector, 12 hours + 30 minutes, 13 hours - 1)
        );
        script.checkHorizon(d.pool, d.book);
    }

    function test_Deploy_ServesTheGivenAreas() public {
        Deploy.Params memory p = _params();
        p.servedOnly = true;
        p.servedKeys = new uint256[](2);
        p.servedKeys[0] = AREA_A;
        p.servedKeys[1] = AREA_B;
        Deploy.Deployment memory d = script.deploy(p, address(script));

        assertTrue(d.book.servedOnly());
        assertTrue(d.book.isServed(AREA_A));
        assertTrue(d.book.isServed(AREA_B));
        assertEq(d.book.servedKeys().length, 2);
    }

    function test_Deploy_RevertWhen_NoPremiumFloorOnMainnet() public {
        Deploy.Params memory p = _params();
        p.token = address(new TestDollar(address(this)));
        vm.chainId(143);
        vm.expectRevert(Deploy.MinPremiumRequired.selector);
        script.deploy(p, address(script));
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
        p.minPremium = 250_000;

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
        d.index
            .submit(
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
        vm.setEnv("REDEEM_NOTICE", "86400");
        vm.setEnv("MAX_HORIZON", "72000");
        vm.setEnv("MIN_PREMIUM", "250000");

        // On the main network cover is limited to served areas by default; elsewhere it is not.
        vm.chainId(143);
        assertTrue(script.paramsFromEnv(address(this)).servedOnly);
        vm.chainId(31337);
        assertFalse(script.paramsFromEnv(address(this)).servedOnly);

        vm.setEnv("SERVED_ONLY", "true");
        vm.setEnv("SERVED_KEYS", string.concat(vm.toString(AREA_A), ",", vm.toString(AREA_B)));

        Deploy.Deployment memory d = script.run();

        assertTrue(d.testDollar);
        assertEq(d.index.reporter(), reporter);
        assertTrue(d.index.isForwarder(forwarderA));
        assertTrue(d.index.isForwarder(forwarderB));
        assertEq(d.book.underwriter(), underwriter);
        assertEq(d.book.treasury(), treasury);
        assertEq(d.book.minLead(), 120);
        assertEq(d.book.maxPolicyPayout(), 75e6);
        assertEq(d.book.minPremium(), 250_000);
        assertEq(d.pool.redeemNotice(), 1 days);
        assertEq(d.book.maxHorizon(), 20 hours);
        assertTrue(d.book.servedOnly());
        assertTrue(d.book.isServed(AREA_A));
        assertTrue(d.book.isServed(AREA_B));
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
        assertEq(vm.parseJsonUint(json, ".redeemNotice"), 86_400);
        assertEq(vm.parseJsonUint(json, ".maxHorizon"), 72_000);
        assertTrue(vm.parseJsonBool(json, ".servedOnly"));
        assertEq(vm.parseJsonUintArray(json, ".servedKeys").length, 2);
        assertEq(vm.parseJsonUint(json, ".minPremium"), 250_000);
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
