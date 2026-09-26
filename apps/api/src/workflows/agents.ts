import { randomUUID } from "node:crypto";
import {
  type Database,
  type WorkflowStore,
  type WorkflowAgentStore,
} from "@humanos/database";
import {
  hashCanonical,
  type Capability,
  type WalletAccount,
  type Workflow,
  type WorkflowVersion,
  type WorkflowAgentBinding,
  type Hex,
} from "@humanos/schemas";
import { EnsAuthorizationError, type WorkflowEnsPort } from "@humanos/ens";
import { createDefaultCatalog } from "@humanos/workflows";
import type { WorkflowActor } from "./types.js";

export interface AgentReview {
  id: string;
  reviewHash: string;
  accountId: string;
  rootId: string;
  workflowId: string;
  versionId: string;
  graphHash: string;
  capabilities: Capability[];
  expiresAt: string;
  reviewExpiresAt: string;
  chainId: 11155111;
  parentName: string;
  bindingId: string | null;
  createdAt: string;
  network: "sepolia";
}
export function createWorkflowAgentService(deps: {
  db: Database;
  store: WorkflowStore;
  agentStore: WorkflowAgentStore;
  ens: WorkflowEnsPort | null;
  clock?: () => Date;
  capabilityForNode?: (
    node: WorkflowVersion["graph"]["nodes"][number],
  ) => Capability | null;
}) {
  const { db, store, agentStore, ens } = deps;
  const clock = deps.clock ?? (() => new Date());
  const catalog = createDefaultCatalog();
  async function owned(actor: WorkflowActor, id: string) {
    const workflow = await store.get<Workflow>("workflows", id);
    if (
      !workflow ||
      workflow.accountId !== actor.accountId ||
      workflow.missionId ||
      (workflow.rootId !== null && workflow.rootId !== actor.rootId)
    )
      throw new Error("NOT_FOUND");
    return workflow;
  }
  async function owner(actor: WorkflowActor) {
    const account = await db.get<WalletAccount>("accounts", actor.accountId);
    if (!account || !actor.rootId) throw new Error("HUMAN_ROOT_REQUIRED");
    const bound = await db.query(
      "SELECT id FROM root_bindings WHERE account_id=$1 AND root_id=$2",
      [actor.accountId, actor.rootId],
    );
    if (!bound.rows.length) throw new Error("HUMAN_ROOT_REQUIRED");
    return account;
  }
  async function versionFor(
    actor: WorkflowActor,
    id: string,
    versionId: string,
  ) {
    const workflow = await owned(actor, id);
    const account = await owner(actor);
    const version = await store.get<WorkflowVersion>(
      "workflow_versions",
      versionId,
    );
    if (
      workflow.status === "ARCHIVED" ||
      workflow.latestVersionId !== versionId ||
      !version ||
      version.workflowId !== id ||
      !version.graph.nodes.length ||
      (workflow.rootId && workflow.rootId !== actor.rootId)
    )
      throw new Error("GRAPH_CHANGED");
    if (version.graphHash !== hashCanonical(version.graph))
      throw new Error("GRAPH_CHANGED");
    return { workflow, version, account };
  }
  function capabilities(version: WorkflowVersion): Capability[] {
    return [
      ...new Set(
        version.graph.nodes.flatMap((node) => {
          const block = catalog.get(node.type);
          if (block.version !== node.blockVersion)
            throw new Error("GRAPH_CHANGED");
          const cap = deps.capabilityForNode?.(node) ?? block.capability;
          if (node.type.startsWith("content."))
            return ["drafts.write" as const];
          if (
            !cap &&
            ["irreversible_write", "reversible_write"].includes(block.effect)
          )
            throw new Error("ENS_SCOPE_UNAVAILABLE");
          return cap ? [cap] : [];
        }),
      ),
    ].sort();
  }
  async function bindings(actor: WorkflowActor, id: string) {
    await owned(actor, id);
    return (await agentStore.listOwned(actor.accountId))
      .filter((b) => b.workflowId === id)
      .sort((a, b) => b.generation - a.generation);
  }
  async function activate(
    binding: WorkflowAgentBinding,
  ): Promise<WorkflowAgentBinding> {
    if (!ens || binding.state !== "PENDING_REGISTRATION") return binding;
    if (Date.parse(binding.expiresAt) <= clock().getTime())
      return agentStore.transition(binding.id, binding.revision, "EXPIRED", {
        at: clock(),
      });
    const account = await db.get<WalletAccount>("accounts", binding.accountId);
    if (!account) throw new Error("NOT_FOUND");
    const actor = { accountId: binding.accountId, rootId: binding.rootId };
    await owner(actor);
    const { version } = await versionFor(
      actor,
      binding.workflowId,
      binding.versionId,
    );
    if (
      version.graphHash !== binding.graphHash ||
      hashCanonical(capabilities(version)) !==
        hashCanonical(binding.capabilities)
    )
      throw new Error("GRAPH_CHANGED");
    const registered = await ens.register({
      derivationId: binding.derivationId,
      rootId: binding.rootId,
      rootOwner: account.address,
      capabilities: binding.capabilities,
      expiresAt: binding.expiresAt,
    });
    // Persist chain identity even while finality is pending, allowing revocation/recovery.
    binding = await agentStore.transition(
      binding.id,
      binding.revision,
      "PENDING_REGISTRATION",
      { at: clock(), registration: registered },
    );
    const details = await ens.readAuthorizationDetails(registered.ensName);
    const auth = details.authorization;
    if (
      !auth.active ||
      auth.revoked ||
      !auth.finalized ||
      auth.rootId !== binding.rootId ||
      details.node !== binding.node ||
      details.account.toLowerCase() !== binding.agentAddress!.toLowerCase() ||
      details.latestSnapshot.account.toLowerCase() !==
        binding.agentAddress!.toLowerCase() ||
      details.finalizedSnapshot.account.toLowerCase() !==
        binding.agentAddress!.toLowerCase() ||
      hashCanonical([...auth.capabilities].sort()) !==
        hashCanonical(binding.capabilities) ||
      Date.parse(auth.expiresAt) < Date.parse(binding.expiresAt) ||
      !(await ens.checkRootOwner(binding.rootId, account.address))
    )
      return binding;
    await versionFor(actor, binding.workflowId, binding.versionId);
    await store.activateVersion(
      binding.workflowId,
      binding.versionId,
      binding.graphHash,
      clock(),
    );
    return agentStore.transition(binding.id, binding.revision, "ACTIVE", {
      at: clock(),
      registration: registered,
    });
  }
  async function finishRevoke(binding: WorkflowAgentBinding) {
    if (!ens || binding.state !== "REVOKING") return binding;
    // A missing registration can still have a signed/journaled transaction in flight.
    // Settle that exact consented identity, then revoke it; never release the generation early.
    const identity =
      binding.ensName && binding.node && binding.agentAddress
        ? {
            ensName: binding.ensName,
            node: binding.node as Hex,
            agentAddress: binding.agentAddress,
          }
        : await ens.identity(binding);
    let details;
    try {
      details = await ens.readAuthorizationDetails(identity.ensName);
    } catch (error) {
      if (
        !(error instanceof EnsAuthorizationError && error.code === "NOT_FOUND")
      )
        throw error;
    }
    let registration;
    if (!details || details.latestSnapshot.exists === false) {
      const account = await db.get<WalletAccount>(
        "accounts",
        binding.accountId,
      );
      if (!account) throw new Error("NOT_FOUND");
      registration = await ens.register({
        derivationId: binding.derivationId,
        rootId: binding.rootId,
        rootOwner: account.address,
        capabilities: binding.capabilities,
        expiresAt: binding.expiresAt,
      });
    } else {
      if (
        details.node !== identity.node ||
        details.latestSnapshot.account.toLowerCase() !==
          identity.agentAddress.toLowerCase()
      )
        throw new Error("ENS_IDENTITY_MISMATCH");
    }
    if (!binding.ensName || registration) {
      binding = await agentStore.transition(
        binding.id,
        binding.revision,
        "REVOKING",
        {
          at: clock(),
          registration: registration ?? { ...identity, txHashes: [] },
        },
      );
    }
    const result = await ens.revoke(binding);
    return agentStore.transition(binding.id, binding.revision, "REVOKED", {
      at: clock(),
      revocation: result,
    });
  }
  async function availableFor(binding: WorkflowAgentBinding | null) {
    if (!ens) return false;
    if (!binding || binding.state !== "ACTIVE") return true;
    try {
      const account = await db.get<WalletAccount>(
        "accounts",
        binding.accountId,
      );
      if (
        !account ||
        !binding.ensName ||
        Date.parse(binding.expiresAt) <= clock().getTime()
      )
        return false;
      const details = await ens.readAuthorizationDetails(binding.ensName);
      const auth = details.authorization;
      return (
        auth.active &&
        !auth.revoked &&
        auth.finalized &&
        auth.rootId === binding.rootId &&
        details.node === binding.node &&
        details.account.toLowerCase() === binding.agentAddress?.toLowerCase() &&
        binding.capabilities.every((cap) => auth.capabilities.includes(cap)) &&
        Date.parse(auth.expiresAt) >= Date.parse(binding.expiresAt) &&
        (await ens.checkRootOwner(binding.rootId, account.address))
      );
    } catch {
      return false;
    }
  }
  return {
    async list(actor: WorkflowActor) {
      const all = await agentStore.listOwned(actor.accountId);
      return {
        bindings: all,
        available:
          !!ens && (await Promise.all(all.map(availableFor))).every(Boolean),
      };
    },
    async detail(actor: WorkflowActor, id: string) {
      const all = await bindings(actor, id);
      const receiptPublications = (
        await db.query<{
          runId: string;
          receiptHash: string;
          state: string;
          txHashes: string[];
        }>(
          `SELECT j.run_id AS "runId",j.receipt_hash AS "receiptHash",j.state,j.tx_hashes AS "txHashes"
         FROM workflow_agent_receipt_jobs j JOIN workflow_agent_bindings b ON b.id=j.binding_id
         WHERE b.workflow_id=$1 AND b.account_id=$2 ORDER BY j.updated_at DESC,j.id LIMIT 20`,
          [id, actor.accountId],
        )
      ).rows;
      return {
        binding: all[0] ?? null,
        bindings: all,
        available: await availableFor(all[0] ?? null),
        receiptPublications,
      };
    },
    async review(actor: WorkflowActor, id: string, versionId: string) {
      if (!ens) throw new Error("ENS_UNAVAILABLE");
      const { version, account } = await versionFor(actor, id, versionId);
      const caps = capabilities(version);
      if (!caps.length) throw new Error("ENS_SCOPE_UNAVAILABLE");
      const now = clock();
      const result = await ens.review({
        rootId: actor.rootId!,
        rootOwner: account.address,
        requestedExpiry: new Date(
          Math.floor((now.getTime() + 86400000) / 1000) * 1000,
        ).toISOString(),
      });
      if (result.chainId !== 11155111) throw new Error("ENS_WRONG_CHAIN");
      const payload = {
        id: randomUUID(),
        accountId: actor.accountId,
        rootId: actor.rootId!,
        workflowId: id,
        versionId,
        graphHash: version.graphHash,
        capabilities: caps,
        expiresAt: result.effectiveExpiry,
        reviewExpiresAt: new Date(now.getTime() + 300000).toISOString(),
        chainId: 11155111 as const,
        parentName: result.parentName,
        createdAt: now.toISOString(),
        network: "sepolia" as const,
      };
      const review: AgentReview = {
        ...payload,
        reviewHash: hashCanonical(payload),
        bindingId: null,
      };
      await db.query(
        "INSERT INTO workflow_agent_reviews(id,data) VALUES($1,$2)",
        [review.id, JSON.stringify(review)],
      );
      return { review };
    },
    async enable(
      actor: WorkflowActor,
      id: string,
      reviewId: string,
      expectedReviewHash: string,
    ) {
      if (!ens) throw new Error("ENS_UNAVAILABLE");
      await owned(actor, id);
      await owner(actor);
      const review = (
        await db.query<{ data: AgentReview }>(
          "SELECT data FROM workflow_agent_reviews WHERE id=$1",
          [reviewId],
        )
      ).rows[0]?.data;
      if (
        !review ||
        review.accountId !== actor.accountId ||
        review.rootId !== actor.rootId ||
        review.workflowId !== id
      )
        throw new Error("NOT_FOUND");
      if (review.reviewHash !== expectedReviewHash)
        throw new Error("REVIEW_MISMATCH");
      if (review.bindingId) {
        const binding = await agentStore.get(review.bindingId);
        if (!binding) throw new Error("NOT_FOUND");
        return { binding };
      }
      if (Date.parse(review.reviewExpiresAt) <= clock().getTime())
        throw new Error("REVIEW_EXPIRED");
      const { version } = await versionFor(actor, id, review.versionId);
      if (
        version.graphHash !== review.graphHash ||
        hashCanonical(capabilities(version)) !==
          hashCanonical(review.capabilities)
      )
        throw new Error("GRAPH_CHANGED");
      // Binding a previously account-only workflow is an explicit owner-approved upgrade.
      await db.query(
        "UPDATE workflows SET data=jsonb_set(data,'{rootId}',to_jsonb($3::text)) WHERE id=$1 AND account_id=$2 AND data->>'rootId' IS NULL",
        [id, actor.accountId, actor.rootId],
      );
      const at = clock().toISOString();
      let binding = await agentStore.reserve({
        accountId: actor.accountId,
        rootId: review.rootId,
        workflowId: id,
        versionId: review.versionId,
        graphHash: review.graphHash,
        capabilities: review.capabilities,
        expiresAt: review.expiresAt,
        state: "PENDING_REGISTRATION",
        createdAt: at,
        updatedAt: at,
      });
      await db.query(
        "UPDATE workflow_agent_reviews SET data=jsonb_set(data,'{bindingId}',to_jsonb($2::text)) WHERE id=$1 AND data->>'bindingId' IS NULL",
        [review.id, binding.id],
      );
      try {
        binding = await activate(binding);
      } catch {
        binding = (await agentStore.get(binding.id))!;
      }
      return { binding };
    },
    async revoke(actor: WorkflowActor, id: string) {
      let binding = await agentStore.get(id);
      if (!binding || binding.accountId !== actor.accountId)
        throw new Error("NOT_FOUND");
      await owned(actor, binding.workflowId);
      if (binding.rootId !== actor.rootId) throw new Error("NOT_FOUND");
      await owner(actor);
      if (["REVOKED", "EXPIRED", "FAILED"].includes(binding.state))
        return { binding };
      if (binding.state !== "REVOKING")
        binding = await agentStore.transition(
          id,
          binding.revision,
          "REVOKING",
          { at: clock() },
        );
      await db.query(
        "UPDATE workflow_schedules SET status='PAUSED',next_fire_at=NULL,data=jsonb_set(jsonb_set(data,'{status}','\"PAUSED\"'),'{nextFireAt}', 'null') WHERE workflow_id=$1 AND status='ACTIVE'",
        [binding.workflowId],
      );
      try {
        binding = await finishRevoke(binding);
      } catch {
        /* Local deny remains authoritative. */
      }
      return { binding };
    },
    async recover(signal: AbortSignal) {
      while (!signal.aborted) {
        const rows = await db.query<{ data: WorkflowAgentBinding }>(
          "SELECT data FROM workflow_agent_bindings WHERE data->>'state' IN ('PENDING_REGISTRATION','REVOKING','ACTIVE')",
        );
        for (const { data: binding } of rows.rows) {
          if (signal.aborted) break;
          try {
            if (Date.parse(binding.expiresAt) <= clock().getTime())
              await agentStore.transition(
                binding.id,
                binding.revision,
                "EXPIRED",
                { at: clock() },
              );
            else if (binding.state === "PENDING_REGISTRATION")
              await activate(binding);
            else if (binding.state === "REVOKING") await finishRevoke(binding);
          } catch {
            /* Recoverable RPC/revision failure; no downgrade or new identity. */
          }
        }
        await new Promise<void>((resolve) => {
          const done = () => {
            clearTimeout(timer);
            signal.removeEventListener("abort", done);
            resolve();
          };
          const timer = setTimeout(done, 5000);
          signal.addEventListener("abort", done, { once: true });
          if (signal.aborted) done();
        });
      }
    },
  };
}
