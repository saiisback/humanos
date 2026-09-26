import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import {
  WorkflowAgentView,
  agentStatus,
  fenced,
  identityNavigation,
  ownedDetail,
  ownedReview,
  runGate,
  usesLegacyApp,
  workflowSearch,
  type AgentViewProps,
  type WorkflowAgentBinding,
  type WorkflowAgentDetailResponse,
  type WorkflowAgentReview,
} from "./agent-panel";

const address = "0x1111111111111111111111111111111111111111";
const accountId = `11155111:${address}`;
const tx = `0x${"ab".repeat(32)}`;
const now = Date.parse("2026-09-26T00:00:00.000Z");
const binding: WorkflowAgentBinding = {
  id: "binding-1",
  accountId,
  rootId: "root-1",
  workflowId: "wf-1",
  versionId: "v-2",
  graphHash: `0x${"cd".repeat(32)}`,
  capabilities: ["drafts.write", "web.search"],
  expiresAt: "2026-09-27T00:00:00.000Z",
  generation: 1,
  derivationId: "workflow:wf-1:1",
  chainId: 11155111,
  ensName: "wf-1-1.alice.humanos.eth",
  node: `0x${"ef".repeat(32)}`,
  agentAddress: "0x2222222222222222222222222222222222222222",
  state: "ACTIVE",
  revision: 3,
  registrationTxHashes: [tx],
  revocationTxHashes: [],
  createdAt: "2026-09-25T23:00:00.000Z",
  updatedAt: "2026-09-25T23:01:00.000Z",
};
const pending: WorkflowAgentBinding = {
  ...binding,
  state: "PENDING_REGISTRATION",
  ensName: null,
  node: null,
  agentAddress: null,
  registrationTxHashes: [],
};
const failed: WorkflowAgentBinding = { ...pending, state: "FAILED" };
const review: WorkflowAgentReview = {
  id: "review-1",
  reviewHash: `0x${"12".repeat(32)}`,
  workflowId: "wf-1",
  versionId: "v-2",
  capabilities: ["drafts.write"],
  expiresAt: "2026-09-27T00:00:00.000Z",
  reviewExpiresAt: "2026-09-26T00:05:00.000Z",
  chainId: 11155111,
  parentName: "alice.humanos.eth",
  rootId: "root-1",
  accountId,
};
const noop = () => {};
it("explains receipt failure separately from task execution, with safe recovery guidance", () => {
  const html = view({
    load: ready({
      binding,
      bindings: [binding],
      receiptPublications: [
        {
          runId: "run-1",
          receiptHash: tx,
          state: "FAILED",
          txHashes: [],
          errorCode: "INSUFFICIENT_FUNDS",
          attempts: 8,
        },
      ],
    }),
  });
  expect(html).toContain("Receipt not published");
  expect(html).toContain("Sepolia ETH");
  expect(html).toContain("Do not rerun the task");
  expect(html).toContain("8 attempts");
  expect(html).not.toContain("None recorded");
});
it("does not invent a cause for older failures without diagnostics", () => {
  const html = view({
    load: ready({
      receiptPublications: [
        { runId: "run-1", receiptHash: tx, state: "FAILED", txHashes: [] },
      ],
    }),
  });
  expect(html).toContain("The original error was not recorded");
});
it("does not describe an ENS-required task as account-owned before registration", () => {
  expect(runGate(ready(), "v-2", now, true)).toMatchObject({
    allowed: false,
    note: expect.stringContaining("task start"),
  });
});
it("does not offer agent registration for an unprepared empty workflow", () => {
  const html = view({ planReady: false });
  expect(html).not.toContain("Enable ENS agent");
  expect(html).toContain(
    "Prepare an executable workflow before enabling an ENS agent",
  );
});
it("shows recorded receipt publication evidence separately from registration", () => {
  const html = view({
    load: ready({
      binding,
      bindings: [binding],
      receiptPublications: [
        { runId: "run-1", receiptHash: tx, state: "PUBLISHED", txHashes: [tx] },
      ],
    }),
  });
  expect(html).toContain("ENS receipt publications");
  expect(html).toContain("PUBLISHED");
  expect(html).toContain(`https://sepolia.etherscan.io/tx/${tx}`);
});
const ready = (value: Partial<WorkflowAgentDetailResponse> = {}) => ({
  status: "ready" as const,
  value: { binding: null, bindings: [], available: true, ...value },
});
function view(overrides: Partial<AgentViewProps> = {}) {
  const props: AgentViewProps = {
    account: {
      id: accountId,
      address,
      chainId: 11155111,
      createdAt: "2026-09-25T00:00:00.000Z",
    } as AgentViewProps["account"],
    root: {
      id: "root-1",
      ensName: "alice.humanos.eth",
      createdAt: "2026-09-25T00:00:00.000Z",
      verificationEnvironment: "staging",
    },
    workflowId: "wf-1",
    versionId: "v-2",
    versions: [
      { id: "v-1", version: 1 },
      { id: "v-2", version: 2 },
    ],
    load: ready(),
    list: { status: "loading" },
    review: null,
    confirmingRevoke: false,
    busy: false,
    error: "",
    now,
    actions: {
      review: noop,
      enable: noop,
      cancelReview: noop,
      askRevoke: noop,
      revoke: noop,
      keepAgent: noop,
      retry: noop,
      close: noop,
    },
    ...overrides,
  };
  return renderToStaticMarkup(<WorkflowAgentView {...props} />);
}
const count = (html: string, text: string) => html.split(text).length - 1;

