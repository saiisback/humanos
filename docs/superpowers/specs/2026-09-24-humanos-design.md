# HumanOS MVP Design

## Product

HumanOS is a human-owned operating system for AI agents. A person proves uniqueness once, establishes a root identity, and creates temporary task agents that can complete day-to-day digital work within explicit, expiring, revocable authority.

The hackathon MVP proves the general architecture through one complete life-administration mission: prepare and submit an ETHGlobal Tokyo participant/travel application, then create a calendar event. The final submission is a sensitive action requiring fresh human verification.

## Trust model

- IDKit Proof of Human establishes one HumanOS root for one unique human.
- World ID for Agents provides fresh approval bound to an exact sensitive action digest.
- ENSv2 on Sepolia provides hierarchical agent identities, expiry, Permissioned Resolver records, and Enhanced Access Control roles.
- Flue provides durable conversation and task execution.
- DeepSeek V4.1 Flash (`deepseek-flash`) provides conversation, drafting, extraction, and plan proposals.
- Jev provides typed Choice, Noul, and Score assessments for routing, mission alignment, injection signals, and review recommendations.
- Deterministic TypeScript policy code is the sole authorization authority. Models never grant capabilities or execute side effects directly.

## Control flow

1. DeepSeek proposes a schema-valid mission or action.
2. Jev evaluates the normalized state with a versioned question set.
3. The policy engine applies fixed rules and calibrated thresholds.
4. The capability gateway intersects mission allowlists, human-approved capabilities, ENS roles, lifecycle state, and expiry.
5. Sensitive actions require a single-use World approval bound to the canonical action hash.
6. The executor rechecks all state immediately before an idempotent side effect.

## Risk levels

- `ROUTINE`: read approved inputs, summarize, draft, search, build checklists.
- `CONSEQUENTIAL`: create a calendar event, send a development email, upload approved data, save a form.
- `SENSITIVE`: submit an application, disclose protected documents, transfer value, sign, recover accounts, or change permissions.

## Demonstration

The judge creates a HumanOS root, starts an application mission, reviews the generated mandate, creates an ENSv2 task-agent subname, watches the Flue agent prepare the application, and completes fresh World approval before final submission. A second run demonstrates cancellation or expiry, and a third demonstrates ENS revocation blocking the same action. Restarting the agent runtime must preserve the task.

## Security invariants

- Client responses are never authorization.
- Every World result is verified by the backend.
- Every protected action uses a canonical digest, nonce, expiry, and single-use approval.
- Every consequential or sensitive action is idempotent.
- Unknown capabilities, states, Jev outputs, and model outputs fail closed.
- Jev can only narrow or escalate; it cannot broaden authority.
- Current ENS state is checked before sensitive execution.
- Flue conversation IDs are never treated as identity or ownership.
- Secrets remain server-side and logs redact sensitive material.

## Deployment

Use a pnpm TypeScript monorepo. Deploy the web UI and API publicly, run Flue on a supported Node or Cloudflare target, persist durable data in Postgres, and deploy ENSv2 integration contracts to Sepolia. All qualification-critical integrations must be real; the application submission endpoint may be owned by this repository but must persist data and enforce authorization.
