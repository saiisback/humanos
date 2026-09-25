import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { PermissionReview } from "./permission-review";
import { buildTranscript } from "../chat/mission-flow";
import type {
  JawPermissionReview,
  MissionDetailResponse,
} from "@humanos/schemas";
const address = "0x1111111111111111111111111111111111111111";
const review: JawPermissionReview = {
  id: "review",
  missionId: "mission",
  accountId: `11155111:${address}`,
  account: address,
  chainId: 11155111,
  spender: address,
  calls: [{ target: address, selector: "0xa9059cbb" }],
  spends: [{ token: address, allowance: "100", unit: "day", multiplier: 1 }],
  start: 1790294400,
  end: 1790380800,
  expiresAt: "2026-09-26T00:00:00.000Z",
  createdAt: "2026-09-25T00:00:00.000Z",
};
it("shows exact contract/function, base-unit allowance and expiry without claiming activation", () => {
  const html = renderToStaticMarkup(
    <PermissionReview review={review} grant={null} enabled={true} />,
  );
  for (const text of [
    "Grant permission",
    "Cancel",
    "Transfer tokens",
    address,
    "100 base units",
    "every 1 day",
    "Expires",
    "unavailable",
  ])
    expect(html).toContain(text);
});
it("only creates permission transcript objects from an actual server-reviewed mandate", () => {
  const detail: MissionDetailResponse = {
    mission: {
      id: "mission",
      rootId: "root",
      title: "Book",
      goal: "Book",
      capabilities: ["calendar.create", "value.transfer"],
      approvedCapabilities: ["calendar.create"],
      steps: [],
      state: "AUTHORIZED",
      agentEns: null,
      expiresAt: review.expiresAt,
      createdAt: review.createdAt,
      updatedAt: review.createdAt,
      policyVersion: "v1",
    },
    actions: [],
    approvals: [],
    receipts: [],
    events: [],
    assessment: null,
    decision: null,
  };
  expect(
    buildTranscript(detail, null).some((item) => item.kind === "permission"),
  ).toBe(false);
  expect(
    buildTranscript({ ...detail, permissionReviews: [review] }, null),
  ).toContainEqual(expect.objectContaining({ kind: "permission", review }));
});
