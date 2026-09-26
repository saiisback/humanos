import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type {
  WorkflowRun,
  WorkflowSchedule,
  WorkflowVersion,
} from "@humanos/schemas";
import {
  createPinnedSchedule,
  createWorkflowScheduler,
  revisePinnedSchedule,
} from "../src/workflows/scheduler.js";
import { createWorkflowRoutes } from "../src/workflows/routes.js";
import {
  resolveAuthorityPin,
  scheduleAuthorityCurrent,
} from "../src/workflows/agent-authorizer.js";
import {
  OTHER,
  OWNER,
  createAgentFixture,
  type LiveChain,
} from "./workflow-agent-fixture.js";

const f = createAgentFixture("test_workflow_agent_runtime");
beforeAll(() => f.init());
afterAll(() => f.close());
beforeEach(() => f.reset());

const readsFor = (name: string | null) =>
  f.port.readAuthorizationDetails.mock.calls.filter(([read]) => read === name)
    .length;
const runsOf = async (workflowId: string) =>
  (await f.store.list<WorkflowRun>("workflow_runs")).filter(
    (r) => r.workflowId === workflowId,
  );

describe("authority pinning at run creation", () => {
  it("blocks direct runs and account schedules when a new workflow requires ENS", async () => {
    const wf = await f.workflow("draft");
    await f.db.query("UPDATE workflows SET data=jsonb_set(data,'{authorityRequirement}','\"ens\"') WHERE id=$1", [wf.id]);
    await expect(f.start(wf.id)).rejects.toThrow("ENS_AGENT_REQUIRED");
    expect(await scheduleAuthorityCurrent(f.db, { workflowId: wf.id, authorityMode: "account" } as WorkflowSchedule, new Date())).toBe(false);
    expect(await runsOf(wf.id)).toHaveLength(0);
  });
  it("rejects an account-pinned run at dispatch when its workflow requires ENS", async () => {
    const wf = await f.workflow("draft");
    const run = await f.start(wf.id);
    await f.db.query("UPDATE workflows SET data=jsonb_set(data,'{authorityRequirement}','\"ens\"') WHERE id=$1", [wf.id]);
    await f.drain();
    expect((await f.run(run.id))?.status).toBe("REVOKED");
    expect(f.effectsFor(run.id)).toEqual([]);
  });
  it("keeps account-only behavior when a workflow has no agent binding", async () => {
    const wf = await f.workflow("draft");
    const run = await f.start(wf.id);
    expect(run).toMatchObject({
      authorityMode: "account",
      agentBindingId: null,
    });
    await f.drain();
    expect((await f.run(run.id))?.status).toBe("COMPLETED");
    expect(f.effectsFor(run.id)).toEqual(["draft"]);
    expect(f.port.readAuthorizationDetails).not.toHaveBeenCalled();
  });
  it("pins new runs to the active binding generation", async () => {
    const wf = await f.workflow("draft");
    const binding = await f.bind(wf, ["drafts.write"]);
    expect(await f.start(wf.id)).toMatchObject({
      authorityMode: "ens",
      agentBindingId: binding.id,
    });
  });
  it.each(["PENDING_REGISTRATION", "FAILED", "REVOKING", "REVOKED"] as const)(
    "never creates an account run once a %s binding exists",
    async (state) => {
      const wf = await f.workflow("draft");
      let binding = await f.bind(
        wf,
        ["drafts.write"],
        state === "PENDING_REGISTRATION" || state === "FAILED"
          ? "PENDING_REGISTRATION"
          : "ACTIVE",
      );
      if (state === "FAILED") binding = await f.fail(binding);
      if (state === "REVOKING" || state === "REVOKED")
        binding = await f.revoke(binding);
      if (state === "REVOKED") await f.finishRevoke(binding);
      await expect(f.start(wf.id)).rejects.toThrow("ENS_AGENT_REQUIRED");
      expect(await runsOf(wf.id)).toHaveLength(0);
    },
  );
});

