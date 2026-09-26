# ENSv2 primary-source notes

Verified against official ENS documentation on 2026-09-26. These pages explicitly describe interfaces that remain subject to change before mainnet deployment. This document assesses protocol semantics, not this application's deployed integration.

## Identity and authority are different things

An ENS name identifies an entry; an Ethereum account address receives a role; a resource identifies the scope; a role identifies an operation. EAC grants bind an account, resource, and role bitmap. A resolved address record is therefore not, by itself, a grant of authority. EAC supports 32 operational and 32 administrative roles, with up to 15 accounts per role per resource. Root grants apply throughout the particular contract. Admin roles authorize grants/revocations; reversibility depends on retained admin authority. [Enhanced Access Control](https://docs.ens.domains/ensv2/enhanced-access-control/)

Application inference: a text record containing a policy, agent capability, email address, or API endpoint is data. ENS does not automatically enforce that policy against an email service, third-party API, filesystem, or arbitrary offchain action. Such enforcement must be implemented by the consuming application, including authentication and fresh permission checks. Do not describe registry/resolver record-write authority as general execution authority.

## Registry hierarchy and registry roles

A full name is a chain of label entries across registries. A name entry may point to a resolver and a child registry. Resolution walks the hierarchy and uses the deepest matching resolver. A registry can have multiple namespace aliases; holding a token does not alone prove canonical attachment to the root. Replacing an ancestor's subregistry can detach an entire subtree from resolution without deleting its underlying contracts. Custom `IRegistry` implementations need not use EAC at all. [Registry Hierarchy](https://docs.ens.domains/ensv2/registry-hierarchy/)

The standard Permissioned Registry gives each registered entry one ERC1155Singleton owner. Roles cover operations such as registering, renewing, unregistering, changing resolver, and changing subregistry. Some operate only at root; others support a name resource or root. Name resources incorporate a registration version. Re-registration invalidates previous grants, whereas renewing an expired entry can restore its previous owner and roles. Name-scoped admin roles can be assigned at registration and revoked later, but cannot be newly granted after registration. Transfers move the owner's roles; grants to other addresses remain. `setApprovalForAll` delegates the owner's full authority across their names. Registry role changes regenerate token IDs, invalidating approvals tied to old IDs. [Permissioned Registry](https://docs.ens.domains/ensv2/permissioned-registry/)

## Resolver isolation and revocation

The Permissioned Resolver has **no per-name role scope**. A grant for a text key, coin type, ABI type, or interface ID covers that argument across every name served by the instance. Names requiring separate authorization need separate resolver instances. Resources derive from the setter argument alone; `grantSetterRoles` ignores the encoded name and value. Generic `grantRoles` is disabled. Root grants cover the entire resolver. Linked names share record bundles, so a write can change several names' results. [Permissioned Resolver](https://docs.ens.domains/ensv2/permissioned-resolver/)

Revocation must remove the effective grant: removing argument-level permission leaves any root-level grant effective. Retained admin authority can restore a revoked operational role. Revoking a setter alone does not freeze resolution: link and upgrade authority can change results. A complete permanent lock must eliminate relevant roles and admins from every holder; registry-level authority to replace a resolver remains a separate concern. [Permissioned Resolver](https://docs.ens.domains/ensv2/permissioned-resolver/)

Implementation inference: revoking ENS authority cannot undo completed external actions or erase previously disclosed data. A gateway that caches authority, issues independent credentials, or permits long-lived sessions needs its own invalidation mechanism and a stated revocation latency.

## Documentation inconsistency to avoid repeating

The generic EAC page says resolver resources derive from namehash and record type. The detailed resolver page explicitly says names do not participate and grants span all names in an instance. Use the detailed resolver semantics above, and verify deployed contract behavior before claiming name-level resolver isolation. [EAC overview](https://docs.ens.domains/ensv2/enhanced-access-control/) · [Resolver resource scheme](https://docs.ens.domains/ensv2/permissioned-resolver/#resource-scheme)
