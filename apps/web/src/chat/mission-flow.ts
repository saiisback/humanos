import type {
  MissionDetailResponse,
  Readiness,
  ActionProposal,
} from "@humanos/schemas";
import type { TranscriptItem } from "./types";

const label = (value: string) =>
  value.toLowerCase().replaceAll("_", " ").replaceAll(".", " ");
function actionEffect(action: ActionProposal): string {
  const payload = action.payload;
  const target = ["to", "recipient", "target", "address", "url"]
    .map((key) => payload[key])
    .find((value) => typeof value === "string");
  const subject = ["subject", "title", "summary", "amount", "value"]
    .map((key) => payload[key])
    .find((value) => typeof value === "string" || typeof value === "number");
  return `${label(action.type)}${target ? ` to ${target}` : ""}${subject ? ` · ${subject}` : ""}. ${action.reason}`;
}

export function buildTranscript(
  detail: MissionDetailResponse | null,
  _readiness: Readiness | null,
): TranscriptItem[] {
  if (!detail) return [];
  const {
    mission,
    actions,
    approvals,
    receipts,
    events,
    assessment,
    decision,
  } = detail;
  const items: TranscriptItem[] = [
    {
      kind: "human",
      id: `goal-${mission.id}`,
      text: mission.goal,
      at: mission.createdAt,
    },
    { kind: "agent", id: `intro-${mission.id}`, text: mission.title },
    { kind: "mandate", id: `mandate-${mission.id}`, mission },
  ];
  if (mission.agentEns)
    items.push({
      kind: "ens",
      id: `ens-${mission.id}`,
      name: mission.agentEns,
      expiresAt: mission.expiresAt,
    });
  if (["RUNNING", "AWAITING_APPROVAL", "EXECUTING"].includes(mission.state))
    items.push({
      kind: "progress",
      id: `progress-${mission.id}`,
      text: `Mission ${label(mission.state)}. Review current server state below.`,
    });
  for (const event of events)
    items.push({
      kind: "progress",
      id: `event-${event.id}`,
      text: `${label(event.type)} · ${event.nextState ? label(event.nextState) : "audit recorded"}`,
    });
  for (const action of actions) {
    const receipt = receipts.find((item) => item.actionId === action.id);
    const approval =
      [...approvals].reverse().find((item) => item.actionId === action.id) ??
      null;
    if (receipt) {
      items.push({
        kind: "receipt",
        id: `receipt-${receipt.id}`,
        receipt,
        terminal: true,
      });
    } else if (
      ["COMPLETED", "REJECTED", "EXPIRED", "REVOKED", "FAILED"].includes(
        mission.state,
      )
    ) {
      items.push({
        kind: "denial",
        id: `closed-${action.id}`,
        text: `Action ${label(action.type)} is closed because this mission is ${label(mission.state)}.`,
        terminal: true,
      });
    } else if (
      approval &&
      ["DENIED", "CANCELLED", "EXPIRED"].includes(approval.status)
    ) {
      items.push({
        kind: "denial",
        id: `denial-${approval.id}`,
        text: `Action ${label(approval.status)}. No execution receipt was issued.`,
        terminal: true,
      });
    } else {
      items.push({
        kind: "approval",
        id: `approval-${action.id}`,
        action,
        approval,
        effect: actionEffect(action),
        payloadHash: action.payloadHash,
        assessment,
        decision,
      });
    }
  }
  for (const receipt of receipts.filter(
    (item) => !actions.some((action) => action.id === item.actionId),
  ))
    items.push({
      kind: "receipt",
      id: `receipt-${receipt.id}`,
      receipt,
      terminal: true,
    });
  if (["REJECTED", "REVOKED", "EXPIRED", "FAILED"].includes(mission.state))
    items.push({
      kind: "denial",
      id: `terminal-${mission.id}`,
      text: `This mission is ${label(mission.state)}. Further execution is blocked by the server.`,
      terminal: true,
    });
  else if (mission.state === "COMPLETED")
    items.push({
      kind: "progress",
      id: `complete-${mission.id}`,
      text: "Mission completed according to the server. Inspect receipts for individual effects.",
      terminal: true,
    });
  return items;
}
