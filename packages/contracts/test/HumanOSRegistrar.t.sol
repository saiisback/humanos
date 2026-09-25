// SPDX-License-Identifier: MIT
pragma solidity 0.8.25;

import {Test} from "forge-std/Test.sol";

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ERC1155Holder} from "@openzeppelin/contracts/token/ERC1155/utils/ERC1155Holder.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {VerifiableFactory} from "@ensdomains/verifiable-factory/VerifiableFactory.sol";
import {GatewayProvider} from "@ens/contracts/ccipRead/GatewayProvider.sol";
import {NameCoder} from "@ens/contracts/utils/NameCoder.sol";
import {ITextResolver} from "@ens/contracts/resolvers/profiles/ITextResolver.sol";
import {IAddressResolver} from "@ens/contracts/resolvers/profiles/IAddressResolver.sol";

import {EACBaseRolesLib} from "@ensdomains/contracts-v2/access-control/libraries/EACBaseRolesLib.sol";
import {IEnhancedAccessControl} from "@ensdomains/contracts-v2/access-control/interfaces/IEnhancedAccessControl.sol";
import {IRegistry} from "@ensdomains/contracts-v2/registry/interfaces/IRegistry.sol";
import {IPermissionedRegistry} from "@ensdomains/contracts-v2/registry/interfaces/IPermissionedRegistry.sol";
import {IStandardRegistry} from "@ensdomains/contracts-v2/registry/interfaces/IStandardRegistry.sol";
import {RegistryRolesLib} from "@ensdomains/contracts-v2/registry/libraries/RegistryRolesLib.sol";
import {PermissionedRegistry} from "@ensdomains/contracts-v2/registry/PermissionedRegistry.sol";
import {UserRegistry} from "@ensdomains/contracts-v2/registry/UserRegistry.sol";
import {PermissionedResolver} from "@ensdomains/contracts-v2/resolver/PermissionedResolver.sol";
import {PermissionedResolverLib} from "@ensdomains/contracts-v2/resolver/libraries/PermissionedResolverLib.sol";
import {UniversalResolverV2} from "@ensdomains/contracts-v2/universalResolver/UniversalResolverV2.sol";
import {ContractNamer} from "@ensdomains/contracts-v2/utils/ContractNamer.sol";
import {LabelStore} from "@ensdomains/contracts-v2/utils/LabelStore.sol";

import {HumanOSRegistrar} from "../src/HumanOSRegistrar.sol";

/// @dev Local instance of the official ENSv2 hierarchy (Root -> .eth -> humanos.eth) built from
///      the pinned ensdomains/contracts-v2 sources, mirroring the official V2Fixture.
abstract contract ENSv2HierarchyFixture is Test, ERC1155Holder {
    ContractNamer contractNamer;
    VerifiableFactory factory;
    LabelStore labelStore;
    PermissionedRegistry rootRegistry;
    PermissionedRegistry ethRegistry;
    UserRegistry userRegistryImpl;
    PermissionedResolver resolverImpl;
    UniversalResolverV2 universalResolver;

    address operator = makeAddr("operator");

    /// @dev Same bitmap the official ETH Registrar grants registrants.
    uint256 constant ETH_REGISTRATION_ROLES = RegistryRolesLib.ROLE_SET_SUBREGISTRY
        | RegistryRolesLib.ROLE_SET_SUBREGISTRY_ADMIN | RegistryRolesLib.ROLE_SET_RESOLVER
        | RegistryRolesLib.ROLE_SET_RESOLVER_ADMIN | RegistryRolesLib.ROLE_CAN_TRANSFER_ADMIN;

    function deployHierarchy(uint64 parentExpiry) internal {
        contractNamer = ContractNamer(
            address(
                new ERC1967Proxy(
                    address(new ContractNamer()), abi.encodeCall(ContractNamer.initialize, (address(this)))
                )
            )
        );
        factory = new VerifiableFactory();
        labelStore = new LabelStore(contractNamer);
        rootRegistry = new PermissionedRegistry(
            labelStore,
            address(this),
            RegistryRolesLib.ROLE_REGISTRAR | RegistryRolesLib.ROLE_RENEW | RegistryRolesLib.ROLE_SET_PARENT
        );
        ethRegistry = new PermissionedRegistry(
            labelStore,
            address(this),
            RegistryRolesLib.ROLE_REGISTRAR | RegistryRolesLib.ROLE_RENEW | RegistryRolesLib.ROLE_SET_PARENT
        );
        rootRegistry.register(
            "eth",
            address(this),
            ethRegistry,
            address(0),
            RegistryRolesLib.ROLE_SET_SUBREGISTRY | RegistryRolesLib.ROLE_SET_RESOLVER,
            type(uint64).max
        );
        ethRegistry.setParent(rootRegistry, "eth");
        ethRegistry.register(
            "humanos", operator, IRegistry(address(0)), address(0), ETH_REGISTRATION_ROLES, parentExpiry
        );

        userRegistryImpl = new UserRegistry(labelStore, address(contractNamer));
        resolverImpl = new PermissionedResolver(address(contractNamer));
        universalResolver =
            new UniversalResolverV2(rootRegistry, new GatewayProvider(address(this), new string[](0)), contractNamer);
    }

    function dns(string memory name) internal pure returns (bytes memory) {
        return NameCoder.encode(name);
    }

    function textOf(address resolver, string memory name, string memory key) internal view returns (string memory) {
        bytes memory encoded = dns(name);
        bytes memory result = PermissionedResolver(resolver)
            .resolve(encoded, abi.encodeCall(ITextResolver.text, (NameCoder.namehash(encoded, 0), key)));
        return abi.decode(result, (string));
    }

    function addrOf(address resolver, string memory name) internal view returns (address) {
        bytes memory encoded = dns(name);
        bytes memory result = PermissionedResolver(resolver)
            .resolve(encoded, abi.encodeCall(IAddressResolver.addr, (NameCoder.namehash(encoded, 0), 60)));
        return address(bytes20(abi.decode(result, (bytes))));
    }
}

