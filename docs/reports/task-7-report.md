# ENSv2 implementation handoff

Claude Code authored the contracts, official dependency installer/deployment scripts, TypeScript ENS adapter, ABIs, local Anvil harness and original tests in this workspace. The lead then transferred ownership to the review/fix worker after the original local test suites passed. The CLI was interrupted after approximately47minutes/120turns; its final JSON reports interruption (`error_during_execution`), not a completed handoff or successful deployment. The implementation was preserved, independently reviewed and tested by Codex rather than relying on a missing Claude final report.

## Implemented

- `packages/contracts`: HumanOSRegistrar composes the pinned official ENSv2 UserRegistry, PermissionedResolver, Enhanced Access Control and VerifiableFactory. Root/task hierarchy, ancestor-bounded expiry, nontransferability, capability narrowing, revocation, restricted renewal and dedicated per-agent scoped text setters are covered.
- Official dependency revision: `ensdomains/contracts-v2@71a3b7339dbc55ab47667abdfe8303bac4f4c24e`; transitive contracts are installed at recorded submodule pins. Vendor source is ignored and reproducible through `pnpm --filter @humanos/contracts deps`.
- Official Sepolia metadata has source provenance and read-only code evidence. It is not a deployed HumanOS address.
- Deployment scripts validate chain, dependency code, parent ownership/roles and explicit configuration before broadcasting. A separate recorder verifies successful on-chain receipts before producing a HumanOS deployment manifest.
- `packages/ens`: typed viem configuration, canonical names/capabilities, private server-held signers, deterministic per-mission keys, register/revoke/read/scoped-record-write operations, finalized/latest snapshots and idempotent retries.
- API production wiring uses the real adapter and finalized receipt publisher; missing credentials keep the integration unavailable. No production mock adapter is selected.

## Review and evidence

The original package run passed23 TypeScript ENS tests, including real official contracts deployed on Anvil. The lead reran26 Foundry tests after formatting:26 passed,0 skipped. Root TypeScript checks, lint and production builds passed at the recorded snapshot. Additional final regression counts and commands are maintained in [verification](../verification.md), rather than freezing an obsolete count here.

The [ENS review](ens-model-review.md) identified stale-head/read-race detection, scoped EAC checks, exact retry matching and shared funding nonce serialization. Late Claude edits and the subsequent foundation worker address those findings; the [independent final review](final-review.md) owns the final verdict. A separate [contract authorization review](contracts-review.md) found no confirmed high/critical issue. This is bounded testing/review, not a formal audit.

## External blockers

No HumanOS transaction was broadcast. Required inputs: owned ENSv2 Sepolia parent, `SEPOLIA_RPC_URL`, funded `DEPLOYER_PRIVATE_KEY`, `HUMANOS_PARENT_LABEL`, and optional `HUMANOS_REGISTRAR_OWNER`. After deployment configure `ENS_REGISTRAR_ADDRESS`, owner `ENS_OPERATOR_PRIVATE_KEY`, independent `ENS_AGENT_KEY_SEED`, and sufficient agent testnet gas (`ENS_AGENT_FUNDING_WEI` or separately fund derived accounts). Only one API writer process may use a signing key.

Use [deployment instructions](../deployment.md) and [contract README](../../packages/contracts/README.md) for exact simulation/broadcast/record commands. Actual Sepolia hierarchy, role writes, finality, revocation and organizer qualification remain unverified until those credentialed journeys are completed.
