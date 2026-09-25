// SPDX-License-Identifier: MIT
pragma solidity 0.8.25;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {VerifiableFactory} from "@ensdomains/verifiable-factory/VerifiableFactory.sol";
import {NameCoder} from "@ens/contracts/utils/NameCoder.sol";

import {
    Grant,
    IEACGrantInitializable
} from "@ensdomains/contracts-v2/access-control/interfaces/IEACGrantInitializable.sol";
import {IEnhancedAccessControl} from "@ensdomains/contracts-v2/access-control/interfaces/IEnhancedAccessControl.sol";
import {IRegistry} from "@ensdomains/contracts-v2/registry/interfaces/IRegistry.sol";
import {IPermissionedRegistry} from "@ensdomains/contracts-v2/registry/interfaces/IPermissionedRegistry.sol";
import {RegistryRolesLib} from "@ensdomains/contracts-v2/registry/libraries/RegistryRolesLib.sol";
import {
    IPermissionedResolverInitializable
} from "@ensdomains/contracts-v2/resolver/interfaces/IPermissionedResolverInitializable.sol";
import {PermissionedResolverLib} from "@ensdomains/contracts-v2/resolver/libraries/PermissionedResolverLib.sol";

/// @dev The subset of the official PermissionedResolver surface used here.
interface IHumanOSResolver is IEnhancedAccessControl {
    function setText(bytes calldata name, string calldata key, string calldata value) external;
    function setAddress(bytes calldata name, uint256 coinType, bytes calldata addressBytes) external;
    function grantSetterRoles(bytes calldata setter, address account) external returns (bool);
}

