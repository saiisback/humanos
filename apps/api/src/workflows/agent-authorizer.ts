import type { Database } from "@humanos/database";
import type { AgentAuthorizationDetails, WorkflowEnsPort } from "@humanos/ens";
import {
  hashCanonical,
  type Capability,
  type WalletAccount,
  type WorkflowAgentBinding,
  type WorkflowAuthorityMode,
  type WorkflowNode,
  type WorkflowRun,
  type WorkflowSchedule,
} from "@humanos/schemas";
import type { BlockRegistry } from "@humanos/workflows";
import type { StepExecutionContext } from "./types.js";

export type WorkflowAuthorizer = (
  context: StepExecutionContext,
) => Promise<boolean>;
export interface AuthorityPin {
  authorityMode: WorkflowAuthorityMode;
  agentBindingId: string | null;
}
type Queryable = Pick<Database, "query">;
interface BindingScope {
  workflowId: string;
  versionId: string;
  accountId?: string;
  rootId?: string;
  latestVersion: boolean;
}

const WRITE_EFFECTS: ReadonlySet<string> = new Set([
  "irreversible_write",
  "reversible_write",
]);
const pinOf = (value: Pick<WorkflowRun, "authorityMode" | "agentBindingId">) =>
  `${value.authorityMode ?? "account"}:${value.agentBindingId ?? ""}`;

async function hasAgentBinding(
  db: Queryable,
  workflowId: string,
): Promise<boolean> {
  return !!(
    await db.query(
      "SELECT 1 FROM workflow_agent_bindings WHERE workflow_id=$1 LIMIT 1",
      [workflowId],
    )
  ).rowCount;
}

async function requiresEns(db: Queryable, workflowId: string): Promise<boolean> {
  return !!(await db.query(
    "SELECT 1 FROM workflows WHERE id=$1 AND data->>'authorityRequirement'='ens'",
    [workflowId],
  )).rowCount;
}

/** The binding as persisted now: ACTIVE, unexpired, newest generation, owner/root/version/graph consistent. */
async function currentBinding(
  db: Queryable,
  bindingId: string,
  scope: BindingScope,
  now: Date,
): Promise<WorkflowAgentBinding | null> {
  const binding = (
    await db.query<{ data: WorkflowAgentBinding }>(
      `SELECT b.data FROM workflow_agent_bindings b
       JOIN workflows w ON w.id=b.workflow_id AND w.account_id=b.account_id AND w.data->>'rootId'=b.root_id
       JOIN workflow_versions v ON v.id=b.version_id AND v.workflow_id=b.workflow_id AND v.graph_hash=b.data->>'graphHash'
       JOIN root_bindings r ON r.root_id=b.root_id AND r.account_id=b.account_id
     WHERE b.id=$1 AND b.workflow_id=$2 AND b.version_id=$3 AND b.state='ACTIVE' AND b.expires_at>$4
       AND w.data->>'status'='ACTIVE' AND w.data->>'missionId' IS NULL AND v.data->>'activatedAt' IS NOT NULL
       AND ($5::boolean IS FALSE OR w.data->>'latestVersionId'=b.version_id)
       AND NOT EXISTS (SELECT 1 FROM workflow_agent_bindings n WHERE n.workflow_id=b.workflow_id AND n.generation>b.generation)`,
      [bindingId, scope.workflowId, scope.versionId, now, scope.latestVersion],
    )
  ).rows[0]?.data;
  if (
    !binding ||
    binding.state !== "ACTIVE" ||
    Date.parse(binding.expiresAt) <= now.getTime() ||
    !binding.ensName ||
    !binding.node ||
    !binding.agentAddress ||
    (scope.accountId !== undefined && binding.accountId !== scope.accountId) ||
    (scope.rootId !== undefined && binding.rootId !== scope.rootId)
  )
    return null;
  return binding;
}

/** New runs/schedules pin authority at creation; once any agent exists only its current generation qualifies. */
export async function resolveAuthorityPin(
  db: Queryable,
  workflowId: string,
  versionId: string,
  now: Date,
): Promise<AuthorityPin> {
  const latest = (
    await db.query<{ id: string }>(
      "SELECT id FROM workflow_agent_bindings WHERE workflow_id=$1 ORDER BY generation DESC LIMIT 1",
      [workflowId],
    )
  ).rows[0];
  if (!latest) {
    if (await requiresEns(db, workflowId)) throw new Error("ENS_AGENT_REQUIRED");
    return { authorityMode: "account", agentBindingId: null };
  }
  const binding = await currentBinding(
    db,
    latest.id,
    { workflowId, versionId, latestVersion: true },
    now,
  );
  if (!binding) throw new Error("ENS_AGENT_REQUIRED");
  return { authorityMode: "ens", agentBindingId: binding.id };
}

