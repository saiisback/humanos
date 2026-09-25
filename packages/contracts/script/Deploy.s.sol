// SPDX-License-Identifier: MIT
pragma solidity 0.8.25;

import {Script, console} from "forge-std/Script.sol";
import {NameCoder} from "@ens/contracts/utils/NameCoder.sol";

import {IPermissionedRegistry} from "@ensdomains/contracts-v2/registry/interfaces/IPermissionedRegistry.sol";
import {IStandardRegistry} from "@ensdomains/contracts-v2/registry/interfaces/IStandardRegistry.sol";
import {RegistryRolesLib} from "@ensdomains/contracts-v2/registry/libraries/RegistryRolesLib.sol";

import {HumanOSRegistrar} from "../src/HumanOSRegistrar.sol";

/// @notice Deploys HumanOSRegistrar against the official ENSv2 Sepolia deployment and mounts the
///         HumanOS registry under an existing `<HUMANOS_PARENT_LABEL>.eth` owned by the deployer.
///
/// Refuses unless: chain is Sepolia, DEPLOYER_PRIVATE_KEY and HUMANOS_PARENT_LABEL are set, every
/// official contract from deployments/ensv2-sepolia.json has code, and the deployer currently owns
/// the parent name with ROLE_SET_SUBREGISTRY. Nothing is broadcast unless forge is run with
/// `--broadcast`; see packages/contracts/README.md.
contract Deploy is Script {
    uint256 internal constant SEPOLIA_CHAIN_ID = 11155111;
    string internal constant METADATA = "deployments/ensv2-sepolia.json";

    struct Official {
        IPermissionedRegistry ethRegistry;
        address factory;
        address userRegistryImpl;
        address resolverImpl;
    }

    error WrongChain(uint256 chainId);
    error MissingEnv(string name);
    error OfficialContractMissing(string name, address addr);
    error ParentNotOwned(string label, address owner, address deployer);
    error ParentCannotSetSubregistry(string label, address deployer);

    function run() external returns (HumanOSRegistrar registrar) {
        if (block.chainid != SEPOLIA_CHAIN_ID) revert WrongChain(block.chainid);
        uint256 pk = _requiredUint("DEPLOYER_PRIVATE_KEY");
        string memory parentLabel = _requiredString("HUMANOS_PARENT_LABEL");
        address deployer = vm.addr(pk);
        address owner = vm.envOr("HUMANOS_REGISTRAR_OWNER", deployer);
        registrar = deploy(loadOfficial(), pk, parentLabel, owner);
        console.log("HumanOSRegistrar", address(registrar));
        console.log("HumanOS registry", address(registrar.HUMANOS_REGISTRY()));
        console.log("owner", owner);
    }

    function loadOfficial() public view returns (Official memory o) {
        string memory json = vm.readFile(METADATA);
        require(vm.parseJsonUint(json, ".chainId") == SEPOLIA_CHAIN_ID, "metadata chain mismatch");
        o.ethRegistry = IPermissionedRegistry(_official(json, "ETHRegistry"));
        o.factory = _official(json, "VerifiableFactory");
        o.userRegistryImpl = _official(json, "UserRegistryImpl");
        o.resolverImpl = _official(json, "PermissionedResolverImpl");
    }

    /// @dev Validation and deployment, separated from env handling so it can be tested locally.
    function deploy(Official memory o, uint256 pk, string memory parentLabel, address owner)
        public
        returns (HumanOSRegistrar registrar)
    {
        address deployer = vm.addr(pk);
        uint256 parentId = uint256(keccak256(bytes(parentLabel)));
        address parentOwner = o.ethRegistry.getOwner(parentId);
        if (parentOwner != deployer) revert ParentNotOwned(parentLabel, parentOwner, deployer);
        if (!o.ethRegistry.hasRoles(parentId, RegistryRolesLib.ROLE_SET_SUBREGISTRY, deployer)) {
            revert ParentCannotSetSubregistry(parentLabel, deployer);
        }

        vm.startBroadcast(pk);
        registrar = new HumanOSRegistrar(
            HumanOSRegistrar.Config({
                factory: o.factory,
                userRegistryImplementation: o.userRegistryImpl,
                resolverImplementation: o.resolverImpl,
                parentRegistry: o.ethRegistry,
                parentLabel: parentLabel,
                parentSuffix: NameCoder.encode("eth")
            }),
            owner
        );
        IStandardRegistry(address(o.ethRegistry)).setSubregistry(parentId, registrar.HUMANOS_REGISTRY());
        vm.stopBroadcast();
    }

    function _official(string memory json, string memory name) internal view returns (address addr) {
        addr = vm.parseJsonAddress(json, string.concat(".contracts.", name, ".address"));
        if (addr.code.length == 0) revert OfficialContractMissing(name, addr);
    }

    function _requiredString(string memory name) internal view returns (string memory value) {
        value = vm.envOr(name, string(""));
        if (bytes(value).length == 0) revert MissingEnv(name);
    }

    function _requiredUint(string memory name) internal view returns (uint256) {
        return vm.parseUint(_requiredString(name));
    }
}
