# Linear permission: Sepolia upgrade preparation

Status: prepared locally; not deployed or activated.

## Change

Append `linear.issue.create` at bit 14 (`0x4000`). Preserve every existing capability at bits 0–13. The new registrar accepts mask `0x7fff`; the previous implementation accepts `0x3fff`. This is a HumanOS application capability recorded in ENS, not a new ENS protocol role or a wallet-spending permission. The connector still checks the authenticated account, selected Linear team, exact confirmation, expiry and live agent authority before dispatch.

## Recorded current deployment

The repository deployment record identifies Sepolia registrar `0xfbb257d36b4f4e14372bbb49645e2ce815a9346a` and registry `0x41dd4257fac9bdffe71d6d25420c8bcdf3bdfc42`. Re-read live chain state before broadcasting; these addresses are a deployment record, not a fresh chain observation.

## Namespace impact — do not silently switch

`script/Deploy.s.sol` currently combines deployment with `setSubregistry` on the parent name. **Do not broadcast this script for a prepare-only request.** Mounting its new registry under `test-humanos.eth` would detach the existing root/agent hierarchy from canonical resolution. Existing bindings must not be reused as though migrated. Existing contracts and historical receipts would remain onchain, but old agents would fail canonical hierarchy authorization.

Safe staging requires a deploy-only transaction with no `setSubregistry` call and no application configuration changes. An unmounted candidate must not be treated as an active identity provider. Before any later switch: inventory affected bindings and in-flight work, show the impact to the user, obtain explicit switch approval, pause affected work, mount the candidate, update configuration together, and explicitly re-register/rebind selected agents. Never replay pending external writes during migration.

An alternative is a separately owned test parent namespace, leaving the existing parent untouched; that requires an available parent name and an explicit namespace choice.

## Verification

- Contract regression covers registration with bit 14 and rejection of bit 15.
- ENS encoding regression preserves original permission ordering and checks the new bit.
- No deployment, parent mutation, agent recreation, or Linear issue creation is part of this preparation.

## Remaining gate

Implement and verify deploy-only staging before spending testnet gas. Present its resulting addresses and transaction receipt before proposing activation. Linear live execution remains blocked on an explicitly activated registrar that supports the new capability; do not reuse email permissions or bypass ENS checks.
