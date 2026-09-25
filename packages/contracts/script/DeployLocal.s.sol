// SPDX-License-Identifier: MIT
pragma solidity 0.8.25;

import {Script} from "forge-std/Script.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {VerifiableFactory} from "@ensdomains/verifiable-factory/VerifiableFactory.sol";
import {GatewayProvider} from "@ens/contracts/ccipRead/GatewayProvider.sol";
import {NameCoder} from "@ens/contracts/utils/NameCoder.sol";

import {IRegistry} from "@ensdomains/contracts-v2/registry/interfaces/IRegistry.sol";
import {RegistryRolesLib} from "@ensdomains/contracts-v2/registry/libraries/RegistryRolesLib.sol";
import {PermissionedRegistry} from "@ensdomains/contracts-v2/registry/PermissionedRegistry.sol";
import {UserRegistry} from "@ensdomains/contracts-v2/registry/UserRegistry.sol";
import {PermissionedResolver} from "@ensdomains/contracts-v2/resolver/PermissionedResolver.sol";
import {UniversalResolverV2} from "@ensdomains/contracts-v2/universalResolver/UniversalResolverV2.sol";
import {ContractNamer} from "@ensdomains/contracts-v2/utils/ContractNamer.sol";
import {LabelStore} from "@ensdomains/contracts-v2/utils/LabelStore.sol";

import {HumanOSRegistrar} from "../src/HumanOSRegistrar.sol";

/// @notice Local-only (anvil, chain 31337) deployment of the official ENSv2 contracts from the
///         pinned source plus HumanOSRegistrar, used by the packages/ens integration tests.
///         Refuses to run on any other chain.
contract DeployLocal is Script {
    error NotLocalChain(uint256 chainId);

    PermissionedRegistry internal rootRegistry;
    PermissionedRegistry internal ethRegistry;
    VerifiableFactory internal factory;
    UniversalResolverV2 internal universalResolver;
    HumanOSRegistrar internal registrar;

    function run() external {
        if (block.chainid != 31337) revert NotLocalChain(block.chainid);
        uint256 pk = vm.envUint("LOCAL_DEPLOYER_PRIVATE_KEY");
        vm.startBroadcast(pk);
        _deploy(vm.addr(pk), uint64(vm.envUint("LOCAL_PARENT_EXPIRY")));
        vm.stopBroadcast();
        _write(vm.envString("LOCAL_DEPLOYMENT_OUT"));
    }

    function _deploy(address deployer, uint64 parentExpiry) internal {
        ContractNamer namer = ContractNamer(
            address(
                new ERC1967Proxy(address(new ContractNamer()), abi.encodeCall(ContractNamer.initialize, (deployer)))
            )
        );
        factory = new VerifiableFactory();
        LabelStore labelStore = new LabelStore(namer);
        uint256 rootRoles =
            RegistryRolesLib.ROLE_REGISTRAR | RegistryRolesLib.ROLE_RENEW | RegistryRolesLib.ROLE_SET_PARENT;
        rootRegistry = new PermissionedRegistry(labelStore, deployer, rootRoles);
        ethRegistry = new PermissionedRegistry(labelStore, deployer, rootRoles);
        rootRegistry.register(
            "eth",
            deployer,
            ethRegistry,
            address(0),
            RegistryRolesLib.ROLE_SET_SUBREGISTRY | RegistryRolesLib.ROLE_SET_RESOLVER,
            type(uint64).max
        );
        ethRegistry.setParent(rootRegistry, "eth");
        // Same role bitmap the official ETH Registrar grants registrants.
        ethRegistry.register(
            "humanos",
            deployer,
            IRegistry(address(0)),
            address(0),
            RegistryRolesLib.ROLE_SET_SUBREGISTRY | RegistryRolesLib.ROLE_SET_SUBREGISTRY_ADMIN
                | RegistryRolesLib.ROLE_SET_RESOLVER | RegistryRolesLib.ROLE_SET_RESOLVER_ADMIN
                | RegistryRolesLib.ROLE_CAN_TRANSFER_ADMIN,
            parentExpiry
        );
        universalResolver = new UniversalResolverV2(rootRegistry, new GatewayProvider(deployer, new string[](0)), namer);
        registrar = new HumanOSRegistrar(
            HumanOSRegistrar.Config({
                factory: address(factory),
                userRegistryImplementation: address(new UserRegistry(labelStore, address(namer))),
                resolverImplementation: address(new PermissionedResolver(address(namer))),
                parentRegistry: ethRegistry,
                parentLabel: "humanos",
                parentSuffix: NameCoder.encode("eth")
            }),
            deployer
        );
        ethRegistry.setSubregistry(uint256(keccak256("humanos")), registrar.HUMANOS_REGISTRY());
    }

    function _write(string memory out) internal {
        string memory o = "local";
        vm.serializeUint(o, "chainId", block.chainid);
        vm.serializeAddress(o, "rootRegistry", address(rootRegistry));
        vm.serializeAddress(o, "ethRegistry", address(ethRegistry));
        vm.serializeAddress(o, "verifiableFactory", address(factory));
        vm.serializeAddress(o, "universalResolver", address(universalResolver));
        vm.serializeAddress(o, "humanosRegistry", address(registrar.HUMANOS_REGISTRY()));
        vm.writeJson(vm.serializeAddress(o, "registrar", address(registrar)), out);
    }
}