contract HumanOSRegistrarTest is ENSv2HierarchyFixture {
    HumanOSRegistrar registrar;
    IPermissionedRegistry humanos;

    address rootOwner = makeAddr("rootOwner");
    address agent = makeAddr("agent");
    address attacker = makeAddr("attacker");

    uint64 constant YEAR = 365 days;
    uint256 constant CAP_DRAFTS_WRITE = 1 << 2;
    uint256 constant CAP_CALENDAR_CREATE = 1 << 5;
    uint256 constant CAP_APPLICATION_SUBMIT = 1 << 9;
    uint256 constant CAPS = CAP_DRAFTS_WRITE | CAP_CALENDAR_CREATE | CAP_APPLICATION_SUBMIT;

    string constant ROOT_LABEL = "alice";
    string constant ROOT_NAME = "alice.humanos.eth";
    string constant AGENT_LABEL = "tokyo-app";
    string constant AGENT_NAME = "tokyo-app.alice.humanos.eth";

    function setUp() public {
        vm.warp(1_790_000_000);
        deployHierarchy(uint64(block.timestamp) + 2 * YEAR);
        registrar = new HumanOSRegistrar(
            HumanOSRegistrar.Config({
                factory: address(factory),
                userRegistryImplementation: address(userRegistryImpl),
                resolverImplementation: address(resolverImpl),
                parentRegistry: ethRegistry,
                parentLabel: "humanos",
                parentSuffix: dns("eth")
            }),
            operator
        );
        humanos = registrar.HUMANOS_REGISTRY();
        vm.prank(operator);
        ethRegistry.setSubregistry(uint256(keccak256("humanos")), humanos);
    }

    // ------------------------------------------------------------------
    // helpers
    // ------------------------------------------------------------------

    function _root(uint64 expiry) internal returns (bytes32) {
        vm.prank(operator);
        return registrar.registerRoot(ROOT_LABEL, "root_01", rootOwner, expiry);
    }

    function _agent(bytes32 rootNode, string memory label, address account, uint64 expiry) internal returns (bytes32) {
        vm.prank(operator);
        return registrar.registerAgent(rootNode, label, account, CAPS, expiry);
    }

    function _defaultAgent() internal returns (bytes32 rootNode, bytes32 agentNode) {
        rootNode = _root(uint64(block.timestamp) + YEAR);
        agentNode = _agent(rootNode, AGENT_LABEL, agent, uint64(block.timestamp) + 7 days);
    }

    function _resolvedAt(string memory name) internal view returns (address resolver, uint256 offset) {
        (resolver,, offset) = universalResolver.findResolver(dns(name));
    }

    function _statusSetter(string memory key) internal pure returns (bytes memory) {
        return abi.encodeCall(PermissionedResolver.setText, ("", key, ""));
    }

    // ------------------------------------------------------------------
    // deployment / composition
    // ------------------------------------------------------------------

    function test_constructor_deploysLockedHumanOSRegistry() external view {
        (IRegistry parent, string memory label) = humanos.getParent();
        assertEq(address(parent), address(ethRegistry));
        assertEq(label, "humanos");
        // Registrar holds only operational roles, no admin, upgrade, resolver or subregistry powers.
        uint256 expected =
            RegistryRolesLib.ROLE_REGISTRAR | RegistryRolesLib.ROLE_RENEW | RegistryRolesLib.ROLE_UNREGISTER;
        assertEq(humanos.roles(0, address(registrar)), expected);
        assertEq(EACBaseRolesLib.fromCounts(humanos.roleCount(0)), expected, "no other root role holders");
        (bool ok,) = address(factory).staticcall(abi.encodeCall(VerifiableFactory.verifyContract, (address(humanos))));
        assertTrue(ok, "HumanOS registry is a verifiable factory proxy");
        assertEq(factory.verifyContract(address(humanos)), address(userRegistryImpl));
    }

    function test_noUpgradeRedirectOrLinkAuthorityAnywhere() external {
        (bytes32 rootNode, bytes32 agentNode) = _defaultAgent();
        IPermissionedRegistry rootReg = registrar.rootRegistry(rootNode);
        uint256 dangerous = RegistryRolesLib.ROLE_UPGRADE | RegistryRolesLib.ROLE_UPGRADE_ADMIN
            | RegistryRolesLib.ROLE_SET_RESOLVER | RegistryRolesLib.ROLE_SET_RESOLVER_ADMIN
            | RegistryRolesLib.ROLE_SET_SUBREGISTRY | RegistryRolesLib.ROLE_SET_SUBREGISTRY_ADMIN
            | RegistryRolesLib.ROLE_SET_PARENT | RegistryRolesLib.ROLE_SET_PARENT_ADMIN
            | RegistryRolesLib.ROLE_REGISTRAR_ADMIN | RegistryRolesLib.ROLE_RENEW_ADMIN
            | RegistryRolesLib.ROLE_UNREGISTER_ADMIN;
        assertFalse(humanos.hasAssignees(0, dangerous));
        assertFalse(rootReg.hasAssignees(0, dangerous));
        assertFalse(
            rootReg.hasAssignees(rootReg.getResource(uint256(keccak256(bytes(AGENT_LABEL)))), EACBaseRolesLib.ALL_ROLES)
        );

        uint256 resolverDangerous = PermissionedResolverLib.ROLE_UPGRADE | PermissionedResolverLib.ROLE_UPGRADE_ADMIN
            | PermissionedResolverLib.ROLE_LINK | PermissionedResolverLib.ROLE_LINK_ADMIN
            | PermissionedResolverLib.ROLE_SET_ADDRESS_ADMIN;
        PermissionedResolver resolver = PermissionedResolver(registrar.authorization(agentNode).resolver);
        assertFalse(resolver.hasAssignees(0, resolverDangerous));
        assertEq(
            resolver.roles(0, address(registrar)),
            PermissionedResolverLib.ROLE_SET_TEXT | PermissionedResolverLib.ROLE_SET_TEXT_ADMIN
                | PermissionedResolverLib.ROLE_SET_ADDRESS
        );
        assertEq(resolver.roles(0, agent), 0, "agent holds no resolver-wide roles");
        assertEq(resolver.roles(uint256(keccak256("humanos.status")), agent), PermissionedResolverLib.ROLE_SET_TEXT);
        assertEq(resolver.roles(uint256(keccak256("humanos.receipt")), agent), PermissionedResolverLib.ROLE_SET_TEXT);
    }

    function test_registerRoot_mountsInOfficialHierarchy() external {
        bytes32 rootNode = _root(uint64(block.timestamp) + YEAR);
        assertEq(rootNode, NameCoder.namehash(dns(ROOT_NAME), 0));
        assertEq(humanos.getOwner(uint256(keccak256(bytes(ROOT_LABEL)))), rootOwner);
        (address resolver, uint256 offset) = _resolvedAt(ROOT_NAME);
        assertEq(offset, 0, "resolver found at the root name itself");
        assertEq(factory.verifyContract(resolver), address(resolverImpl));
        assertEq(addrOf(resolver, ROOT_NAME), rootOwner);
        assertEq(textOf(resolver, ROOT_NAME, "humanos.root"), "root_01");

        IRegistry rootRegistry_ = humanos.getSubregistry(ROOT_LABEL);
        (IRegistry parent, string memory label) = rootRegistry_.getParent();
        assertEq(address(parent), address(humanos));
        assertEq(label, ROOT_LABEL);
        assertEq(factory.verifyContract(address(rootRegistry_)), address(userRegistryImpl));
    }

    function test_registerAgent_resolvesWithScopedRecords() external {
        (bytes32 rootNode, bytes32 agentNode) = _defaultAgent();
        assertEq(agentNode, NameCoder.namehash(dns(AGENT_NAME), 0));

        HumanOSRegistrar.AgentAuthorization memory a = registrar.authorization(agentNode);
        assertTrue(a.exists);
        assertTrue(a.active);
        assertFalse(a.revoked);
        assertEq(a.rootNode, rootNode);
        assertEq(a.rootId, "root_01");
        assertEq(a.name, AGENT_NAME);
        assertEq(a.account, agent);
        assertEq(a.capabilities, CAPS);
        assertEq(a.expiry, uint64(block.timestamp) + 7 days);

        (address resolver, uint256 offset) = _resolvedAt(AGENT_NAME);
        assertEq(offset, 0);
        assertEq(resolver, a.resolver);
        assertEq(factory.verifyContract(resolver), address(resolverImpl));
        assertEq(addrOf(resolver, AGENT_NAME), agent);
        assertEq(textOf(resolver, AGENT_NAME, "humanos.capabilities"), "0x0224");
        assertEq(textOf(resolver, AGENT_NAME, "humanos.root"), "root_01");
        assertEq(textOf(resolver, AGENT_NAME, "humanos.status"), "active");

        // Each agent gets its own resolver: resolver setter grants are resolver-wide per key.
        address otherAgent = makeAddr("other");
        bytes32 other = _agent(rootNode, "other-task", otherAgent, uint64(block.timestamp) + 7 days);
        assertTrue(registrar.authorization(other).resolver != resolver);
    }

    function test_agent_canWriteOnlyStatusAndReceipt() external {
        (, bytes32 agentNode) = _defaultAgent();
        PermissionedResolver resolver = PermissionedResolver(registrar.authorization(agentNode).resolver);
        bytes memory name = dns(AGENT_NAME);

        vm.startPrank(agent);
        resolver.setText(name, "humanos.status", "running");
        resolver.setText(name, "humanos.receipt", "0xabc");

        uint256 capsResource = uint256(keccak256("humanos.capabilities"));
        vm.expectRevert(
            abi.encodeWithSelector(
                IEnhancedAccessControl.EACUnauthorizedAccountRoles.selector,
                capsResource,
                PermissionedResolverLib.ROLE_SET_TEXT,
                agent
            )
        );
        resolver.setText(name, "humanos.capabilities", "0x3fff");

        vm.expectRevert();
        resolver.setText(name, "humanos.root", "someone-else");
        vm.expectRevert();
        resolver.setAddress(name, 60, abi.encodePacked(attacker));
        vm.expectRevert();
        resolver.setContenthash(name, hex"01");
        vm.expectRevert();
        resolver.linkToRecord(name, 0);
        vm.stopPrank();

        assertEq(textOf(address(resolver), AGENT_NAME, "humanos.status"), "running");
        assertEq(textOf(address(resolver), AGENT_NAME, "humanos.receipt"), "0xabc");
        assertEq(textOf(address(resolver), AGENT_NAME, "humanos.capabilities"), "0x0224");
    }

    // ------------------------------------------------------------------
    // role escalation / unauthorized mutation
    // ------------------------------------------------------------------

    function test_agent_cannotEscalateRoles() external {
        (bytes32 rootNode, bytes32 agentNode) = _defaultAgent();
        PermissionedResolver resolver = PermissionedResolver(registrar.authorization(agentNode).resolver);
        IPermissionedRegistry rootReg = IPermissionedRegistry(address(humanos.getSubregistry(ROOT_LABEL)));
        uint256 agentId = uint256(keccak256(bytes(AGENT_LABEL)));

        vm.startPrank(agent);
        vm.expectRevert();
        resolver.grantSetterRoles(_statusSetter("humanos.capabilities"), agent);
        vm.expectRevert();
        resolver.grantSetterRoles(_statusSetter("humanos.status"), attacker); // no admin on own key
        vm.expectRevert();
        resolver.grantRootRoles(PermissionedResolverLib.ROLE_SET_TEXT, agent);
        vm.expectRevert();
        resolver.grantRoles(1, PermissionedResolverLib.ROLE_SET_TEXT, agent);
        vm.expectRevert();
        resolver.upgradeToAndCall(address(resolverImpl), "");
        vm.expectRevert();
        rootReg.grantRoles(agentId, RegistryRolesLib.ROLE_SET_RESOLVER, agent);
        vm.expectRevert();
        rootReg.grantRootRoles(RegistryRolesLib.ROLE_RENEW, agent);
        vm.expectRevert();
        IStandardRegistry(address(rootReg)).setResolver(agentId, attacker);
        vm.expectRevert();
        IStandardRegistry(address(rootReg)).setSubregistry(agentId, IRegistry(attacker));
        vm.expectRevert();
        IStandardRegistry(address(rootReg)).renew(agentId, uint64(block.timestamp) + YEAR);
        vm.expectRevert();
        IStandardRegistry(address(rootReg))
            .register("evil", agent, IRegistry(address(0)), attacker, 0, uint64(block.timestamp) + 1 days);
        vm.expectRevert();
        registrar.narrowAgentCapabilities(agentNode, 1);
        vm.stopPrank();

        assertEq(rootReg.roles(agentId, agent), 0, "agent holds no registry roles on its own name");
        assertEq(registrar.authorization(agentNode).capabilities, CAPS);
        rootNode;
    }

    function test_rootOwner_andAttacker_cannotMutate() external {
        (bytes32 rootNode, bytes32 agentNode) = _defaultAgent();
        uint256 rootId = uint256(keccak256(bytes(ROOT_LABEL)));
        address[2] memory callers = [rootOwner, attacker];
        for (uint256 i; i < callers.length; ++i) {
            vm.startPrank(callers[i]);
            vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, callers[i]));
            registrar.registerRoot("mallory", "root_02", callers[i], uint64(block.timestamp) + YEAR);
            vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, callers[i]));
            registrar.registerAgent(rootNode, "evil", callers[i], CAPS, uint64(block.timestamp) + 1 days);
            vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, callers[i]));
            registrar.revokeAgent(agentNode);
            vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, callers[i]));
            registrar.renewAgent(agentNode, uint64(block.timestamp) + 8 days);
            vm.expectRevert();
            IStandardRegistry(address(humanos)).setResolver(rootId, attacker);
            vm.expectRevert();
            IStandardRegistry(address(humanos)).setSubregistry(rootId, IRegistry(attacker));
            vm.expectRevert();
            IStandardRegistry(address(humanos)).unregister(rootId);
            vm.stopPrank();
        }
        assertTrue(registrar.authorization(agentNode).active);
    }

    function test_nonTransferable() external {
        (, bytes32 agentNode) = _defaultAgent();
        PermissionedRegistry rootReg = PermissionedRegistry(address(humanos.getSubregistry(ROOT_LABEL)));
        uint256 agentToken = rootReg.findTokenId(AGENT_LABEL);
        uint256 rootToken = PermissionedRegistry(address(humanos)).findTokenId(ROOT_LABEL);

        vm.prank(agent);
        vm.expectRevert();
        rootReg.safeTransferFrom(agent, attacker, agentToken, 1, "");
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(IPermissionedRegistry.TransferDisallowed.selector, agentToken, agent));
        rootReg.unsafeTransfer(attacker, agentToken, "");

        // An approved operator inherits no transfer right either.
        vm.prank(agent);
        rootReg.setApprovalForAll(attacker, true);
        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(IPermissionedRegistry.TransferDisallowed.selector, agentToken, agent));
        rootReg.unsafeTransfer(attacker, agentToken, "");

        vm.prank(rootOwner);
        vm.expectRevert(abi.encodeWithSelector(IPermissionedRegistry.TransferDisallowed.selector, rootToken, rootOwner));
        PermissionedRegistry(address(humanos)).unsafeTransfer(attacker, rootToken, "");

        assertEq(rootReg.ownerOf(agentToken), agent);
        assertEq(registrar.authorization(agentNode).account, agent);
    }

    // ------------------------------------------------------------------
    // input validation
    // ------------------------------------------------------------------

    function test_rejectsInvalidInputs() external {
        bytes32 rootNode = _root(uint64(block.timestamp) + YEAR);
        uint64 exp = uint64(block.timestamp) + 1 days;
        string[6] memory bad = ["", "UPPER", "a.b", "-lead", "trail-", "sp ace"];
        vm.startPrank(operator);
        for (uint256 i; i < bad.length; ++i) {
            vm.expectRevert(abi.encodeWithSelector(HumanOSRegistrar.InvalidLabel.selector, bad[i]));
            registrar.registerAgent(rootNode, bad[i], agent, CAPS, exp);
        }
        string memory long = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"; // 64
        vm.expectRevert(abi.encodeWithSelector(HumanOSRegistrar.InvalidLabel.selector, long));
        registrar.registerAgent(rootNode, long, agent, CAPS, exp);

        vm.expectRevert(abi.encodeWithSelector(HumanOSRegistrar.InvalidCapabilities.selector, 0));
        registrar.registerAgent(rootNode, "task", agent, 0, exp);
        vm.expectRevert(abi.encodeWithSelector(HumanOSRegistrar.InvalidCapabilities.selector, 1 << 14));
        registrar.registerAgent(rootNode, "task", agent, 1 << 14, exp);
        vm.expectRevert(HumanOSRegistrar.InvalidAccount.selector);
        registrar.registerAgent(rootNode, "task", address(0), CAPS, exp);
        vm.expectRevert(abi.encodeWithSelector(HumanOSRegistrar.UnknownRoot.selector, bytes32(uint256(1))));
        registrar.registerAgent(bytes32(uint256(1)), "task", agent, CAPS, exp);
        vm.expectRevert(HumanOSRegistrar.RootIdAlreadyRegistered.selector);
        registrar.registerRoot("bob", "root_01", rootOwner, exp);
        vm.expectRevert(abi.encodeWithSelector(HumanOSRegistrar.InvalidRootId.selector));
        registrar.registerRoot("bob", "", rootOwner, exp);
        vm.stopPrank();
    }

    function testFuzz_capabilitiesOutsideClosedSetRejected(uint256 caps) external {
        vm.assume(caps >> 14 != 0);
        bytes32 rootNode = _root(uint64(block.timestamp) + YEAR);
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(HumanOSRegistrar.InvalidCapabilities.selector, caps));
        registrar.registerAgent(rootNode, "task", agent, caps, uint64(block.timestamp) + 1 days);
    }

    // ------------------------------------------------------------------
    // expiry and hierarchy
    // ------------------------------------------------------------------

    function test_agentExpiryBoundedByRoot_rootBoundedByParent() external {
        uint64 parentExpiry = ethRegistry.getExpiry(uint256(keccak256("humanos")));
        vm.startPrank(operator);
        vm.expectRevert(
            abi.encodeWithSelector(HumanOSRegistrar.ExpiryExceedsParent.selector, parentExpiry + 1, parentExpiry)
        );
        registrar.registerRoot(ROOT_LABEL, "root_01", rootOwner, parentExpiry + 1);
        uint64 rootExpiry = uint64(block.timestamp) + 30 days;
        bytes32 rootNode = registrar.registerRoot(ROOT_LABEL, "root_01", rootOwner, rootExpiry);
        vm.expectRevert(
            abi.encodeWithSelector(HumanOSRegistrar.ExpiryExceedsParent.selector, rootExpiry + 1, rootExpiry)
        );
        registrar.registerAgent(rootNode, AGENT_LABEL, agent, CAPS, rootExpiry + 1);
        vm.expectRevert(abi.encodeWithSelector(HumanOSRegistrar.ExpiryNotInFuture.selector, uint64(block.timestamp)));
        registrar.registerAgent(rootNode, AGENT_LABEL, agent, CAPS, uint64(block.timestamp));
        vm.stopPrank();
    }

    function test_agentExpiry_deactivatesAndStopsResolving() external {
        (, bytes32 agentNode) = _defaultAgent();
        HumanOSRegistrar.AgentAuthorization memory a = registrar.authorization(agentNode);
        vm.warp(a.expiry - 1);
        assertTrue(registrar.authorization(agentNode).active);
        vm.warp(a.expiry); // expired at block.timestamp >= expiry, matching the official registry
        a = registrar.authorization(agentNode);
        assertFalse(a.active);
        assertFalse(a.revoked);
        (address resolver, uint256 offset) = _resolvedAt(AGENT_NAME);
        assertTrue(offset != 0 || resolver != a.resolver, "expired agent no longer resolves to its resolver");
    }

    function test_expiredRoot_deactivatesAgents() external {
        bytes32 rootNode = _root(uint64(block.timestamp) + 30 days);
        bytes32 agentNode = _agent(rootNode, AGENT_LABEL, agent, uint64(block.timestamp) + 30 days);
        vm.warp(block.timestamp + 30 days);
        HumanOSRegistrar.AgentAuthorization memory a = registrar.authorization(agentNode);
        assertFalse(a.active, "agent inactive once root expires");
        (address resolver,) = _resolvedAt(AGENT_NAME);
        assertTrue(resolver != a.resolver);
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(HumanOSRegistrar.RootExpired.selector, rootNode));
        registrar.registerAgent(rootNode, "late", agent, CAPS, uint64(block.timestamp) + 1 days);
    }

    function test_expiredParent_deactivatesWholeHierarchy() external {
        (, bytes32 agentNode) = _defaultAgent();
        assertTrue(registrar.authorization(agentNode).active);
        // The parent owner detaching the HumanOS registry also breaks the chain.
        vm.prank(operator);
        ethRegistry.setSubregistry(uint256(keccak256("humanos")), IRegistry(address(0)));
        assertFalse(registrar.authorization(agentNode).active);
        vm.prank(operator);
        ethRegistry.setSubregistry(uint256(keccak256("humanos")), humanos);
        assertTrue(registrar.authorization(agentNode).active);

        vm.warp(ethRegistry.getExpiry(uint256(keccak256("humanos"))));
        assertFalse(registrar.authorization(agentNode).active, "expired parent name kills the subtree");
        (address resolver,) = _resolvedAt(AGENT_NAME);
        assertEq(resolver, address(0));
    }

    // ------------------------------------------------------------------
    // renewal restrictions
    // ------------------------------------------------------------------

    function test_renewal_restrictions() external {
        (bytes32 rootNode, bytes32 agentNode) = _defaultAgent();
        uint64 rootExpiry = registrar.authorization(agentNode).rootExpiry;
        vm.startPrank(operator);
        vm.expectRevert(
            abi.encodeWithSelector(HumanOSRegistrar.ExpiryExceedsParent.selector, rootExpiry + 1, rootExpiry)
        );
        registrar.renewAgent(agentNode, rootExpiry + 1);
        uint64 current = registrar.authorization(agentNode).agentExpiry;
        vm.expectRevert(); // official registry: CannotReduceExpiry
        registrar.renewAgent(agentNode, current - 1);
        registrar.renewAgent(agentNode, rootExpiry);
        assertEq(registrar.authorization(agentNode).agentExpiry, rootExpiry);

        registrar.renewRoot(rootNode, rootExpiry + 30 days);
        registrar.renewAgent(agentNode, rootExpiry + 30 days);
        assertEq(registrar.authorization(agentNode).expiry, rootExpiry + 30 days);
        vm.stopPrank();

        vm.warp(rootExpiry + 30 days);
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(HumanOSRegistrar.AgentExpired.selector, agentNode));
        registrar.renewAgent(agentNode, rootExpiry + 31 days);
    }

    function test_renewRoot_boundedByParent() external {
        bytes32 rootNode = _root(uint64(block.timestamp) + YEAR);
        uint64 parentExpiry = ethRegistry.getExpiry(uint256(keccak256("humanos")));
        vm.prank(operator);
        vm.expectRevert(
            abi.encodeWithSelector(HumanOSRegistrar.ExpiryExceedsParent.selector, parentExpiry + 1, parentExpiry)
        );
        registrar.renewRoot(rootNode, parentExpiry + 1);
    }

    // ------------------------------------------------------------------
    // revocation
    // ------------------------------------------------------------------

    function test_revokeAgent_removesIdentityAndRecordRights() external {
        (bytes32 rootNode, bytes32 agentNode) = _defaultAgent();
        HumanOSRegistrar.AgentAuthorization memory before = registrar.authorization(agentNode);
        PermissionedResolver resolver = PermissionedResolver(before.resolver);
        IPermissionedRegistry rootReg = IPermissionedRegistry(address(humanos.getSubregistry(ROOT_LABEL)));

        vm.prank(operator);
        registrar.revokeAgent(agentNode);

        HumanOSRegistrar.AgentAuthorization memory a = registrar.authorization(agentNode);
        assertFalse(a.active);
        assertTrue(a.revoked);
        assertEq(
            uint8(rootReg.getStatus(uint256(keccak256(bytes(AGENT_LABEL))))),
            uint8(IPermissionedRegistry.Status.AVAILABLE)
        );
        assertFalse(
            resolver.hasRoles(uint256(keccak256("humanos.status")), PermissionedResolverLib.ROLE_SET_TEXT, agent)
        );
        assertFalse(
            resolver.hasRoles(uint256(keccak256("humanos.receipt")), PermissionedResolverLib.ROLE_SET_TEXT, agent)
        );
        assertEq(textOf(address(resolver), AGENT_NAME, "humanos.status"), "revoked");
        (address found,) = _resolvedAt(AGENT_NAME);
        assertTrue(found != address(resolver));

        vm.prank(agent);
        vm.expectRevert();
        resolver.setText(dns(AGENT_NAME), "humanos.status", "still-running");

        vm.startPrank(operator);
        vm.expectRevert(abi.encodeWithSelector(HumanOSRegistrar.AgentRevoked.selector, agentNode));
        registrar.revokeAgent(agentNode);
        vm.expectRevert(abi.encodeWithSelector(HumanOSRegistrar.AgentRevoked.selector, agentNode));
        registrar.renewAgent(agentNode, uint64(block.timestamp) + 8 days);
        vm.expectRevert(abi.encodeWithSelector(HumanOSRegistrar.AgentRevoked.selector, agentNode));
        registrar.narrowAgentCapabilities(agentNode, CAP_DRAFTS_WRITE);
        vm.expectRevert(abi.encodeWithSelector(HumanOSRegistrar.LabelAlreadyUsed.selector, AGENT_LABEL));
        registrar.registerAgent(rootNode, AGENT_LABEL, agent, CAPS, uint64(block.timestamp) + 1 days);
        vm.stopPrank();
    }

    function test_revocationRace_sameBlockOrdering() external {
        (, bytes32 agentNode) = _defaultAgent();
        PermissionedResolver resolver = PermissionedResolver(registrar.authorization(agentNode).resolver);
        bytes memory name = dns(AGENT_NAME);
        uint256 blockBefore = block.number;

        // Agent write lands before the revocation in the same block: allowed.
        vm.prank(agent);
        resolver.setText(name, "humanos.receipt", "0x01");
        vm.prank(operator);
        registrar.revokeAgent(agentNode);
        // Any agent write ordered after the revocation in that block fails.
        vm.prank(agent);
        vm.expectRevert();
        resolver.setText(name, "humanos.receipt", "0x02");
        assertEq(block.number, blockBefore);
        assertFalse(registrar.authorization(agentNode).active);
        assertEq(textOf(address(resolver), AGENT_NAME, "humanos.receipt"), "0x01");
    }

    function test_revocationRace_renewAndNarrowAfterRevokeFail() external {
        (, bytes32 agentNode) = _defaultAgent();
        vm.startPrank(operator);
        registrar.renewAgent(agentNode, uint64(block.timestamp) + 8 days); // renew before revoke: ok
        registrar.revokeAgent(agentNode);
        vm.expectRevert(abi.encodeWithSelector(HumanOSRegistrar.AgentRevoked.selector, agentNode));
        registrar.renewAgent(agentNode, uint64(block.timestamp) + 9 days);
        vm.stopPrank();
        assertFalse(registrar.authorization(agentNode).active);
    }

    function test_revokeRoot_cascadesToAllAgents() external {
        (bytes32 rootNode, bytes32 agentNode) = _defaultAgent();
        address agent2 = makeAddr("agent2");
        bytes32 agentNode2 = _agent(rootNode, "calendar", agent2, uint64(block.timestamp) + 7 days);
        PermissionedResolver r2 = PermissionedResolver(registrar.authorization(agentNode2).resolver);

        vm.prank(operator);
        registrar.revokeRoot(rootNode);

        assertFalse(registrar.authorization(agentNode).active);
        assertTrue(registrar.authorization(agentNode).revoked);
        assertTrue(registrar.authorization(agentNode2).revoked);
        vm.prank(agent2);
        vm.expectRevert();
        r2.setText(dns("calendar.alice.humanos.eth"), "humanos.status", "x");
        assertEq(
            uint8(humanos.getStatus(uint256(keccak256(bytes(ROOT_LABEL))))),
            uint8(IPermissionedRegistry.Status.AVAILABLE)
        );
        (address found,) = _resolvedAt(ROOT_NAME);
        assertTrue(found == address(0) || found != registrar.rootResolver(rootNode));

        vm.startPrank(operator);
        vm.expectRevert(abi.encodeWithSelector(HumanOSRegistrar.RootRevoked.selector, rootNode));
        registrar.registerAgent(rootNode, "after", agent, CAPS, uint64(block.timestamp) + 1 days);
        vm.expectRevert(abi.encodeWithSelector(HumanOSRegistrar.RootRevoked.selector, rootNode));
        registrar.renewRoot(rootNode, uint64(block.timestamp) + 2 * YEAR);
        vm.expectRevert(abi.encodeWithSelector(HumanOSRegistrar.RootRevoked.selector, rootNode));
        registrar.revokeRoot(rootNode);
        vm.expectRevert(abi.encodeWithSelector(HumanOSRegistrar.LabelAlreadyUsed.selector, ROOT_LABEL));
        registrar.registerRoot(ROOT_LABEL, "root_99", rootOwner, uint64(block.timestamp) + YEAR);
        vm.stopPrank();
    }

    function test_revokeAgentAfterExpiry_stillRevokesRecordRights() external {
        (, bytes32 agentNode) = _defaultAgent();
        PermissionedResolver resolver = PermissionedResolver(registrar.authorization(agentNode).resolver);
        vm.warp(registrar.authorization(agentNode).expiry + 1);
        vm.prank(operator);
        registrar.revokeAgent(agentNode);
        assertTrue(registrar.authorization(agentNode).revoked);
        vm.prank(agent);
        vm.expectRevert();
        resolver.setText(dns(AGENT_NAME), "humanos.status", "zombie");
    }

    // ------------------------------------------------------------------
    // narrowing
    // ------------------------------------------------------------------

    function test_narrowCapabilities_onlySubset() external {
        (, bytes32 agentNode) = _defaultAgent();
        address resolver = registrar.authorization(agentNode).resolver;
        vm.startPrank(operator);
        vm.expectRevert(abi.encodeWithSelector(HumanOSRegistrar.CapabilityEscalation.selector, CAPS, CAPS | 1));
        registrar.narrowAgentCapabilities(agentNode, CAPS | 1);
        vm.expectRevert(abi.encodeWithSelector(HumanOSRegistrar.InvalidCapabilities.selector, 0));
        registrar.narrowAgentCapabilities(agentNode, 0);
        registrar.narrowAgentCapabilities(agentNode, CAP_DRAFTS_WRITE);
        vm.stopPrank();
        assertEq(registrar.authorization(agentNode).capabilities, CAP_DRAFTS_WRITE);
        assertEq(textOf(resolver, AGENT_NAME, "humanos.capabilities"), "0x04");
    }

    function test_ownership_twoStepTransfer() external {
        vm.prank(operator);
        registrar.transferOwnership(attacker);
        assertEq(registrar.owner(), operator, "pending owner has no power until accepted");
        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, attacker));
        registrar.registerRoot("x", "root_x", attacker, uint64(block.timestamp) + 1 days);
    }
}