describe("live ENS authority at execution", () => {
  it("runs research and drafting through the real runner, rechecking before every effect", async () => {
    const wf = await f.workflow("research-draft");
    const binding = await f.bind(wf);
    const run = await f.start(wf.id);
    await f.drain();
    expect((await f.run(run.id))?.status).toBe("COMPLETED");
    expect(f.effectsFor(run.id)).toEqual(["research", "draft"]);
    // Pre-step, pre-dispatch and at-dispatch checks for each of the two steps.
    expect(readsFor(binding.ensName)).toBe(6);
    expect(f.port.checkRootOwner).toHaveBeenCalledWith(f.rootId, OWNER);
  });

  const denials: Array<[string, Partial<LiveChain>]> = [
    ["unfinalized authorization", { finalized: false }],
    [
      "a moved agent controller",
      { account: OTHER, finalizedAccount: OTHER, latestAccount: OTHER },
    ],
    ["a latest-head controller change", { latestAccount: OTHER }],
    ["a finalized controller mismatch", { finalizedAccount: OTHER }],
    ["narrowed live scope", { capabilities: ["drafts.write"] }],
    [
      "an expired parent",
      { active: false, expiresAt: new Date(Date.now() - 1000).toISOString() },
    ],
    [
      "an expiry the reader still reports active",
      { expiresAt: new Date(Date.now() - 1000).toISOString() },
    ],
    [
      "latest-head revocation",
      { active: false, revoked: true, latestActive: false },
    ],
    [
      "a detached hierarchy",
      { active: false, failures: ["registrar reports inactive"] },
    ],
    ["a stale latest head", { failures: ["latest head is stale"] }],
    ["a different root record", { rootId: "root-other" }],
    ["a mismatched node", { node: `0x${"ab".repeat(32)}` }],
    ["a root owner change", { rootOwned: false }],
    ["RPC unavailability", { unavailable: true }],
  ];
  it.each(denials)("stops dispatch on %s", async (_label, change) => {
    const wf = await f.workflow("research");
    await f.bind(wf, ["web.search"]);
    const run = await f.start(wf.id);
    Object.assign(f.chain, change);
    await f.drain();
    expect((await f.run(run.id))?.status).toBe("REVOKED");
    expect(f.effectsFor(run.id)).toEqual([]);
  });

  it("never downgrades an ENS run to account authority when ENS is unconfigured", async () => {
    const wf = await f.workflow("draft");
    await f.bind(wf, ["drafts.write"]);
    const run = await f.start(wf.id);
    await f.drain({ ens: null });
    expect((await f.run(run.id))?.status).toBe("REVOKED");
    expect(f.effectsFor(run.id)).toEqual([]);
  });

  it("stops an already-queued account run once the owner upgrades the workflow", async () => {
    const wf = await f.workflow("draft");
    const run = await f.start(wf.id);
    expect(run.authorityMode).toBe("account");
    await f.bind(wf, ["drafts.write"], "PENDING_REGISTRATION");
    await f.drain();
    expect((await f.run(run.id))?.status).toBe("REVOKED");
    expect(f.effectsFor(run.id)).toEqual([]);
  });

  it("denies foreign, tampered, out-of-scope, expired and revoked contexts before any RPC", async () => {
    const wf = await f.workflow("draft");
    const binding = await f.bind(wf, ["drafts.write"]);
    const ctx = await f.contextFor(await f.start(wf.id));
    const { agent } = f.authorizer();
    expect(await agent(ctx)).toBe(true);
    const reads = readsFor(binding.ensName);
    const aborted = new AbortController();
    aborted.abort();
    expect(
      await agent({
        ...ctx,
        actor: { accountId: `11155111:${OTHER}`, rootId: f.rootId },
      }),
    ).toBe(false);
    expect(
      await agent({ ...ctx, actor: { ...ctx.actor, rootId: "root-other" } }),
    ).toBe(false);
    expect(
      await agent({
        ...ctx,
        run: { ...ctx.run, authorityMode: "account", agentBindingId: null },
      }),
    ).toBe(false);
    expect(
      await agent({
        ...ctx,
        version: { ...ctx.version, graph: { nodes: [] } },
      }),
    ).toBe(false);
    expect(
      await agent({
        ...ctx,
        node: { ...ctx.node, type: "research.web", capability: "web.search" },
      }),
    ).toBe(false);
    expect(await agent({ ...ctx, signal: aborted.signal })).toBe(false);
    expect(
      await f
        .authorizer({
          clock: () => new Date(Date.parse(binding.expiresAt) + 1000),
        })
        .agent(ctx),
    ).toBe(false);
    await f.revoke(binding);
    expect(await agent(ctx)).toBe(false);
    expect(readsFor(binding.ensName)).toBe(reads);
  });

  it.each([2, 3])(
    "a revocation committed during authorization read %i prevents the effect",
    async (readNumber) => {
      const wf = await f.workflow("draft");
      const binding = await f.bind(wf, ["drafts.write"]);
      const run = await f.start(wf.id);
      let reads = 0;
      // The chain still reports ACTIVE; only the post-RPC local recheck can stop this dispatch.
      f.hooks.beforeRead = async (name) => {
        if (name === binding.ensName && ++reads === readNumber)
          await f.revoke(binding);
      };
      await f.drain();
      expect((await f.run(run.id))?.status).toBe("REVOKED");
      expect(f.effectsFor(run.id)).toEqual([]);
      expect(reads).toBe(readNumber);
      expect((await f.agentStore.get(binding.id))?.state).toBe("REVOKING");
    },
  );

  it("rechecks the session and lease after the ENS read so a sign-out during RPC stops dispatch", async () => {
    const wf = await f.workflow("draft");
    const binding = await f.bind(wf, ["drafts.write"]);
    const run = await f.start(wf.id);
    let reads = 0;
    f.hooks.beforeRead = async (name) => {
      if (name === binding.ensName && ++reads === 3)
        await f.db.delete("sessions", f.actor.sessionId);
    };
    await f.drain();
    expect((await f.run(run.id))?.status).toBe("REVOKED");
    expect(f.effectsFor(run.id)).toEqual([]);
    expect((await f.agentStore.get(binding.id))?.state).toBe("ACTIVE");
  });
});

