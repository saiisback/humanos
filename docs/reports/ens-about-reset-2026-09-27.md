# ENS About records and approved test namespace reset

The user explicitly approved replacing the registry beneath `test-humanos.eth` and recreating
agents with About descriptions. This invalidates authorization through the old registry; it does
not erase historical contracts, transactions, or execution receipts.

## Implementation and tests

Agent resolver initialization now writes standard ENS `description` text. Draft-only agents have
a draft-specific description. Other scopes use a generic description that refers to live capability
and expiry checks. Descriptions contain no private task inputs. Neither variant promises that ENS
guarantees truthful output. Agents still receive exactly the status and receipt setter grants.

Both new tests failed against the previous implementation because the description was empty.
After implementation, all 28 contract tests passed, including rejection of agent attempts to edit
the description. The complete main-checkout `pnpm test` suite also passed (API 315 tests).
The compiler retains an upstream payable-fallback warning.

## Sepolia deployment

- Previous registrar: `0x727c3b6bdf63719d262cca9090d9e5311bb72b51`.
- Previous registry: `0x795f86005477f76b892cde4ba0367bc333cb13ed`.
- Replacement registrar: `0xfbb257d36b4f4e14372bbb49645e2ce815a9346a`.
- Replacement registry: `0x41dd4257fac9bdffe71d6d25420c8bcdf3bdfc42`.
- Deployment: `0xa73b6e1e948805e96f208cd6d5bd6cd0ae7c8731e37f725a25bab2708f08d8b9`.
- Parent remount: `0xe8533b652143cd61de2c657e71c8b5179e55f5095fa224bdafe4bb8caf10bd66`.
- Both deployment receipts succeeded at block 11787458. The deployment was simulated before broadcast.

The local API was stopped during reset and restarted against the replacement registrar. Only the
two existing ACTIVE draft-only workflow bindings were moved to PENDING_REGISTRATION, with revision
increments and their original scopes, expiry times, names, keys and historical transaction hashes
preserved. The normal durable registration worker recreates and verifies them; no workflow action
is rerun by this migration. Their states become ACTIVE only after finalized live authorization.

## Live About evidence

At block 11787466 the official Universal Resolver found the exact welcome-agent resolver (offset 0)
at `0x8B0Ad928dD345e913525E11A43e83823c81DFb3b` for
`mdf2116e8daa8e472.rc151de4cc3d262f2.test-humanos.eth`. Reading `description` returned:

> HumanOS draft-writing agent with only drafts.write authority, subject to expiry and revocation. It cannot send emails, make reservations or spend wallet funds through HumanOS. HumanOS verifies onchain authorization before execution. ENS does not guarantee truthful content.

This confirms the live profile record, not finalized execution authority or a new completed run.
No email or restaurant reservation was submitted as part of the reset.

The second agent, `m892323097c73603a.rc151de4cc3d262f2.test-humanos.eth`, also resolved at offset 0
at block 11787471 to `0x54b74779e8b21aA7d749Eb225BD47B0DF32374F7`, returning the same draft-only
description. Both recreated bindings remain pending finality at this observation.
