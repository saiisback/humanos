/** Intercepted browser fixtures. No result here is live provider evidence. */
import type {
  MissionDetailResponse,
  AuthSessionResponse,
} from "../../packages/schemas/src/api";
import type { MissionState, Approval } from "../../packages/schemas/src/domain";
import type { Page } from "@playwright/test";

const createdAt = "2026-09-24T01:00:00Z";
const expiresAt = "2099-09-24T12:00:00Z";
const account = {
  id: `11155111:0x${"1".repeat(40)}`,
  address: `0x${"1".repeat(40)}`,
  chainId: 11155111,
  createdAt,
};
const root = {
  id: "root-fixture",
  ensName: "human.eth",
  createdAt,
  verificationEnvironment: "staging" as const,
};
const worldRequest = {
  requestId: "world-request-fixture",
  action: "humanos-root",
  signal: "fixture-signal",
  rpContext: {
    rp_id: "rp_fixture",
    nonce: "nonce-fixture",
    signature: "0xfixture",
    created_at: 1,
    expires_at: 4_000_000_000,
  },
  appId: "app_fixture",
  environment: "staging",
};

export const initial = (): MissionDetailResponse => ({
  mission: {
    id: "mission-fixture",
    rootId: root.id,
    agentEns: null,
    title: "Tokyo application",
    goal: "Prepare my Tokyo application",
    capabilities: ["application.submit"],
    approvedCapabilities: [],
    steps: ["Prepare application", "Request human approval"],
    expiresAt,
    createdAt,
    updatedAt: createdAt,
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
  options: {
    state?: MissionState;
    existing?: boolean;
    auth?: "linked" | "no-root" | "signed-out";
    jaw?: "success" | "reject";
    verifyRejected?: boolean;
    worldUnavailable?: boolean;
    permission?: "success" | "reject" | "unavailable";
  } = {},
) {
  const data = initial();
  if (options.state) data.mission.state = options.state;
  if (options.permission) {
    const start = Math.floor(Date.now() / 1000) - 5;
    const end = start + 3600;
    data.permissionReviews = [
      {
        id: "review-fixture",
        missionId: data.mission.id,
        accountId: account.id,
        account: account.address,
        chainId: 11155111,
        spender: `0x${"3".repeat(40)}`,
        calls: [{ target: `0x${"4".repeat(40)}`, selector: "0xa9059cbb" }],
        spends: [
          {
            token: `0x${"5".repeat(40)}`,
            allowance: "100",
            unit: "day",
            multiplier: 1,
          },
        ],
        start,
        end,
        expiresAt: new Date(end * 1000).toISOString(),
        createdAt: new Date(start * 1000).toISOString(),
      },
    ];
    data.permissionGrants = [];
  }
  let exists = !!options.existing;
  let session: AuthSessionResponse = {
    account: options.auth === "signed-out" ? null : account,
    root:
      options.auth === "signed-out" || options.auth === "no-root" ? null : root,
    jawConfigured: true,
  };
  await page.addInitScript(
    ({ jaw, permission }) => {
      window.__HUMANOS_E2E__ = { jaw, permission };
    },
    { jaw: options.jaw ?? "success", permission: options.permission },
  );
  const approval = (status: Approval["status"]): Approval => {
    const action = data.actions[0]!;
    return {
      id: "approval-fixture",
      actionId: action.id,
      binding: {
        rootId: root.id,
        agentEns: action.agentEns,
        missionId: data.mission.id,
        actionType: action.type,
        payloadHash: action.payloadHash,
        nonce: action.nonce,
        expiresAt,
      },
      bindingHash: `0x${"b".repeat(64)}`,
      kind: "WORLD_FRESH",
      status,
      createdAt,
      verifiedAt: status === "VERIFIED" ? new Date().toISOString() : null,
      consumedAt: null,
      nullifierHash: status === "VERIFIED" ? `0x${"c".repeat(64)}` : null,
    };
  };
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const method = route.request().method();
    let response: unknown = {};
    if (path === "/api/auth/session") response = session;
    else if (path === "/api/auth/siwe/nonce")
      response = {
        challengeId: "siwe-challenge-fixture",
        nonce: "123456789abcdef0",
        chainId: 11155111,
        domain: url.host,
        uri: url.origin,
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
      };
    else if (path === "/api/auth/siwe/verify") {
      if (options.verifyRejected)
        return route.fulfill({
          status: 403,
          json: {
            error: { code: "INVALID_SIGNATURE", message: "Invalid signature" },
          },
        });
      session = { account, root: null, jawConfigured: true };
      response = session;
    } else if (path === "/api/auth/logout") {
      session = { account: null, root: null, jawConfigured: true };
      response = session;
    } else if (path === "/api/world/root/request") {
      if (options.worldUnavailable)
        return route.fulfill({
          status: 503,
          json: {
            error: {
              code: "INTEGRATION_UNAVAILABLE",
              message: "World integration is unavailable.",
            },
          },
        });
      response = worldRequest;
    } else if (path === "/api/world/root/verify") {
      session = { account, root, jawConfigured: true };
      response = session;
    } else if (path === "/api/ready")
      response = {
        ready: false,
        services: [
          {
            name: "DeepSeek",
            ready: false,
            reason: "Test fixture; no live model call.",
          },
          {
            name: "Jev",
            ready: false,
            reason: "Test fixture; no live model call.",
          },
        ],
      };
    else if (path === "/api/jaw/permissions")
      response = { grants: data.permissionGrants ?? [] };
    else if (path === "/api/jaw/permissions/record") {
      const input = route.request().postDataJSON() as {
        grant: NonNullable<MissionDetailResponse["permissionGrants"]>[number];
      };
      data.permissionGrants = [input.grant];
      response = { grant: input.grant };
    } else if (path === `/api/jaw/permissions/0x${"a".repeat(64)}/revoke`) {
      const existing = data.permissionGrants?.[0];
      if (!existing)
        return route.fulfill({
          status: 404,
          json: { error: { code: "NOT_FOUND", message: "Unknown grant" } },
        });
      const grant = {
        ...existing,
        status: "REVOKED" as const,
        revokedAt: new Date().toISOString(),
      };
      data.permissionGrants = [grant];
      response = { grant };
    } else if (path === "/api/missions" && method === "GET")
      response = { missions: exists ? [data.mission] : [] };
    else if (path === "/api/missions") {
      if (!session.root)
        return route.fulfill({
          status: 403,
          json: {
            error: {
              code: "HUMAN_VERIFICATION_REQUIRED",
              message: "Proof of Human required",
            },
          },
        });
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
          rootId: root.id,
          missionId: data.mission.id,
          agentEns: "task.human.eth",
          type: "SUBMIT_APPLICATION",
          capability: "application.submit",
          payload: { event: "ETHGlobal Tokyo" },
          reason: "Submit the prepared application",
          payloadHash: `0x${"a".repeat(64)}`,
          nonce: "nonce-fixture",
          expiresAt,
          createdAt,
        },
      ];
      data.assessment = {
        stateHash: `0x${"a".repeat(64)}`,
        questionVersion: "v1",
        modelVersion: "fixture",
        evaluatedAt: createdAt,
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
    } else if (path.endsWith("/approval/request")) {
      data.approvals = [approval("PENDING")];
      response = {
        approval: data.approvals[0],
        request: { ...worldRequest, action: "humanos-action" },
      };
    } else if (path.endsWith("/approval/verify")) {
      data.approvals = [approval("VERIFIED")];
      response = data;
    } else if (path.endsWith("/approval/cancel")) {
      data.mission.state = "REJECTED";
      data.approvals = [approval("CANCELLED")];
      data.events.push({
        id: "event-cancel",
        missionId: data.mission.id,
        actionId: data.actions[0]!.id,
        previousState: "AWAITING_APPROVAL",
        policyVersion: "v1",
        modelVersions: {},
        metadata: {},
        type: "APPROVAL_CANCELLED",
        actor: "human",
        nextState: "REJECTED",
        createdAt,
      });
      response = data;
    } else if (path.endsWith("/revoke")) {
      data.mission.state = "REVOKED";
      response = data;
    } else if (path.endsWith("/confirm"))
      return route.fulfill({
        status: 403,
        json: {
          error: {
            code: "FORBIDDEN",
            message: "Sensitive actions require fresh World verification.",
          },
        },
      });
    else if (path.endsWith("/execute")) {
      if (data.approvals[0]?.status !== "VERIFIED")
        return route.fulfill({
          status: 403,
          json: {
            error: {
              code: "APPROVAL_REQUIRED",
              message: "Verification required",
            },
          },
        });
      data.mission.state = "COMPLETED";
      data.receipts = [
        {
          id: "receipt-fixture",
          missionId: data.mission.id,
          idempotencyKey: "fixture",
          payloadHash: `0x${"a".repeat(64)}`,
          externalId: null,
          metadata: {},
          actionId: "action-fixture",
          status: "SUCCEEDED",
          executedAt: createdAt,
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
  await page.getByRole("button", { name: /^Send/ }).click();
  await page.getByRole("button", { name: "Authorize & create agent" }).click();
  await page.getByRole("button", { name: "Run mission", exact: true }).click();
}

export async function verifySyntheticAction(page: Page) {
  await page.getByRole("button", { name: "Verify sensitive action" }).click();
  await page
    .getByRole("dialog", { name: "Synthetic World verification" })
    .getByRole("button", { name: "Complete synthetic verification" })
    .click();
  await page.reload();
  await page
    .getByRole("region", { name: "Action review action-fixture" })
    .getByText("Review required · verified")
    .waitFor();
}
