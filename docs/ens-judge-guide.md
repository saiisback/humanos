# ENS in HumanOS: identity, limited authority, and accountable execution

Judge-facing technical brief · September 26, 2026

## The short answer

HumanOS turns a request into a reusable workflow. ENSv2 gives an enabled workflow agent a resolvable identity, links it to a human-owned namespace, and provides narrowly scoped control over its identity records. HumanOS then checks that identity and its application-defined permissions before allowing work.

**The agent's name is not the feature by itself. The feature is a named, time-limited delegation that the execution system actually checks.**

This applies to off-chain work—research, drafting, or sending email—as well as blockchain actions. The work does not need to become a blockchain transaction merely because the worker has an ENS identity.

**Current evidence boundary (updated September 27):** registration, authorization, receipt publication and revocation have recorded local-chain integration coverage. A real Sepolia registration transaction for the new default-start flow succeeded (see the [live test record](reports/default-ens-2026-09-27.md)); at the recorded observation its authority was still awaiting finality. The complete live registration → execution → revocation journey and a restaurant booking through HumanOS have not been demonstrated. Do not present those as completed features.

**Current default:** newly created non-legacy tasks require ENS authority. Their ordinary task-start review includes the minimum scope, expiry, backend custody and operator-funded testnet gas. Starting registers and checks the agent before execution; there is no separate optional enable-agent visit. Existing account-only workflows are preserved rather than silently migrated.

## 1. Why use ENS? Could this just be a normal web app?

Yes. A database can store agent IDs, permission lists, expiry dates and execution logs. A single-company automation app does not inherently need ENS. HumanOS already supports explicitly labeled account-owned workflows without an ENS binding.

The reason to add ENS is to make the identity and selected authority evidence independently inspectable through a shared naming system, rather than meaningful only inside our database.

| Ordinary application-only design | What ENSv2 adds to HumanOS |
|---|---|
| Agent ID is an internal database key | A resolvable name with a controller address and records |
| Human–agent relationship exists only in our application | A hierarchical namespace plus application records describing that relationship |
| Only our API can explain the identity's state | Other software can resolve the name and inspect chain state |
| Permission record edits are controlled only by our backend | ENSv2 resolver roles restrict which identity records an agent key can edit |
| Audit evidence lives only in our database | Receipt hashes can be published through the agent's scoped resolver permissions |

These advantages have costs: gas, finality latency, RPC availability, contract complexity and public metadata. ENS is justified when shared, inspectable agent identity matters—not because every web feature becomes better onchain.

Portability is a capability of the design, not a claim of existing partner integration. Another application must understand HumanOS's capability schema and enforce it. A restaurant or email provider does not automatically recognize an ENS name as authorization.

## 2. Keep the layers separate

| Layer | Question it answers | What it does not do |
|---|---|---|
| JAW account/session | Which account is using HumanOS? | Establish unique personhood or book a table |
| World ID/root binding | What verified-person assurance does this account have in this environment? | Grant arbitrary connector access; staging is not production assurance |
| ENSv2 identity | Which named agent belongs under this namespace, and who controls its records? | Run an AI model or operate a website |
| HumanOS authorization | Is this agent allowed to execute this exact workflow version and step? | Supply missing provider credentials or integrations |
| Connector/browser adapter | How is the allowed action performed against the service? | Grant itself more authority |
| Final action confirmation | Did the user approve this particular external effect? | Approve every unknown future destination or payload |

ENS does not verify World ID proofs itself in this integration. The application verifies and binds the human root; the registrar records that relationship under operator control.

## 3. Core ENSv2 concepts we use

**Name and address:** the name identifies an agent; resolution points to its Ethereum controller address. The process doing the work remains an ordinary server-side worker. It does not have to be a smart contract.

