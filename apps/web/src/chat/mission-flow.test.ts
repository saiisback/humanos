import { describe, expect, it } from "vitest";
import type { MissionDetailResponse } from "@humanos/schemas";
import { buildTranscript } from "./mission-flow";

const hash = `0x${"a".repeat(64)}`;
function detail(
  state: MissionDetailResponse["mission"]["state"],
): MissionDetailResponse {
  return {
    mission: {
      id: "mission-1",
      rootId: "root-1",
      goal: "Send my application",
      title: "Application",
      capabilities: ["application.submit"],
      approvedCapabilities: [],
      steps: ["Review application"],
      expiresAt: "2026-10-01T00:00:00.000Z",
      createdAt: "2026-09-25T00:00:00.000Z",
      updatedAt: "2026-09-25T00:00:00.000Z",
      policyVersion: "v1",
      agentEns: null,
      state,
    },
    actions: [],
    approvals: [],
    receipts: [],
    events: [],
    assessment: null,
    decision: null,
  };
}
const ready = { ready: false, services: [] };

describe("buildTranscript", () => {
  it("maps a proposed mission to mandate review", () => {
    expect(
      buildTranscript(detail("PROPOSED"), ready).some(
        (item) => item.kind === "mandate",
      ),
    ).toBe(true);
  });
  it("keeps the exact action hash and a readable effect in approval review", () => {
    const d = detail("AWAITING_APPROVAL");
    d.actions.push({
      id: "action-1",
      rootId: "root-1",
      missionId: "mission-1",
      agentEns: "agent.eth",
      type: "SEND_EMAIL",
      capability: "email.send",
      reason: "Send the approved invitation",
      payload: { to: "someone@example.com", subject: "Invitation" },
      payloadHash: hash,
      nonce: "nonce-1",
      expiresAt: "2026-10-01T00:00:00.000Z",
      createdAt: "2026-09-25T00:00:00.000Z",
    });
    const review = buildTranscript(d, ready).find(
      (item) => item.kind === "approval",
    );
    expect(review).toMatchObject({ kind: "approval", payloadHash: hash });
    if (review?.kind === "approval")
      expect(review.effect).toContain("someone@example.com");
  });
  it.each(["REJECTED", "REVOKED"] as const)(
    "maps %s to a terminal denial",
    (state) => {
      expect(
        buildTranscript(detail(state), ready).some(
          (item) => item.kind === "denial" && item.terminal,
        ),
      ).toBe(true);
    },
  );
  it("suppresses action execution controls after a terminal mission", () => {
    const d = detail("REVOKED");
    d.actions.push({
      id: "action-1",
      rootId: "root-1",
      missionId: "mission-1",
      agentEns: "agent.eth",
      type: "SEND_EMAIL",
      capability: "email.send",
      reason: "Send an invitation",
      payload: { to: "someone@example.com" },
      payloadHash: hash,
      nonce: "nonce-1",
      expiresAt: "2026-10-01T00:00:00.000Z",
      createdAt: "2026-09-25T00:00:00.000Z",
    });
    expect(
      buildTranscript(d, ready).some((item) => item.kind === "approval"),
    ).toBe(false);
  });
  it("maps a real receipt to a terminal receipt item", () => {
    const d = detail("COMPLETED");
    d.receipts.push({
      id: "receipt-1",
      actionId: "action-1",
      missionId: "mission-1",
      idempotencyKey: "key-1",
      payloadHash: hash,
      status: "SUCCEEDED",
      externalId: null,
      executedAt: "2026-09-25T00:00:00.000Z",
      metadata: {},
    });
    expect(
      buildTranscript(d, ready).some(
        (item) => item.kind === "receipt" && item.terminal,
      ),
    ).toBe(true);
  });
  it("does not infer success from unknown or missing provider data", () => {
    const items = buildTranscript(detail("RUNNING"), ready);
    expect(
      items.some(
        (item) =>
          item.kind === "receipt" ||
          (item.kind === "identity" && item.verified),
      ),
    ).toBe(false);
  });
});
