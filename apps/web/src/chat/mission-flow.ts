import type {
  MissionDetailResponse,
  Readiness,
  ActionProposal,
} from "@humanos/schemas";
import type { TranscriptItem } from "./types";

const label = (value: string) =>
  value.toLowerCase().replaceAll("_", " ").replaceAll(".", " ");
function readable(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (value && typeof value === "object") return JSON.stringify(value);
  return null;
}
function field(
  payload: ActionProposal["payload"],
  keys: string[],
): string | null {
  for (const key of keys) {
    const value = readable(payload[key]);
    if (value) return value;
  }
  return null;
}
function fields(payload: ActionProposal["payload"], keys: string[]) {
  return keys.flatMap((key) => {
    const value = readable(payload[key]);
    return value ? [{ key, value }] : [];
  });
}
function actionEffect(action: ActionProposal): string {
  const payload = action.payload;
  const transfer = action.type === "TRANSFER_VALUE";
  const application = action.type === "SUBMIT_APPLICATION";
  const recipient = action.type === "SEND_EMAIL" || transfer;
  const targets = fields(
    payload,
    application
      ? [
          "event",
          "application",
          "organization",
          "target",
          "url",
          "to",
          "recipient",
          "address",
        ]
      : [
          "to",
          "recipient",
          "destination",
          "target",
          "address",
          "event",
          "application",
          "organization",
          "url",
          "contract",
        ],
  );
  const amount = field(payload, ["amount", "value"]);
  const currency = field(payload, ["currency", "symbol", "asset", "token"]);
  const constraints = fields(payload, [
    "constraints",
    "spendLimit",
    "maxSpend",
    "limit",
    "allowedTargets",
    "allowedContracts",
    "restrictions",
  ]);
  const targetLabel = application
    ? "Application target"
    : recipient
      ? "Recipient"
      : "Target";
  const primary = targets[0];
  const parts = [
    label(action.type),
    primary ? `${targetLabel}: ${primary.value}` : `${targetLabel} unavailable`,
  ];
  for (const extra of targets.slice(1))
    if (extra.value !== primary?.value)
      parts.push(`${label(extra.key)}: ${extra.value}`);
  if (transfer || amount)
    parts.push(
      amount
        ? `Amount: ${amount}${currency ? ` ${currency}` : " (currency unavailable)"}`
        : "Amount unavailable",
    );
  if (transfer && !currency) parts.push("Currency unavailable");
  const value = readable(payload.value);
  if (value && value !== amount) parts.push(`Value: ${value}`);
  const title = field(payload, ["subject", "title", "summary"]);
  if (title) parts.push(`Description: ${title}`);
  parts.push(
    constraints.length
      ? `Constraints: ${constraints.map(({ key, value }) => `${label(key)} ${value}`).join("; ")}`
      : "Constraints unavailable",
  );
  parts.push(
    `Expires ${new Date(action.expiresAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}`,
  );
  if (action.reason) parts.push(action.reason);
  return parts.join(" · ");
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
      approval &&
      ["DENIED", "CANCELLED", "EXPIRED"].includes(approval.status)
    ) {
      items.push({
        kind: "denial",
        id: `denial-${approval.id}`,
        text: `Action ${label(approval.status)}. No execution receipt was issued.`,
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
