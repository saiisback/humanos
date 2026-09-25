import { createHmac, timingSafeEqual } from "node:crypto";
import { canonicalize } from "@humanos/schemas";
export function signEnvelope(body: unknown, secret: string): string {
  if (secret.length < 32)
    throw new Error("Side-effect secret must contain at least 32 characters");
  return createHmac("sha256", secret).update(canonicalize(body)).digest("hex");
}
export function verifyEnvelope(
  body: unknown,
  signature: string,
  secret: string,
  now = Date.now(),
): boolean {
  try {
    const issuedAt = (body as { issuedAt: number }).issuedAt;
    if (
      !Number.isSafeInteger(issuedAt) ||
      issuedAt > now + 5000 ||
      now - issuedAt > 60000 ||
      !/^[a-f0-9]{64}$/.test(signature)
    )
      return false;
    return timingSafeEqual(
      Buffer.from(signEnvelope(body, secret), "hex"),
      Buffer.from(signature, "hex"),
    );
  } catch {
    return false;
  }
}
export interface EffectResult {
  externalId: string;
  payloadHash: string;
  kind: string;
}
export interface EffectAction {
  id: string;
  payloadHash: string;
  payload: unknown;
  type: string;
}
export function createSideEffectClient(config: {
  baseUrl: string;
  /** Exact private-network hostname opt-in; public transport should remain HTTPS. */
  allowHttpHost?: string;
  secret: string;
  fetch?: typeof fetch;
  clock?: () => number;
}) {
  const transport = config.fetch ?? fetch;
  const now = config.clock ?? Date.now;
  const base = new URL(config.baseUrl);
  if (
    base.protocol !== "https:" &&
    !(
      base.protocol === "http:" &&
      (["localhost", "127.0.0.1"].includes(base.hostname) ||
        (config.allowHttpHost !== undefined &&
          base.hostname === config.allowHttpHost))
    )
  )
    throw new Error("HTTPS required for downstream service");
  async function reconcile(action: EffectAction): Promise<EffectResult> {
    const auth = { idempotencyKey: action.id, issuedAt: now() };
    const r = await transport(
      new URL(`/receipts/${encodeURIComponent(action.id)}`, base),
      {
        headers: {
          "x-humanos-authorization": signEnvelope(auth, config.secret),
          "x-humanos-issued-at": String(auth.issuedAt),
        },
        signal: AbortSignal.timeout(10000),
        redirect: "error",
      },
    );
    if (!r.ok) throw new Error("RECONCILIATION_REQUIRED");
    const result = (await r.json()) as EffectResult;
    return validateEffectResult(action, result);
  }
  return {
    reconcile,
    async execute(action: EffectAction): Promise<EffectResult> {
      const kind =
        action.type === "SUBMIT_APPLICATION"
          ? "application"
          : action.type === "CREATE_CALENDAR_EVENT"
            ? "calendar"
            : null;
      if (!kind) throw new Error("Unsupported side effect");
      const body = {
        idempotencyKey: action.id,
        actionId: action.id,
        payloadHash: action.payloadHash,
        payload: action.payload,
        kind,
        issuedAt: now(),
      };
      try {
        const response = await transport(new URL("/effects", base), {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-humanos-authorization": signEnvelope(body, config.secret),
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(10000),
          redirect: "error",
        });
        if (!response.ok) throw new Error("Side effect response unconfirmed");
        const result = (await response.json()) as EffectResult;
        return validateEffectResult(action, result);
      } catch {
        try {
          return await reconcile(action);
        } catch {
          throw new Error("RECONCILIATION_REQUIRED");
        }
      }
    },
  };
}

/** Privileged transport only: expose the gateway/executor, never this client, to agents. */
export function validateEffectResult(
  action: EffectAction,
  value: unknown,
): EffectResult {
  const kind =
    action.type === "SUBMIT_APPLICATION"
      ? "application"
      : action.type === "CREATE_CALENDAR_EVENT"
        ? "calendar"
        : null;
  if (!kind || !value || typeof value !== "object" || Array.isArray(value))
    throw new Error("RECONCILIATION_REQUIRED");
  const result = value as Record<string, unknown>;
  if (
    Object.keys(result).sort().join(",") !== "externalId,kind,payloadHash" ||
    result.kind !== kind ||
    result.payloadHash !== action.payloadHash ||
    typeof result.externalId !== "string" ||
    !result.externalId.trim()
  )
    throw new Error("RECONCILIATION_REQUIRED");
  return {
    externalId: result.externalId,
    payloadHash: action.payloadHash,
    kind,
  };
}
export {
  createToolGateway,
  type ToolContext,
  type ToolGatewayDependencies,
} from "./gateway.js";