it("shows server-verified name, controller, exact scope, expiry, custody and actual transaction references", () => {
  const html = view({ load: ready({ binding, bindings: [binding] }) });
  for (const text of [
    "Active on Sepolia",
    "wf-1-1.alice.humanos.eth",
    "0x2222222222222222222222222222222222222222",
    "Sepolia testnet · chain 11155111",
    "drafts.write",
    "web.search",
    "no automatic renewal",
    "Version 2 (current)",
    binding.graphHash,
    tx,
    `https://sepolia.etherscan.io/tx/${tx}`,
    "not in your JAW wallet",
    "Staging World ID",
    address,
    "Revoke agent",
  ])
    expect(html).toContain(text);
  expect(html).not.toContain("Enable ENS agent");
});

it("never presents pending, unavailable, expired or evidence-free bindings as active", () => {
  const html = view({ load: ready({ binding: pending, bindings: [pending] }) });
  expect(html).toContain("Registration pending onchain");
  expect(html).toContain("Assigned after registration confirms");
  expect(html).toContain("None recorded");
  expect(html).not.toContain("Active on Sepolia");
  expect(html).toContain("Revoke agent");
  expect(html).not.toContain("Enable ENS agent");

  const offline = view({
    load: ready({ binding, bindings: [binding], available: false }),
  });
  expect(offline).toContain("Chain check unavailable");
  expect(offline).not.toContain("Active on Sepolia");
  expect(offline).not.toContain("Review replacement agent");

  const unavailable = view({
    load: { status: "unavailable", message: "RPC timeout." },
  });
  expect(unavailable).toContain("ENS agent status unavailable");
  expect(unavailable).toContain("RPC timeout.");
  expect(unavailable).toContain("No agent is assumed active");
  expect(unavailable).not.toContain("Active on Sepolia");

  expect(agentStatus(binding, true, now).active).toBe(true);
  expect(agentStatus(binding, false, now).active).toBe(false);
  expect(
    agentStatus({ ...binding, registrationTxHashes: [] }, true, now).active,
  ).toBe(true);
  expect(
    agentStatus({ ...binding, agentAddress: null }, true, now).active,
  ).toBe(false);
  expect(
    agentStatus(
      { ...binding, expiresAt: "2026-09-25T00:00:00.000Z" },
      true,
      now,
    ),
  ).toMatchObject({ active: false, label: expect.stringContaining("Expired") });
  expect(
    agentStatus({ ...binding, state: "REVOKING" }, true, now),
  ).toMatchObject({
    active: false,
    label: expect.stringContaining("onchain revocation pending"),
  });
});