/// @title HumanOSRegistrar
/// @notice Thin controller composing official ENSv2 primitives into HumanOS agent identities:
///
///   <parent>.eth                 parent name owned by the operator (official ETH registry)
///   └─ HumanOS UserRegistry      deployed by this contract via the official VerifiableFactory
///      └─ <root>.<parent>.eth    one per verified human (rootId), owned by `rootOwner`
///         └─ root UserRegistry
///            └─ <task>.<root>.<parent>.eth   task agent, owned by the agent account
///
/// Every root and agent gets its own official PermissionedResolver proxy. Resolver setter grants
/// are resolver-wide per key, so a dedicated resolver is what confines an agent's argument-scoped
/// `humanos.status` / `humanos.receipt` text grants to its own name.
///
/// Names are registered with an empty role bitmap: holders cannot transfer (no
/// ROLE_CAN_TRANSFER_ADMIN), change resolvers or subregistries, or renew. This contract keeps only
/// ROLE_REGISTRAR, ROLE_RENEW and ROLE_UNREGISTER on its registries; nobody holds upgrade,
/// resolver, subregistry or admin roles, and canonical parent pointers are locked.
contract HumanOSRegistrar is Ownable2Step {
    ////////////////////////////////////////////////////////////////////////
    // Types
    ////////////////////////////////////////////////////////////////////////

    struct Config {
        /// @dev Official VerifiableFactory.
        address factory;
        /// @dev Official UserRegistryImpl.
        address userRegistryImplementation;
        /// @dev Official PermissionedResolverImpl.
        address resolverImplementation;
        /// @dev Registry holding the parent name (the official .eth registry on Sepolia).
        IPermissionedRegistry parentRegistry;
        /// @dev Parent label, e.g. "humanos" for humanos.eth.
        string parentLabel;
        /// @dev DNS-encoded name of `parentRegistry`, e.g. "\x03eth\x00".
        bytes parentSuffix;
    }

    struct Root {
        bool exists;
        bool revoked;
        string label;
        string rootId;
        IPermissionedRegistry registry;
        address resolver;
        bytes32[] agents;
    }

    struct Agent {
        bool exists;
        bool revoked;
        bytes32 rootNode;
        string label;
        address account;
        address resolver;
        uint256 capabilities;
    }

    /// @notice Snapshot of an agent's authorization, derived from live official registry state.
    struct AgentAuthorization {
        bool exists;
        bool active;
        bool revoked;
        bytes32 rootNode;
        string rootId;
        string name;
        address account;
        address resolver;
        uint256 capabilities;
        /// @dev min(agentExpiry, rootExpiry, parentExpiry).
        uint64 expiry;
        uint64 agentExpiry;
        uint64 rootExpiry;
        uint64 parentExpiry;
    }

    ////////////////////////////////////////////////////////////////////////
    // Constants
    ////////////////////////////////////////////////////////////////////////

    /// @dev Bit i = i-th entry of @humanos/schemas CapabilitySchema (14 closed capabilities).
    uint256 public constant CAPABILITY_MASK = (1 << 14) - 1;
    uint256 public constant MAX_AGENTS_PER_ROOT = 64;
    uint256 public constant MAX_ROOT_ID_LENGTH = 256;

    string public constant STATUS_KEY = "humanos.status";
    string public constant RECEIPT_KEY = "humanos.receipt";
    string public constant CAPABILITIES_KEY = "humanos.capabilities";
    string public constant ROOT_KEY = "humanos.root";

    uint256 internal constant REGISTRY_ROLES =
        RegistryRolesLib.ROLE_REGISTRAR | RegistryRolesLib.ROLE_RENEW | RegistryRolesLib.ROLE_UNREGISTER;
    uint256 internal constant PARENT_ROLES = RegistryRolesLib.ROLE_SET_PARENT | RegistryRolesLib.ROLE_SET_PARENT_ADMIN;
    uint256 internal constant RESOLVER_ROLES = PermissionedResolverLib.ROLE_SET_TEXT
        | PermissionedResolverLib.ROLE_SET_TEXT_ADMIN | PermissionedResolverLib.ROLE_SET_ADDRESS;

    ////////////////////////////////////////////////////////////////////////
    // Immutables / storage
    ////////////////////////////////////////////////////////////////////////

    VerifiableFactory public immutable FACTORY;
    address public immutable USER_REGISTRY_IMPLEMENTATION;
    address public immutable RESOLVER_IMPLEMENTATION;
    IPermissionedRegistry public immutable PARENT_REGISTRY;
    IPermissionedRegistry public immutable HUMANOS_REGISTRY;
    bytes32 public immutable PARENT_NODE;

    string public parentLabel;
    string public parentName;
    bytes internal _parentDns;

    mapping(bytes32 rootNode => Root) internal _roots;
    mapping(bytes32 agentNode => Agent) internal _agents;
    mapping(bytes32 rootIdHash => bytes32 rootNode) public rootNodeOf;
    /// @dev Labels are single-use: a revoked or expired identity never comes back under the same name.
    mapping(bytes32 node => bool) public nodeUsed;

    ////////////////////////////////////////////////////////////////////////
    // Events / errors
    ////////////////////////////////////////////////////////////////////////

    event RootRegistered(
        bytes32 indexed rootNode,
        string label,
        string rootId,
        address owner,
        address registry,
        address resolver,
        uint64 expiry
    );
    event AgentRegistered(
        bytes32 indexed agentNode,
        bytes32 indexed rootNode,
        string label,
        address account,
        address resolver,
        uint256 capabilities,
        uint64 expiry
    );
    event RootRenewed(bytes32 indexed rootNode, uint64 expiry);
    event AgentRenewed(bytes32 indexed agentNode, uint64 expiry);
    event AgentCapabilitiesNarrowed(bytes32 indexed agentNode, uint256 capabilities);
    event AgentIdentityRevoked(bytes32 indexed agentNode, bytes32 indexed rootNode);
    event RootIdentityRevoked(bytes32 indexed rootNode);

    error InvalidLabel(string label);
    error InvalidCapabilities(uint256 capabilities);
    error InvalidAccount();
    error InvalidRootId();
    error UnknownRoot(bytes32 rootNode);
    error UnknownAgent(bytes32 agentNode);
    error RootIdAlreadyRegistered();
    error LabelAlreadyUsed(string label);
    error ExpiryExceedsParent(uint64 expiry, uint64 parentExpiry);
    error ExpiryNotInFuture(uint64 expiry);
    error RootExpired(bytes32 rootNode);
    error AgentExpired(bytes32 agentNode);
    error RootRevoked(bytes32 rootNode);
    error AgentRevoked(bytes32 agentNode);
    error CapabilityEscalation(uint256 current, uint256 requested);
    error TooManyAgents(bytes32 rootNode);

    ////////////////////////////////////////////////////////////////////////
    // Construction
    ////////////////////////////////////////////////////////////////////////

    constructor(Config memory config, address initialOwner) Ownable(initialOwner) {
        _checkLabel(config.parentLabel);
        FACTORY = VerifiableFactory(config.factory);
        USER_REGISTRY_IMPLEMENTATION = config.userRegistryImplementation;
        RESOLVER_IMPLEMENTATION = config.resolverImplementation;
        PARENT_REGISTRY = config.parentRegistry;
        parentLabel = config.parentLabel;
        bytes memory parentDns = _dnsName(config.parentLabel, config.parentSuffix);
        _parentDns = parentDns;
        parentName = NameCoder.decode(parentDns);
        bytes32 parentNode = NameCoder.namehash(parentDns, 0);
        PARENT_NODE = parentNode;
        HUMANOS_REGISTRY = _deployRegistry(
            VerifiableFactory(config.factory),
            config.userRegistryImplementation,
            parentNode,
            config.parentRegistry,
            config.parentLabel
        );
    }

    ////////////////////////////////////////////////////////////////////////
    // Roots
    ////////////////////////////////////////////////////////////////////////

    /// @notice Register `<label>.<parent>` for one verified human identified by `rootId`.
    function registerRoot(string calldata label, string calldata rootId, address rootOwner, uint64 expiry)
        external
        onlyOwner
        returns (bytes32 rootNode)
    {
        _checkLabel(label);
        uint256 rootIdLength = bytes(rootId).length;
        if (rootIdLength == 0 || rootIdLength > MAX_ROOT_ID_LENGTH) revert InvalidRootId();
        if (rootOwner == address(0)) revert InvalidAccount();
        _checkExpiry(expiry, _parentExpiry());
        bytes32 rootIdHash = keccak256(bytes(rootId));
        if (rootNodeOf[rootIdHash] != bytes32(0)) revert RootIdAlreadyRegistered();

        rootNode = _childNode(PARENT_NODE, label);
        if (nodeUsed[rootNode]) revert LabelAlreadyUsed(label);
        nodeUsed[rootNode] = true;
        rootNodeOf[rootIdHash] = rootNode;
        _createRoot(rootNode, label, rootId, rootOwner, expiry);
    }

    function _createRoot(
        bytes32 rootNode,
        string calldata label,
        string calldata rootId,
        address rootOwner,
        uint64 expiry
    ) internal {
        Root storage root = _roots[rootNode];
        root.exists = true;
        root.label = label;
        root.rootId = rootId;
        root.registry = _deployRegistry(FACTORY, USER_REGISTRY_IMPLEMENTATION, rootNode, HUMANOS_REGISTRY, label);
        bytes memory name = _dnsName(label, _parentDns);
        bytes[] memory calls = new bytes[](3);
        calls[0] = abi.encodeCall(IHumanOSResolver.setAddress, (name, 60, abi.encodePacked(rootOwner)));
        calls[1] = abi.encodeCall(IHumanOSResolver.setText, (name, ROOT_KEY, rootId));
        calls[2] = abi.encodeCall(IHumanOSResolver.setText, (name, STATUS_KEY, "active"));
        root.resolver = _deployResolver(rootNode, calls);
        HUMANOS_REGISTRY.register(label, rootOwner, IRegistry(address(root.registry)), root.resolver, 0, expiry);
        emit RootRegistered(rootNode, label, rootId, rootOwner, address(root.registry), root.resolver, expiry);
    }

    /// @notice Extend a root; bounded by the parent name's expiry. Expired roots cannot be revived.
    function renewRoot(bytes32 rootNode, uint64 newExpiry) external onlyOwner {
        Root storage root = _liveRoot(rootNode);
        _checkExpiry(newExpiry, _parentExpiry());
        HUMANOS_REGISTRY.renew(_labelId(root.label), newExpiry);
        emit RootRenewed(rootNode, newExpiry);
    }

    /// @notice Revoke a root and every agent under it.
    function revokeRoot(bytes32 rootNode) external onlyOwner {
        Root storage root = _knownRoot(rootNode);
        if (root.revoked) revert RootRevoked(rootNode);
        root.revoked = true;
        uint256 count = root.agents.length;
        for (uint256 i; i < count; ++i) {
            bytes32 agentNode = root.agents[i];
            if (!_agents[agentNode].revoked) _revokeAgent(agentNode, _agents[agentNode]);
        }
        IHumanOSResolver(root.resolver).setText(_dnsName(root.label, _parentDns), STATUS_KEY, "revoked");
        uint256 id = _labelId(root.label);
        if (!_isExpired(HUMANOS_REGISTRY.getExpiry(id))) HUMANOS_REGISTRY.unregister(id);
        emit RootIdentityRevoked(rootNode);
    }

    ////////////////////////////////////////////////////////////////////////
    // Agents
    ////////////////////////////////////////////////////////////////////////

    /// @notice Register `<label>.<root>.<parent>` for a task agent account with a closed capability set.
    function registerAgent(
        bytes32 rootNode,
        string calldata label,
        address account,
        uint256 capabilities,
        uint64 expiry
    ) external onlyOwner returns (bytes32 agentNode) {
        Root storage root = _liveRoot(rootNode);
        _checkLabel(label);
        _checkCapabilities(capabilities);
        if (account == address(0)) revert InvalidAccount();
        _checkExpiry(expiry, HUMANOS_REGISTRY.getExpiry(_labelId(root.label)));
        if (root.agents.length >= MAX_AGENTS_PER_ROOT) revert TooManyAgents(rootNode);

        agentNode = _childNode(rootNode, label);
        if (nodeUsed[agentNode]) revert LabelAlreadyUsed(label);
        nodeUsed[agentNode] = true;

        root.agents.push(agentNode);
        Agent storage agent = _agents[agentNode];
        agent.exists = true;
        agent.rootNode = rootNode;
        agent.label = label;
        agent.account = account;
        agent.capabilities = capabilities;
        agent.resolver = _deployAgentResolver(agentNode, root, label, account, capabilities);
        root.registry.register(label, account, IRegistry(address(0)), agent.resolver, 0, expiry);
        emit AgentRegistered(agentNode, rootNode, label, account, agent.resolver, capabilities, expiry);
    }

    function _deployAgentResolver(
        bytes32 agentNode,
        Root storage root,
        string calldata label,
        address account,
        uint256 capabilities
    ) internal returns (address) {
        bytes memory name = _agentDns(root, label);
        bytes[] memory calls = new bytes[](4);
        calls[0] = abi.encodeCall(IHumanOSResolver.setAddress, (name, 60, abi.encodePacked(account)));
        calls[1] = abi.encodeCall(IHumanOSResolver.setText, (name, ROOT_KEY, root.rootId));
        calls[2] = abi.encodeCall(IHumanOSResolver.setText, (name, CAPABILITIES_KEY, Strings.toHexString(capabilities)));
        calls[3] = abi.encodeCall(IHumanOSResolver.setText, (name, STATUS_KEY, "active"));
        IHumanOSResolver resolver = IHumanOSResolver(_deployResolver(agentNode, calls));
        // Argument-scoped grants: the agent may write exactly these two text keys.
        resolver.grantSetterRoles(abi.encodeCall(IHumanOSResolver.setText, ("", STATUS_KEY, "")), account);
        resolver.grantSetterRoles(abi.encodeCall(IHumanOSResolver.setText, ("", RECEIPT_KEY, "")), account);
        return address(resolver);
    }

    /// @notice Extend a live agent; bounded by its root's expiry. Expired agents cannot be revived.
    function renewAgent(bytes32 agentNode, uint64 newExpiry) external onlyOwner {
        Agent storage agent = _knownAgent(agentNode);
        if (agent.revoked) revert AgentRevoked(agentNode);
        Root storage root = _roots[agent.rootNode];
        if (root.revoked) revert RootRevoked(agent.rootNode);
        uint256 id = _labelId(agent.label);
        if (_isExpired(root.registry.getExpiry(id))) revert AgentExpired(agentNode);
        _checkExpiry(newExpiry, HUMANOS_REGISTRY.getExpiry(_labelId(root.label)));
        root.registry.renew(id, newExpiry);
        emit AgentRenewed(agentNode, newExpiry);
    }

    /// @notice Reduce an agent's capabilities. Capabilities can never be broadened after registration.
    function narrowAgentCapabilities(bytes32 agentNode, uint256 capabilities) external onlyOwner {
        Agent storage agent = _knownAgent(agentNode);
        if (agent.revoked) revert AgentRevoked(agentNode);
        _checkCapabilities(capabilities);
        uint256 current = agent.capabilities;
        if (capabilities & ~current != 0) revert CapabilityEscalation(current, capabilities);
        agent.capabilities = capabilities;
        IHumanOSResolver(agent.resolver)
            .setText(
                _agentDns(_roots[agent.rootNode], agent.label), CAPABILITIES_KEY, Strings.toHexString(capabilities)
            );
        emit AgentCapabilitiesNarrowed(agentNode, capabilities);
    }

    /// @notice Revoke an agent: removes its record grants and unregisters its name.
    function revokeAgent(bytes32 agentNode) external onlyOwner {
        Agent storage agent = _knownAgent(agentNode);
        if (agent.revoked) revert AgentRevoked(agentNode);
        _revokeAgent(agentNode, agent);
    }

    ////////////////////////////////////////////////////////////////////////
    // Views
    ////////////////////////////////////////////////////////////////////////

    /// @notice Current authorization, active only if the whole official hierarchy still points at
    ///         this agent: parent -> HumanOS registry -> root registry -> agent resolver/owner.
    function authorization(bytes32 agentNode) external view returns (AgentAuthorization memory a) {
        Agent storage agent = _agents[agentNode];
        if (!agent.exists) return a;
        Root storage root = _roots[agent.rootNode];

        a.exists = true;
        a.revoked = agent.revoked || root.revoked;
        a.rootNode = agent.rootNode;
        a.rootId = root.rootId;
        a.name = string.concat(agent.label, ".", root.label, ".", parentName);
        a.account = agent.account;
        a.resolver = agent.resolver;
        a.capabilities = agent.capabilities;
        a.parentExpiry = _parentExpiry();
        a.rootExpiry = HUMANOS_REGISTRY.getExpiry(_labelId(root.label));
        a.agentExpiry = root.registry.getExpiry(_labelId(agent.label));
        a.expiry = _min(a.agentExpiry, _min(a.rootExpiry, a.parentExpiry));
        a.active = !a.revoked && !_isExpired(a.expiry)
            && address(PARENT_REGISTRY.getSubregistry(parentLabel)) == address(HUMANOS_REGISTRY)
            && address(HUMANOS_REGISTRY.getSubregistry(root.label)) == address(root.registry)
            && root.registry.getResolver(agent.label) == agent.resolver
            && root.registry.getOwner(_labelId(agent.label)) == agent.account;
    }

    function rootResolver(bytes32 rootNode) external view returns (address) {
        return _roots[rootNode].resolver;
    }

    function rootRegistry(bytes32 rootNode) external view returns (IPermissionedRegistry) {
        return _roots[rootNode].registry;
    }

    function rootAgents(bytes32 rootNode) external view returns (bytes32[] memory) {
        return _roots[rootNode].agents;
    }

    function isRootRevoked(bytes32 rootNode) external view returns (bool) {
        return _roots[rootNode].revoked;
    }

    ////////////////////////////////////////////////////////////////////////
    // Internal
    ////////////////////////////////////////////////////////////////////////

    function _revokeAgent(bytes32 agentNode, Agent storage agent) internal {
        agent.revoked = true;
        IHumanOSResolver resolver = IHumanOSResolver(agent.resolver);
        resolver.revokeRoles(
            uint256(keccak256(bytes(STATUS_KEY))), PermissionedResolverLib.ROLE_SET_TEXT, agent.account
        );
        resolver.revokeRoles(
            uint256(keccak256(bytes(RECEIPT_KEY))), PermissionedResolverLib.ROLE_SET_TEXT, agent.account
        );
        Root storage root = _roots[agent.rootNode];
        resolver.setText(_agentDns(root, agent.label), STATUS_KEY, "revoked");
        uint256 id = _labelId(agent.label);
        // Expired names cannot be unregistered; they stay unrevivable because only this contract
        // holds ROLE_RENEW and it refuses expired or revoked agents.
        if (!_isExpired(root.registry.getExpiry(id))) root.registry.unregister(id);
        emit AgentIdentityRevoked(agentNode, agent.rootNode);
    }

    /// @dev Deploy an official UserRegistry proxy, mount its canonical parent, and lock that pointer.
    function _deployRegistry(
        VerifiableFactory factory,
        address implementation,
        bytes32 node,
        IRegistry parent,
        string memory label
    ) internal returns (IPermissionedRegistry registry) {
        Grant[] memory grants = new Grant[](1);
        grants[0] = Grant(address(this), REGISTRY_ROLES | PARENT_ROLES);
        uint256 salt = uint256(keccak256(abi.encode(keccak256("UserRegistry"), node, uint256(0))));
        registry = IPermissionedRegistry(
            factory.deployProxy(implementation, salt, abi.encodeCall(IEACGrantInitializable.initialize, (grants)))
        );
        registry.setParent(parent, label);
        registry.revokeRootRoles(PARENT_ROLES, address(this));
    }

    /// @dev Deploy an official PermissionedResolver proxy with initial records (set during
    ///      initialization, as documented) and no upgrade or link roles for anyone.
    function _deployResolver(bytes32 node, bytes[] memory calls) internal returns (address) {
        Grant[] memory grants = new Grant[](1);
        grants[0] = Grant(address(this), RESOLVER_ROLES);
        uint256 salt = uint256(keccak256(abi.encode(keccak256("HumanOSResolver"), node, uint256(0))));
        return FACTORY.deployProxy(
            RESOLVER_IMPLEMENTATION,
            salt,
            abi.encodeCall(IPermissionedResolverInitializable.initialize, (grants, calls))
        );
    }

    function _knownRoot(bytes32 rootNode) internal view returns (Root storage root) {
        root = _roots[rootNode];
        if (!root.exists) revert UnknownRoot(rootNode);
    }

    function _liveRoot(bytes32 rootNode) internal view returns (Root storage root) {
        root = _knownRoot(rootNode);
        if (root.revoked) revert RootRevoked(rootNode);
        if (_isExpired(HUMANOS_REGISTRY.getExpiry(_labelId(root.label)))) revert RootExpired(rootNode);
    }

    function _knownAgent(bytes32 agentNode) internal view returns (Agent storage agent) {
        agent = _agents[agentNode];
        if (!agent.exists) revert UnknownAgent(agentNode);
    }

    function _parentExpiry() internal view returns (uint64) {
        return PARENT_REGISTRY.getExpiry(_labelId(parentLabel));
    }

    function _checkExpiry(uint64 expiry, uint64 bound) internal view {
        if (_isExpired(expiry)) revert ExpiryNotInFuture(expiry);
        if (expiry > bound) revert ExpiryExceedsParent(expiry, bound);
    }

    function _checkCapabilities(uint256 capabilities) internal pure {
        if (capabilities == 0 || capabilities & ~CAPABILITY_MASK != 0) revert InvalidCapabilities(capabilities);
    }

    /// @dev Accept only unambiguous, already-normalized labels: [a-z0-9-]{1,63}, no edge hyphens.
    function _checkLabel(string memory label) internal pure {
        bytes memory b = bytes(label);
        uint256 length = b.length;
        if (length == 0 || length > 63 || b[0] == "-" || b[length - 1] == "-") revert InvalidLabel(label);
        for (uint256 i; i < length; ++i) {
            bytes1 c = b[i];
            if (!((c >= "a" && c <= "z") || (c >= "0" && c <= "9") || c == "-")) revert InvalidLabel(label);
        }
    }

    function _agentDns(Root storage root, string memory label) internal view returns (bytes memory) {
        return _dnsName(label, _dnsName(root.label, _parentDns));
    }

    function _dnsName(string memory label, bytes memory suffix) internal pure returns (bytes memory) {
        return abi.encodePacked(uint8(bytes(label).length), label, suffix);
    }

    function _childNode(bytes32 parent, string memory label) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(parent, keccak256(bytes(label))));
    }

    function _labelId(string memory label) internal pure returns (uint256) {
        return uint256(keccak256(bytes(label)));
    }

    function _isExpired(uint64 expiry) internal view returns (bool) {
        return block.timestamp >= expiry;
    }

    function _min(uint64 a, uint64 b) internal pure returns (uint64) {
        return a < b ? a : b;
    }
}