**Hierarchical registries:** a parent namespace can point to a child registry with its own subname-management rules. HumanOS uses this to group agent names beneath a human root, itself beneath the configured project parent. This is more than setting a decorative `.eth` display label. See the official [Permissioned Registry documentation](https://docs.ens.domains/ensv2/permissioned-registry).

**Permissioned Resolver:** stores address and text records and controls who may update them. HumanOS deploys a separate resolver for each agent and grants that agent only two text-record setters. Resolver argument-scoped permissions are per resolver instance, not per name; separate instances are important for isolation. See [Permissioned Resolver](https://docs.ens.domains/ensv2/permissioned-resolver/).

**Enhanced Access Control (EAC):** role-based contract permissions, with separate administration rights and resource-specific grants. Having a setter permission is different from being allowed to grant permissions to others. See [Enhanced Access Control](https://docs.ens.domains/ensv2/enhanced-access-control/).

**Expiry and revocation:** authority is deliberately temporary. HumanOS checks name/hierarchy validity and its own binding state; revocation removes the agent's scoped resolver grants and disables subsequent authorized work. It does not undo an email already sent or a reservation already submitted.

## 4. How an agent gets its name

The current workflow integration creates an identity for a **workflow generation**, not automatically for every model call or individual step.

```text
test-humanos.eth                 configured project parent
└── r<root-hash>.test-humanos.eth human-root namespace
    └── m<agent-hash>.r<root-hash>.test-humanos.eth
                                workflow-generation agent
```

The placeholders above are illustrative, not real registered names.

In the current implementation:

1. The application identifies the account and its bound human root.
2. It forms a derivation ID: `workflow:<workflowId>:<generation>`.
3. The root label is `r` plus the first 16 hexadecimal characters of the root ID's Keccak hash. The agent label is `m` plus the equivalent hash prefix of the derivation ID.
4. A backend-held secret seed deterministically derives a separate signing key for that derivation ID. **The name itself does not derive or reveal the key.**
5. After the user reviews the delegation and starts the task, the operator registers the root if needed and then the agent subname. The agent address becomes its resolved controller address.
6. Registration stays pending until live authorization checks establish the expected identity and authority.

Users do not need to buy a new top-level `.eth` name for each workflow agent. These are subnames under the project's configured parent, subject to its rules, expiry and transaction costs. A generated label or a UI preview is not proof that registration happened.

Source: [name derivation](../packages/ens/src/adapter.ts), [workflow identity and registration](../packages/ens/src/workflow-agent.ts), [key derivation and transaction writing](../packages/ens/src/register.ts).

## 5. Exactly how permissions are assigned

There are **two different permission systems**. Conflating them would overstate what ENS provides.

### A. HumanOS capabilities: what work may happen

The backend derives required capabilities from the actual typed workflow blocks and server-owned connector definitions. It does not trust an AI-written permission list. For example, content generation maps to `drafts.write`, research uses `web.search`, and an email connector can require `email.send`.

These capability names are **HumanOS's vocabulary, not native ENS roles**. The registrar stores a closed capability bitmap, mirrors it in `humanos.capabilities`, and exposes authorization state. Merely having a capability in the schema does not mean its connector is implemented.

The application creates a review containing the account, root, workflow version, graph hash, capability set and expiry. The current default delegation request is 24 hours, bounded by parent/root expiry; the review itself lasts five minutes. Consent is tied to the review hash. A changed workflow or stale review cannot silently reuse that consent.

The database binding retains the exact workflow/version/graph and generation. **The complete workflow graph is not stored or enforced by ENS contracts.** HumanOS enforces that binding in its runtime.

Source: [review and enable service](../apps/api/src/workflows/agents.ts), [capability schema](../packages/schemas/src/domain.ts), [capability encoding](../packages/ens/src/roles.ts).

### B. ENSv2 EAC grants: which identity records the key may edit

For each agent resolver, the registrar grants argument-scoped setters for:

- `humanos.status`
- `humanos.receipt`

It does not grant the agent unrestricted text editing, capability editing, address changes, registry administration, or wallet-spending authority. The registrar writes the root/capability/address records. The agent cannot increase its own capability set by editing them.

The custom registrar's administration is operator-controlled (`onlyOwner`). Application-level owner consent is enforced by HumanOS before those operator transactions; the contract does not independently receive an end-user signature for every enable operation. This is **backend-managed delegation**, not a fully non-custodial permission system.

Source: [`registerAgent`, `_deployAgentResolver`, and `_revokeAgent`](../packages/contracts/src/HumanOSRegistrar.sol).

## 6. How permissions affect real execution

```text
Reviewed workflow + owner enablement
              ↓
Register agent → verify chain state → activate binding
              ↓
Run pins exact binding and generation
              ↓
Check account/root, version/hash, scope, expiry and live ENS authority
              ↓
Execute supported step; require exact confirmation for an external effect
              ↓
Persist provider evidence → independently publish receipt hash
```

The runtime checks both database bindings and live ENS evidence: expected controller, root ownership, valid hierarchy, active state, capability and expiry. The chain reader intersects finalized and latest state: new authority must be finalized, while observed narrowing or revocation at the latest head can deny access. RPC uncertainty fails closed; it is not treated as permission.

An ENS-enabled workflow cannot silently fall back to account-only execution if its agent expires or is revoked. Runs and schedules retain their authority pins. Replacement requires explicit review; historical runs do not inherit a new generation automatically.

There is no atomic transaction spanning an Ethereum authorization read and a third-party email or booking request. Rechecking near dispatch reduces the window, but cannot eliminate it. Idempotency and outcome reconciliation are also required.

Source: [runtime authorizer](../apps/api/src/workflows/agent-authorizer.ts), [chain authorization reader](../packages/ens/src/authorize.ts), [receipt publication](../apps/api/src/workflows/agent-receipts.ts).

## 7. Non-blockchain agents and subagents

An email worker can operate entirely offchain while acting under an ENS-backed workflow binding. It still needs the email service credentials and HumanOS's enforcement. ENS is its identity/authority reference, not the email transport.

Today, multiple steps can share one workflow-generation agent identity. **Do not claim that every Jev call, DeepSeek call, or spawned subagent already has a separate ENS name.** Separately named child workers, independently scoped child delegations and cross-application adoption are future extensions, not completed functionality.

## 8. Receipts, privacy and trust

HumanOS persists execution evidence offchain and can publish its canonical hash in `humanos.receipt` using the agent's narrow resolver permission. Publication retries do not rerun the external action.

A matching hash proves consistency with a committed receipt; it does **not** prove the receipt was truthful, that an email was delivered, or that a restaurant accepted a booking. Those claims require provider evidence. The resolver record is a pointer to the currently published hash, not by itself a complete history of every workflow event.

Email bodies, booking contact details and API secrets should not be placed in resolver text records. Addresses, relationships, root metadata, scope and transaction activity are public. Opaque names and receipt hashes are not a guarantee of anonymity; predictable material may be guessable and identities may be linkable.

The operator holds the registrar authority and agent-key seed today. ENS's restricted agent-key grants reduce what one worker key can do, but do not remove trust in the operator, hosted runtime, or provider credentials.

Roles are granted to addresses, not to the spelling of a name. Ancestor registry control and retained administrative rights also matter; a subname must not be described as permanently independent of its parent. The ENSv2 interfaces are still provisional, so the repository's pinned contracts and actual deployment must be checked against documentation updates. See the [primary-source notes and documentation caveats](reports/ensv2-primary-source-notes.md).

## 9. What the judge should see

Use a supported, read-only workflow first. A suggested acceptance demo—not a claim that these live steps are already completed—is:

1. Show an executable research/draft workflow and its exact version.
2. Show the minimum capability set, custody, gas implications and expiry in the task-start review.
3. Start the task and show actual Sepolia registration transaction evidence; wait for finalized authority before execution.
4. Resolve its name and inspect the controller, parent/root and scoped resolver grants.
5. Run through HumanOS; show persisted output and the pinned agent identity.
6. Publish the receipt hash and compare it with the saved receipt.
7. Revoke the agent; demonstrate that the next run is denied rather than downgraded.

For a restaurant demo, the booking adapter must first exist and preserve the reviewed reservation terms through final submission. ENS registration cannot fix a missing TableCheck adapter. A manual Codex browser action is not proof that HumanOS executed it.

Recorded local-chain evidence and limitations: [workflow ENS integration report](reports/workflow-ens-integration.md), [actual local-chain test](../packages/ens/test/workflow-agent-chain.test.ts), [adapter implementation notes](../packages/ens/README.md). Those reports describe their own test batches; this document is a code/documentation review, not a fresh execution of those suites.

## 10. Judge Q&A

**“Is this just an ENS username?”** No: enabled workflow execution checks the agent's identity, authority and expiry, and resolver permissions restrict record writes. The strongest proof is a revoked agent being unable to continue.

**“Could you build this without a blockchain?”** Yes. The added value is a shared, resolvable, independently inspectable identity and selected authority evidence. For a closed single-app system, a database may be simpler and cheaper.

**“Does ENS enforce sending an email?”** No. ENSv2 enforces its contract-level roles; HumanOS interprets the recorded application capabilities and gates its email connector. The provider authenticates using its own credentials.

**“Who names and controls the agents?”** HumanOS derives stable labels and distinct keys per workflow generation. The backend operator submits registration after application-level user consent. The current implementation is custodial, and that limitation is explicit.

**“Does ENS lower AI credit usage?”** Not directly. Typed reusable blocks, deterministic execution and selective model calls are the cost-reduction design. ENS adds identity/governance costs. We must measure comparable workloads before claiming any percentage saving.

**“Which ENSv2 features are central?”** Hierarchical child registries, dedicated Permissioned Resolvers, argument-scoped EAC setters, expiry-aware resolution and revocation-sensitive authorization. We do not claim wildcard resolution or aliasing merely because ENSv2 supports them.

## 11. A 45-second pitch

> HumanOS helps people delegate repeatable work without handing an AI unlimited access. We use ENSv2 to give an enabled workflow agent a real, resolvable identity beneath a human-root namespace. The backend derives the minimum permissions from the workflow, the user reviews that delegation, and our runtime checks its version, scope, expiry and live ENS state before work. Each agent has its own Permissioned Resolver and can update only its status and receipt hash—not expand its permissions. This applies to ordinary off-chain agents too. A database could handle internal access control; ENS adds shared identity and independently inspectable evidence. Our local-chain lifecycle is tested; live Sepolia end-to-end acceptance remains the next proof point.
