import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { EnsStartReview, registerAndStart, waitForRegisteredAgent } from "./ens-start";
import type { WorkflowAgentReview, WorkflowAgentDetailResponse } from "./agent-panel";

const review: WorkflowAgentReview = { id: "review", reviewHash: "hash", accountId: "owner",
  rootId: "root", workflowId: "w", versionId: "v", chainId: 11155111,
  parentName: "test-humanos.eth", capabilities: ["drafts.write"],
  expiresAt: "2099-01-01T00:00:00Z", reviewExpiresAt: "2098-01-01T00:00:00Z" };
const detail = (state: string) => ({ available: true, bindings: [],
  binding: { id: "b", workflowId: "w", accountId: "owner", versionId: "v", rootId: "root",
    state, expiresAt: review.expiresAt, ensName: "agent.test-humanos.eth", registrationTxHashes: [],
    agentAddress: "0x1111111111111111111111111111111111111111", node: "0x" + "11".repeat(32) },
}) as unknown as WorkflowAgentDetailResponse;

it("includes scope, expiry and chain cost consent in the normal start action", () => {
  const html = renderToStaticMarkup(<EnsStartReview review={review} busy={false} onStart={() => {}} />);
  for (const value of ["drafts.write", "2099", "Sepolia", "gas", "Start task"])
    expect(html).toContain(value);
  expect(html).not.toContain("Enable ENS agent");
});
it("waits for registration before starting exactly once", async () => {
  const events: string[] = [];
  let reads = 0;
  await registerAndStart({ review, current: () => true,
    enable: async () => { events.push("register"); },
    read: async () => { events.push("read"); return detail(++reads === 1 ? "PENDING_REGISTRATION" : "ACTIVE"); },
    wait: async () => { events.push("wait"); },
    start: async () => { events.push("run"); },
  });
  expect(events).toEqual(["register", "read", "wait", "read", "run"]);
});
it.each(["REVOKED", "FAILED", "EXPIRED"])("does not execute under %s authority", async state => {
  let runs = 0;
  await expect(registerAndStart({ review, current: () => true, enable: async () => {},
    read: async () => detail(state), wait: async () => {}, start: async () => { runs++; },
  })).rejects.toThrow();
  expect(runs).toBe(0);
});
it("does not start after the account or selected task changes during registration", async () => {
  let current = true, runs = 0;
  await registerAndStart({ review, current: () => current,
    enable: async () => { current = false; }, read: async () => detail("ACTIVE"),
    wait: async () => {}, start: async () => { runs++; },
  });
  expect(runs).toBe(0);
});
it("never registers an expired review", async () => {
  let writes = 0;
  await expect(registerAndStart({ review: { ...review, reviewExpiresAt: "2000-01-01T00:00:00Z" },
    current: () => true, enable: async () => { writes++; }, read: async () => detail("ACTIVE"),
    wait: async () => {}, start: async () => {},
  })).rejects.toThrow("expired");
  expect(writes).toBe(0);
});
it("keeps waiting beyond five minutes for finality without registering twice", async () => {
  let reads = 0, registrations = 0, runs = 0;
  await registerAndStart({ review, current: () => true,
    enable: async () => { registrations++; },
    read: async () => detail(++reads > 70 ? "ACTIVE" : "PENDING_REGISTRATION"),
    wait: async () => {}, start: async () => { runs++; },
  });
  expect(registrations).toBe(1);
  expect(runs).toBe(1);
});
it("resumes an already consented pending registration using only reads", async () => {
  let reads = 0, runs = 0;
  await waitForRegisteredAgent({ identity: review, current: () => true,
    read: async () => detail(++reads > 1 ? "ACTIVE" : "PENDING_REGISTRATION"),
    wait: async () => {}, start: async () => { runs++; },
  });
  expect(reads).toBe(2); expect(runs).toBe(1);
});