/** Account/legacy schedules stop once a workflow is upgraded; ENS schedules stop when their exact binding is no longer current. */
export async function scheduleAuthorityCurrent(
  db: Queryable,
  schedule: WorkflowSchedule,
  now: Date,
  ens?: WorkflowEnsPort | null,
): Promise<boolean> {
  if (schedule.authorityMode !== "ens")
    return !(await requiresEns(db, schedule.workflowId)) && !(await hasAgentBinding(db, schedule.workflowId));
  if (!schedule.agentBindingId) return false;
  const scope = {
    workflowId: schedule.workflowId,
    versionId: schedule.workflowVersionId,
    latestVersion: true,
  };
  const binding = await currentBinding(db, schedule.agentBindingId, scope, now);
  if (!binding) return false;
  if (ens === undefined) return true; // Explicit local-only callers; production scheduler supplies its port.
  if (!ens) return false;
  try {
    const account = (
      await db.query<{ data: WalletAccount }>(
        "SELECT data FROM accounts WHERE id=$1",
        [binding.accountId],
      )
    ).rows[0]?.data;
    if (!account) return false;
    const [details, owned] = await Promise.all([
      ens.readAuthorizationDetails(binding.ensName!),
      ens.checkRootOwner(binding.rootId, account.address),
    ]);
    if (
      !owned ||
      !liveAuthorityMatches(details, binding, null, now) ||
      !binding.capabilities.every((cap) =>
        details.authorization.capabilities.includes(cap),
      )
    )
      return false;
    return (
      (await currentBinding(db, binding.id, scope, now))?.revision ===
      binding.revision
    );
  } catch {
    // Pause without marking the binding revoked: an RPC outage is not proof of revocation.
    return false;
  }
}

/** Mirrors activation scope: content maps to drafts.write and unscoped writes are never delegated. */
export function agentCapabilityFor(
  registry: BlockRegistry,
  capabilityForNode?: (node: WorkflowNode) => Capability | null,
) {
  return (node: WorkflowNode): Capability | null => {
    if (node.type.startsWith("content.")) return "drafts.write";
    const block = registry.get(node.type);
    const capability = capabilityForNode?.(node) ?? block.capability;
    if (!capability && WRITE_EFFECTS.has(block.effect))
      throw new Error("ENS_SCOPE_UNAVAILABLE");
    return capability;
  };
}

/** Session/lease checks run before the agent check and again after its awaited RPC. */
export function composeWorkflowAuthorizers(
  base: WorkflowAuthorizer,
  agent: WorkflowAuthorizer,
): WorkflowAuthorizer {
  return async (context) =>
    (await base(context)) && (await agent(context)) && (await base(context));
}

function liveAuthorityMatches(
  details: AgentAuthorizationDetails,
  binding: WorkflowAgentBinding,
  capability: Capability | null,
  now: Date,
): boolean {
  const auth = details.authorization,
    agent = binding.agentAddress!.toLowerCase();
  // The reader already intersects finalized/latest scope; controllers must match in both snapshots too.
  return (
    auth.finalized &&
    auth.active &&
    !auth.revoked &&
    details.failures.length === 0 &&
    auth.agentEns === binding.ensName &&
    auth.rootId === binding.rootId &&
    details.node.toLowerCase() === binding.node!.toLowerCase() &&
    details.account.toLowerCase() === agent &&
    [details.finalizedSnapshot, details.latestSnapshot].every(
      (snapshot) =>
        snapshot.exists &&
        snapshot.active &&
        !snapshot.revoked &&
        snapshot.account.toLowerCase() === agent &&
        snapshot.rootId === binding.rootId,
    ) &&
    Date.parse(auth.expiresAt) > now.getTime() &&
    (!capability || auth.capabilities.includes(capability))
  );
}

export interface WorkflowAgentAuthorizerDependencies {
  db: Database;
  ens: WorkflowEnsPort | null;
  capabilityFor(node: WorkflowNode): Capability | null;
  clock?: () => Date;
}
/** Live ENS authority for ENS-pinned runs; account runs pass only while the workflow has never had an agent. */
export function createWorkflowAgentAuthorizer(
  deps: WorkflowAgentAuthorizerDependencies,
): WorkflowAuthorizer {
  const { db, ens } = deps;
  const clock = deps.clock ?? (() => new Date());
  async function decide(context: StepExecutionContext): Promise<boolean> {
    const run = (
      await db.query<{ data: WorkflowRun }>(
        "SELECT data FROM workflow_runs WHERE id=$1",
        [context.run.id],
      )
    ).rows[0]?.data;
    if (
      !run ||
      run.workflowId !== context.run.workflowId ||
      run.workflowVersionId !== context.run.workflowVersionId ||
      pinOf(run) !== pinOf(context.run)
    )
      return false;
    if (run.authorityMode !== "ens")
      return !(await requiresEns(db, run.workflowId)) && !(await hasAgentBinding(db, run.workflowId));
    if (!ens || !run.agentBindingId || !context.actor.rootId) return false;
    const scope: BindingScope = {
      workflowId: run.workflowId,
      versionId: run.workflowVersionId,
      accountId: context.actor.accountId,
      rootId: context.actor.rootId,
      latestVersion: false,
    };
    const before = await currentBinding(db, run.agentBindingId, scope, clock());
    const graphHash = hashCanonical(context.version.graph);
    if (
      !before ||
      context.version.id !== before.versionId ||
      context.version.graphHash !== graphHash ||
      before.graphHash !== graphHash
    )
      return false;
    const capability = deps.capabilityFor(context.node);
    if (capability && !before.capabilities.includes(capability)) return false;
    const account = await db.get<WalletAccount>("accounts", before.accountId);
    if (!account || context.signal.aborted) return false;
    const [details, rootOwned] = await Promise.all([
      ens.readAuthorizationDetails(before.ensName!),
      ens.checkRootOwner(before.rootId, account.address),
    ]);
    if (
      !rootOwned ||
      !liveAuthorityMatches(details, before, capability, clock()) ||
      context.signal.aborted
    )
      return false;
    // A local revoke may have committed while the RPC was in flight.
    const after = await currentBinding(db, before.id, scope, clock());
    return after?.revision === before.revision && !context.signal.aborted;
  }
  return async (context) => {
    if (context.signal.aborted) return false;
    try {
      return await decide(context);
    } catch {
      return false;
    }
  };
}