it("offers explicit enablement for never-bound workflows and shows one exact registration consent without a run", () => {
  const fresh = view();
  expect(fresh).toContain("No ENS agent registered");
  expect(fresh).toContain("Enable ENS agent");

  const html = view({ review });
  for (const text of [
    "alice.humanos.eth",
    "drafts.write",
    "Sepolia testnet · chain 11155111",
    "no automatic renewal",
    "Review valid until",
    "not in your JAW wallet",
    "does not start a run",
  ])
    expect(html).toContain(text);
  expect(count(html, "Register ENS agent")).toBe(1);
  expect(html).not.toContain("Enable ENS agent");
  expect(html).not.toMatch(/<button[^>]*>Run/);

  const stale = view({ review, now: Date.parse("2026-09-26T00:06:00.000Z") });
  expect(stale).toContain("This review expired");
});

it("shows recovery for failed registration and explicit confirmation before revocation", () => {
  const html = view({ load: ready({ binding: failed, bindings: [failed] }) });
  expect(html).toContain("Registration failed");
  expect(html).toContain("Review a new registration to recover");
  expect(html).toContain("Review replacement agent");
  expect(html).not.toMatch(/<button[^>]*>Run/);

  const confirming = view({
    load: ready({ binding, bindings: [binding] }),
    confirmingRevoke: true,
  });
  expect(confirming).toContain("Actions already completed cannot be undone");
  expect(confirming).toContain("Keep agent");
});

it("allows account-only runs only for never-bound workflows and never downgrades bound ones", () => {
  expect(runGate(ready(), "v-2", now)).toMatchObject({
    allowed: true,
    mode: "account",
  });
  expect(
    runGate(ready({ binding, bindings: [binding] }), "v-2", now),
  ).toMatchObject({ allowed: true, mode: "ens" });
  expect(
    runGate(ready({ binding, bindings: [binding] }), "v-3", now).allowed,
  ).toBe(false);
  expect(
    runGate(
      ready({ binding, bindings: [binding], available: false }),
      "v-2",
      now,
    ).allowed,
  ).toBe(false);
  expect(
    runGate(ready({ binding: pending, bindings: [pending] }), "v-2", now)
      .allowed,
  ).toBe(false);
  const recovery = runGate(
    ready({ binding: failed, bindings: [failed] }),
    "v-2",
    now,
  );
  expect(recovery.allowed).toBe(false);
  expect(recovery.note).toContain("will not fall back to account-only");
  expect(
    runGate(
      ready({ binding: null, bindings: [{ ...binding, state: "REVOKED" }] }),
      "v-2",
      now,
    ).allowed,
  ).toBe(false);
  expect(runGate({ status: "loading" }, "v-2", now).allowed).toBe(false);
  expect(
    runGate({ status: "unavailable", message: "offline" }, "v-2", now).allowed,
  ).toBe(false);
});

it("rejects agent records and reviews for another account, workflow, version or chain", () => {
  expect(
    ownedDetail(
      { binding, bindings: [binding], available: true },
      accountId,
      "wf-1",
    ),
  ).not.toBeNull();
  expect(
    ownedDetail(
      {
        binding: {
          ...binding,
          accountId: "11155111:0x3333333333333333333333333333333333333333",
        },
        bindings: [],
        available: true,
      },
      accountId,
      "wf-1",
    ),
  ).toBeNull();
  expect(
    ownedDetail(
      {
        binding: null,
        bindings: [{ ...binding, workflowId: "wf-2" }],
        available: true,
      },
      accountId,
      "wf-1",
    ),
  ).toBeNull();
  expect(ownedReview(review, accountId, "wf-1", "v-2")).toBe(true);
  expect(ownedReview(review, accountId, "wf-1", "v-3")).toBe(false);
  expect(
    ownedReview(
      review,
      "11155111:0x3333333333333333333333333333333333333333",
      "wf-1",
      "v-2",
    ),
  ).toBe(false);
  expect(
    ownedReview(
      { ...review, chainId: 1 as 11155111 },
      accountId,
      "wf-1",
      "v-2",
    ),
  ).toBe(false);
});

