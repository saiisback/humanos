# Final contract authorization review

**Verdict: no confirmed high or critical finding.** No supported outsider/agent privilege escalation, revocation bypass, expired-agent revival or deployment-owner takeover sequence was established in this bounded source review.

Scope: `packages/contracts/src/HumanOSRegistrar.sol`, `packages/contracts/script/Deploy.s.sol`, their local official ENSv2/factory/access-control dependencies, Foundry remappings and the pinned Sepolia deployment metadata. This was read-only except for this report. No suites, deployment or live chain mutation were run. The reported 26 passing Foundry tests are parent-provided evidence, not a new run by this reviewer.

## Authorization and composition checked

- Registrar mutations are `onlyOwner` under OpenZeppelin Ownable2Step. Human/agent account addresses receive registry tokens without administrative role bitmaps; they do not inherit registrar ownership. Human uniqueness and mission consent remain backend responsibilities; this contract does not independently verify World proofs.
- Child registries retain only registrar/renew/unregister privileges for the registrar. Temporary canonical-parent privileges are revoked after mounting. No upgrade, resolver replacement, subregistry replacement or transfer authority is granted to task agents.
- Each agent has a separate official PermissionedResolver. Its only granted setters are the argument-scoped `humanos.status` and `humanos.receipt` text keys. Official `grantSetterRoles` checks the relevant admin permission, and resource derivation is `keccak256(bytes(key))`, matching the resource used during revocation. Agent accounts receive neither text-admin nor upgrade/link permissions.
- Factory proxy salts are namespaced by `msg.sender` in the official VerifiableFactory. Another factory caller cannot preempt this registrar's salt namespace merely by choosing the same supplied salt. Registry/resolver initialization occurs as part of deployment.

## Expiry, narrowing and revocation checked

- Root and agent registrations require nonzero accounts, normalized closed-label syntax and future expiries bounded by their containing registry expiry. Capability bits are limited to the closed 14-bit set.
- Capability narrowing rejects any newly added bit. Resolver status text is not the authority source: authorization uses registrar storage, live expiries, canonical hierarchy pointers, resolver address and live agent owner.
- Effective authorization expiry is the minimum of agent/root/parent expiries; any expired ancestor or detached hierarchy deactivates the agent. Agent and root renewal refuse expired/revoked identities rather than using the official registry's more permissive revival path.
- Revocation marks storage before external calls, removes both agent text-key grants and unregisters live names; expired names still lose resolver grants. Root revocation applies this to the bounded set of descendant agents. Used labels/root identifiers are not recycled by this controller.

## Deployment boundary checked

The standard `run()` path requires Sepolia, the configured deployer key and parent label, metadata chain agreement and code at every required dependency address. `deploy()` verifies current parent ownership and `ROLE_SET_SUBREGISTRY` before broadcasting construction and mounting. Registrar ownership is explicitly initialized to the configured owner, rather than left with the script/factory. The public `deploy()` helper intentionally supports tests and does not repeat every `run()` environment check; this is a local script entrypoint assumption, not an established deployed authorization bypass.

Trust remains in the operator-controlled parent and owner configuration and in the pinned official implementations. Parent owners can detach their subregistry; the authorization view then fails closed. `loadOfficial()` checks code presence, while the deployment metadata documents separate bytecode/pointer verification; this review did not independently repeat live bytecode verification. No live deployment or event-qualification claim follows from this report.
