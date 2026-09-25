// SPDX-License-Identifier: MIT
pragma solidity 0.8.25;

import {IPermissionedRegistry} from "@ensdomains/contracts-v2/registry/interfaces/IPermissionedRegistry.sol";

import {Deploy} from "../script/Deploy.s.sol";
import {HumanOSRegistrar} from "../src/HumanOSRegistrar.sol";
import {ENSv2HierarchyFixture} from "./HumanOSRegistrar.t.sol";

contract DeployScriptTest is ENSv2HierarchyFixture {
    Deploy script;
    uint256 operatorKey = uint256(keccak256(abi.encodePacked("operator")));

    function setUp() public {
        deployHierarchy(uint64(block.timestamp) + 365 days);
        script = new Deploy();
        assertEq(vm.addr(operatorKey), operator);
    }

    function _official() internal view returns (Deploy.Official memory) {
        return Deploy.Official({
            ethRegistry: IPermissionedRegistry(address(ethRegistry)),
            factory: address(factory),
            userRegistryImpl: address(userRegistryImpl),
            resolverImpl: address(resolverImpl)
        });
    }

    /// @dev Env mutation is process-global, so every env-driven refusal lives in one test.
    function test_run_refusesWithoutProperEnvironment() external {
        vm.expectRevert(abi.encodeWithSelector(Deploy.WrongChain.selector, block.chainid));
        script.run();

        vm.chainId(11155111);
        vm.setEnv("DEPLOYER_PRIVATE_KEY", "");
        vm.expectRevert(abi.encodeWithSelector(Deploy.MissingEnv.selector, "DEPLOYER_PRIVATE_KEY"));
        script.run();

        vm.setEnv("DEPLOYER_PRIVATE_KEY", vm.toString(bytes32(operatorKey)));
        vm.setEnv("HUMANOS_PARENT_LABEL", "");
        vm.expectRevert(abi.encodeWithSelector(Deploy.MissingEnv.selector, "HUMANOS_PARENT_LABEL"));
        script.run();

        // Local chain has no official Sepolia contracts: refuse instead of deploying against nothing.
        vm.setEnv("HUMANOS_PARENT_LABEL", "humanos");
        vm.expectRevert(
            abi.encodeWithSelector(
                Deploy.OfficialContractMissing.selector, "ETHRegistry", 0x657eA849311d3D5823348ddEd7C2AaAFb3EDE09E
            )
        );
        script.run();

        vm.setEnv("DEPLOYER_PRIVATE_KEY", "");
        vm.setEnv("HUMANOS_PARENT_LABEL", "");
    }

    function test_deploy_refusesParentNotOwnedByDeployer() external {
        uint256 strangerKey = uint256(keccak256("stranger"));
        vm.expectRevert(
            abi.encodeWithSelector(Deploy.ParentNotOwned.selector, "humanos", operator, vm.addr(strangerKey))
        );
        script.deploy(_official(), strangerKey, "humanos", vm.addr(strangerKey));

        vm.expectRevert(abi.encodeWithSelector(Deploy.ParentNotOwned.selector, "unregistered", address(0), operator));
        script.deploy(_official(), operatorKey, "unregistered", operator);
    }

    function test_deploy_mountsUnderOwnedParent() external {
        HumanOSRegistrar registrar = script.deploy(_official(), operatorKey, "humanos", operator);
        assertEq(address(ethRegistry.getSubregistry("humanos")), address(registrar.HUMANOS_REGISTRY()));
        assertEq(registrar.owner(), operator);
        assertEq(registrar.parentName(), "humanos.eth");

        vm.startPrank(operator);
        bytes32 rootNode = registrar.registerRoot("alice", "root_01", operator, uint64(block.timestamp) + 30 days);
        bytes32 agentNode =
            registrar.registerAgent(rootNode, "task", makeAddr("agent"), 1, uint64(block.timestamp) + 1 days);
        vm.stopPrank();
        HumanOSRegistrar.AgentAuthorization memory a = registrar.authorization(agentNode);
        assertTrue(a.active);
        (address resolver,, uint256 offset) = universalResolver.findResolver(dns("task.alice.humanos.eth"));
        assertEq(resolver, a.resolver);
        assertEq(offset, 0);
    }
}