it("discards agent responses that resolve after an account or workflow switch", async () => {
  let scope = {
    accountId: accountId as string | null,
    workflowId: "wf-1" as string | null,
    generation: 1,
  };
  let resolve!: (value: string) => void;
  const stale = fenced(
    () =>
      new Promise<string>((done) => {
        resolve = done;
      }),
    scope,
    () => scope,
  );
  scope = {
    accountId: "11155111:0x3333333333333333333333333333333333333333",
    workflowId: "wf-1",
    generation: 2,
  };
  resolve("stale");
  await expect(stale).resolves.toBeNull();
  let other!: (value: string) => void;
  const moved = fenced(
    () =>
      new Promise<string>((done) => {
        other = done;
      }),
    scope,
    () => scope,
  );
  scope = { ...scope, workflowId: "wf-2", generation: 3 };
  other("stale");
  await expect(moved).resolves.toBeNull();
  await expect(
    fenced(
      async () => "fresh",
      scope,
      () => scope,
    ),
  ).resolves.toBe("fresh");
});

it("keeps identity deep links in the workspace, supports back navigation and keeps legacy links explicit", () => {
  expect(usesLegacyApp("?workflow=wf-1&identity=1", "development")).toBe(false);
  expect(usesLegacyApp("?identity=1", "development")).toBe(false);
  expect(usesLegacyApp("?identity=1", "e2e")).toBe(false);
  expect(usesLegacyApp("?legacy=1", "development")).toBe(true);
  expect(usesLegacyApp("?mission=mission-fixture", "development")).toBe(true);
  expect(usesLegacyApp("", "e2e")).toBe(true);
  expect(usesLegacyApp("?mission=mission-fixture", "e2e")).toBe(true);
  expect(usesLegacyApp("?workflow=wf-1&identity=1", "e2e")).toBe(false);

  expect(workflowSearch("wf-1", true)).toBe("?workflow=wf-1&identity=1");
  expect(workflowSearch("wf-1", false)).toBe("?workflow=wf-1");
  expect(identityNavigation("?workflow=wf-1", null, true)).toEqual({
    kind: "push",
    url: "?workflow=wf-1&identity=1",
  });
  expect(
    identityNavigation(
      "?workflow=wf-1&identity=1",
      { humanosIdentity: true },
      false,
    ),
  ).toEqual({ kind: "back" });
  expect(identityNavigation("?workflow=wf-1&identity=1", null, false)).toEqual({
    kind: "replace",
    url: "?workflow=wf-1",
  });
  expect(identityNavigation("?identity=1", null, false)).toEqual({
    kind: "replace",
    url: "",
  });
  expect(identityNavigation("?workflow=wf-1&identity=1", null, true)).toEqual({
    kind: "none",
  });
});

it("lists account agents compactly with links that reopen the owning workflow's panel", () => {
  const html = view({
    workflowId: null,
    list: {
      status: "ready",
      value: { bindings: [binding, pending], available: false },
    },
  });
  expect(html).toContain('href="?workflow=wf-1&amp;identity=1"');
  expect(html).toContain("wf-1-1.alice.humanos.eth");
  expect(html).toContain("Name pending");
  expect(html).toContain("none is treated as active");
  expect(html).not.toContain("Active on Sepolia");
  expect(html).not.toContain("Back to workflow");
  expect(html).toContain('href="/?legacy=1"');
});