describe("schedules", () => {
  it("denies live revoked or unavailable ENS schedule authority without changing the binding state", async () => {
    const wf = await f.workflow("research");
    const binding = await f.bind(wf, ["web.search"]);
    const schedule = {
      ...createPinnedSchedule(
        wf.workflow,
        wf.version,
        {
          kind: "once",
          fireAt: new Date(Date.now() + 60000).toISOString(),
          timezone: "Asia/Tokyo",
        },
        new Date(),
      ),
      authorityMode: "ens" as const,
      agentBindingId: binding.id,
    };
    expect(
      await scheduleAuthorityCurrent(f.db, schedule, new Date(), f.ens),
    ).toBe(true);
    f.chain.revoked = true;
    expect(
      await scheduleAuthorityCurrent(f.db, schedule, new Date(), f.ens),
    ).toBe(false);
    f.chain.revoked = false;
    f.chain.unavailable = true;
    expect(
      await scheduleAuthorityCurrent(f.db, schedule, new Date(), f.ens),
    ).toBe(false);
    expect((await f.agentStore.get(binding.id))?.state).toBe("ACTIVE");
  });
  const scheduler = () =>
    createWorkflowScheduler({
      store: f.store,
      registry: f.registry,
      authorityCurrent: (schedule, now) =>
        scheduleAuthorityCurrent(f.db, schedule, now),
    });
  const secondsFromNow = (seconds: number) =>
    new Date(Math.ceil((Date.now() + seconds * 1000) / 1000) * 1000);
  const after = (at: Date) => new Date(at.getTime() + 1000);
  const scheduleOf = (id: string) =>
    f.store.get<WorkflowSchedule>("workflow_schedules", id);
  async function once(
    wf: Awaited<ReturnType<typeof f.workflow>>,
    fireAt: Date,
    pin: Partial<
      Pick<WorkflowSchedule, "authorityMode" | "agentBindingId">
    > | null = null,
  ) {
    const now = new Date();
    const schedule: WorkflowSchedule = {
      ...createPinnedSchedule(
        wf.workflow,
        wf.version,
        { kind: "once", fireAt: fireAt.toISOString(), timezone: "UTC" },
        now,
        f.actor.sessionId,
      ),
      ...(pin ?? (await resolveAuthorityPin(f.db, wf.id, wf.version.id, now))),
    };
    await f.store.saveSchedule(schedule);
    return schedule;
  }

  it("carries the schedule's binding pin into the scheduled run", async () => {
    const wf = await f.workflow("draft");
    const binding = await f.bind(wf, ["drafts.write"]);
    const fireAt = secondsFromNow(60);
    expect(await once(wf, fireAt)).toMatchObject({
      authorityMode: "ens",
      agentBindingId: binding.id,
    });
    await scheduler().tick(after(fireAt));
    const runs = await runsOf(wf.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      authorityMode: "ens",
      agentBindingId: binding.id,
      triggerKind: "once",
    });
    await f.drain();
    expect((await f.run(runs[0]!.id))?.status).toBe("COMPLETED");
    expect(f.effectsFor(runs[0]!.id)).toEqual(["draft"]);
  });

  it("pauses on revocation and never inherits a replacement generation", async () => {
    const wf = await f.workflow("draft");
    const first = await f.bind(wf, ["drafts.write"]);
    const fireAt = secondsFromNow(60);
    const schedule = await once(wf, fireAt);
    await f.revoke(first);
    await scheduler().tick(after(fireAt));
    const paused = (await scheduleOf(schedule.id))!;
    expect(paused).toMatchObject({
      status: "PAUSED",
      nextFireAt: null,
      agentBindingId: first.id,
    });
    await f.finishRevoke(first);
    const second = await f.bind(wf, ["drafts.write"]);
    expect(second.generation).toBe(first.generation + 1);
    const refire = secondsFromNow(120);
    const resumed = revisePinnedSchedule(
      paused,
      {
        status: "ACTIVE",
        definition: {
          kind: "once",
          fireAt: refire.toISOString(),
          timezone: "UTC",
        },
      },
      new Date(),
    );
    await f.store.compareAndSwapSchedule(paused, resumed);
    await scheduler().tick(after(refire));
    expect(await scheduleOf(schedule.id)).toMatchObject({
      status: "PAUSED",
      agentBindingId: first.id,
    });
    expect(await runsOf(wf.id)).toHaveLength(0);
    expect(
      (await resolveAuthorityPin(f.db, wf.id, wf.version.id, new Date()))
        .agentBindingId,
    ).toBe(second.id);
  });

  it("pauses at local agent expiry", async () => {
    const wf = await f.workflow("draft");
    const binding = await f.bind(wf, ["drafts.write"]);
    const schedule = await once(wf, secondsFromNow(60));
    await scheduler().tick(new Date(Date.parse(binding.expiresAt) + 1000));
    expect(await scheduleOf(schedule.id)).toMatchObject({
      status: "PAUSED",
      nextFireAt: null,
    });
    expect(await runsOf(wf.id)).toHaveLength(0);
  });

  it("pauses when the workflow's latest version moves past the pinned binding", async () => {
    const wf = await f.workflow("draft");
    await f.bind(wf, ["drafts.write"]);
    const fireAt = secondsFromNow(60);
    const schedule = await once(wf, fireAt);
    const next: WorkflowVersion = {
      ...wf.version,
      id: randomUUID(),
      version: 2,
      activatedAt: null,
      createdAt: new Date().toISOString(),
    };
    await f.store.insertVersion(next);
    await f.store.activateVersion(wf.id, next.id, next.graphHash);
    await scheduler().tick(after(fireAt));
    expect(await scheduleOf(schedule.id)).toMatchObject({ status: "PAUSED" });
    expect(await runsOf(wf.id)).toHaveLength(0);
  });

  it("pauses account-only and legacy schedules after an upgrade, and keeps them without bindings", async () => {
    const plain = await f.workflow("draft"),
      legacy = await f.workflow("draft"),
      upgraded = await f.workflow("draft");
    const fireAt = secondsFromNow(60);
    const account = { authorityMode: "account" as const, agentBindingId: null };
    await once(plain, fireAt, account);
    await once(legacy, fireAt, {});
    const staleAccount = await once(upgraded, fireAt, account);
    const staleLegacy = await once(upgraded, fireAt, {});
    await f.bind(upgraded, ["drafts.write"], "PENDING_REGISTRATION");
    await scheduler().tick(after(fireAt));
    // Separate workflows: overlapPolicy=skip correctly admits only one active run per workflow.
    const plainRuns = [
      ...(await runsOf(plain.id)),
      ...(await runsOf(legacy.id)),
    ];
    expect(plainRuns.map((r) => r.authorityMode ?? "legacy").sort()).toEqual([
      "account",
      "legacy",
    ]);
    expect(await runsOf(upgraded.id)).toHaveLength(0);
    expect((await scheduleOf(staleAccount.id))?.status).toBe("PAUSED");
    expect((await scheduleOf(staleLegacy.id))?.status).toBe("PAUSED");
  });
});

