import type { MissionDetailResponse } from "../../packages/schemas/src/api";
import type { MissionState } from "../../packages/schemas/src/domain";
import type { Page } from "@playwright/test";
// These are explicitly intercepted HTTP fixtures, not live provider evidence.
export const initial = (): MissionDetailResponse => ({
  mission: {
    id: "mission-fixture",
    rootId: "root-fixture",
    agentEns: null,
    title: "Tokyo application",
    goal: "Prepare my Tokyo application",
    capabilities: ["application.submit"],
    approvedCapabilities: [],
    steps: ["Prepare application", "Request human approval"],
    expiresAt: "2099-09-24T12:00:00Z",
    createdAt: "2026-09-24T01:00:00Z",
    updatedAt: "2026-09-24T01:00:00Z",
    policyVersion: "v1",
    state: "PROPOSED",
  },
  actions: [],
  approvals: [],
  receipts: [],
  events: [],
  assessment: null,
  decision: null,
});
export async function fixture(
  page: Page,
  options: { state?: MissionState; existing?: boolean } = {},
) {
  const data = initial();
  if (options.state) data.mission.state = options.state;
  let exists = !!options.existing;
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    let response: unknown = {};
    if (path === "/api/session")
      response = {
        root: {
          id: "root-fixture",
          ensName: "human.eth",
          createdAt: "2026-09-24T01:00:00Z",
          verificationEnvironment: "staging",
        },
      };
    else if (path === "/api/ready")
      response = {
        ready: false,
        services: [
          {
            name: "Fixture API",
            ready: true,
            reason:
              "Intercepted Playwright fixture; no live provider operation.",
          },
        ],
      };
    else if (path === "/api/missions" && route.request().method() === "GET")
      response = { missions: exists ? [data.mission] : [] };
    else if (path === "/api/missions") {
      exists = true;
      response = data;
    } else if (path.endsWith("/authorize")) {
      data.mission.state = "AUTHORIZED";
      data.mission.approvedCapabilities = ["application.submit"];
      data.mission.agentEns = "task.human.eth";
      response = data;
    } else if (path.endsWith("/run")) {
      data.mission.state = "AWAITING_APPROVAL";
      data.actions = [
        {
          id: "action-fixture",
          rootId: "root-fixture",
          missionId: data.mission.id,
          agentEns: "task.human.eth",
          type: "SUBMIT_APPLICATION",
          capability: "application.submit",
          payload: { event: "ETHGlobal Tokyo" },
          reason: "Submit the prepared application",
          payloadHash: "0x" + "a".repeat(64),
          nonce: "nonce-fixture",
          expiresAt: data.mission.expiresAt,
          createdAt: data.mission.createdAt,
        },
      ];
      data.assessment = {
        stateHash: "0x" + "a".repeat(64),
        questionVersion: "v1",
        modelVersion: "fixture",
        evaluatedAt: data.mission.createdAt,
        missionAligned: true,
        injectionDetected: false,
        requiresReview: true,
        missionAlignmentScore: 1,
        injectionScore: 0,
        risk: "SENSITIVE",
        confidence: 0.99,
        reason: "Submission needs review",
      };
      data.decision = {
        policyVersion: "v1",
        effectiveCapabilities: ["application.submit"],
        allowed: false,
        risk: "SENSITIVE",
        requiresApproval: true,
        reasons: ["Fresh human proof required"],
      };
      response = data;
    } else if (path.endsWith("/approval/cancel")) {
      data.mission.state = "REJECTED";
      data.events.push({
        id: "event-cancel",
        missionId: data.mission.id,
        actionId: "action-fixture",
        previousState: "AWAITING_APPROVAL",
        policyVersion: "v1",
        modelVersions: {},
        metadata: {},
        type: "APPROVAL_CANCELLED",
        actor: "human",
        nextState: "REJECTED",
        createdAt: data.mission.createdAt,
      });
      response = data;
    } else if (path.endsWith("/revoke")) {
      data.mission.state = "REVOKED";
      response = data;
    } else if (path.endsWith("/confirm")) {
      return route.fulfill({
        status: 403,
        json: {
          error: {
            code: "FORBIDDEN",
            message: "Sensitive actions require fresh World verification.",
          },
        },
      });
    } else if (path.endsWith("/approval/request")) {
      return route.fulfill({
        status: 503,
        json: {
          error: {
            code: "INTEGRATION_UNAVAILABLE",
            message:
              "World integration is unavailable. Configure credentials to verify.",
          },
        },
      });
    } else if (path.endsWith("/execute")) {
      data.mission.state = "COMPLETED";
      data.receipts = [
        {
          id: "receipt-fixture",
          missionId: data.mission.id,
          idempotencyKey: "fixture",
          payloadHash: "0x" + "a".repeat(64),
          externalId: null,
          metadata: {},
          actionId: "action-fixture",
          status: "SUCCEEDED",
          executedAt: data.mission.createdAt,
        },
      ];
      response = data.receipts[0];
    } else if (path === "/api/missions/mission-fixture") response = data;
    else
      return route.fulfill({
        status: 404,
        json: {
          error: { code: "NOT_FOUND", message: "Unknown fixture route" },
        },
      });
    await route.fulfill({ json: response });
  });
  return data;
}
export async function createAndRun(page: Page) {
  await page.goto("/");
  await page
    .getByLabel("What would you like to get done?")
    .fill("Prepare my Tokyo application");
  await page.getByRole("button", { name: "Create mission" }).click();
  await page.getByRole("button", { name: "Authorize & create agent" }).click();
  await page.getByRole("button", { name: "Run mission", exact: true }).click();
}