describe("HTTP boundary", () => {
  it("refuses account-mode creation after an upgrade and pins schedules to the binding", async () => {
    const app = createWorkflowRoutes(
      { service: f.service, store: f.store },
      async () => f.actor,
    );
    const post = (
      path: string,
      body: unknown,
      headers: Record<string, string> = {},
    ) =>
      app.request(path, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      });
    const definition = {
      kind: "once",
      fireAt: new Date(
        Math.ceil((Date.now() + 60000) / 1000) * 1000,
      ).toISOString(),
      timezone: "UTC",
    };
    const pending = await f.workflow("draft");
    await f.bind(pending, ["drafts.write"], "PENDING_REGISTRATION");
    const refused = await post(
      `/workflows/${pending.id}/runs`,
      { input: {} },
      { "idempotency-key": `agent-http-${randomUUID()}` },
    );
    expect(refused.status).toBe(409);
    expect(
      ((await refused.json()) as { error: { code: string } }).error.code,
    ).toBe("ENS_AGENT_REQUIRED");
    expect(
      (
        await post(`/workflows/${pending.id}/schedules`, {
          versionId: pending.version.id,
          definition,
        })
      ).status,
    ).toBe(409);
    expect(await runsOf(pending.id)).toHaveLength(0);

    const active = await f.workflow("draft");
    const binding = await f.bind(active, ["drafts.write"]);
    const created = await post(`/workflows/${active.id}/schedules`, {
      versionId: active.version.id,
      definition,
    });
    expect(created.status).toBe(201);
    const { schedule } = (await created.json()) as {
      schedule: WorkflowSchedule;
    };
    expect(schedule).toMatchObject({
      authorityMode: "ens",
      agentBindingId: binding.id,
    });
    expect(
      (await post(`/workflow-schedules/${schedule.id}`, { status: "PAUSED" }))
        .status,
    ).toBe(200);
    await f.revoke(binding);
    const resumed = await post(`/workflow-schedules/${schedule.id}`, {
      status: "ACTIVE",
    });
    expect(resumed.status).toBe(409);
    expect(
      ((await resumed.json()) as { error: { code: string } }).error.code,
    ).toBe("ENS_AGENT_REQUIRED");
  });
});
