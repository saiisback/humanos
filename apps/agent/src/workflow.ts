import type { AgentConfig } from "./config.js";
/** Deterministic Flue command adapter. Never exposed as a content-model tool.
 * The API authenticates the forwarded session and remains the workflow authority. */
export async function assembleSavedWorkflow(id: string, cookie: string, config: AgentConfig, transport: typeof fetch = fetch): Promise<unknown> {
  if (!/^[a-zA-Z0-9_-]{1,256}$/.test(id) || !cookie || !config.internalSecret) throw new Error("WORKFLOW_AUTH_REQUIRED");
  const response = await transport(new URL(`/api/internal/workflows/${encodeURIComponent(id)}/assemble`, config.apiUrl), {
    method: "POST", headers: { cookie, authorization: `Bearer ${config.internalSecret}`, "Content-Type": "application/json" }, body: "{}", redirect: "error", signal: AbortSignal.timeout(60000),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: { code?: string } } | null;
    const allowed = ["REVIEW_REQUIRED", "NO_CANDIDATES", "MODEL_CREDITS_REQUIRED", "MODEL_AUTH_FAILED", "MODEL_RATE_LIMITED", "MODEL_TIMEOUT", "NOT_FOUND"];
    throw new Error(body?.error?.code && allowed.includes(body.error.code) ? body.error.code : "WORKFLOW_ASSEMBLY_UNAVAILABLE");
  }
  const value = await response.json() as { workflow?: { id?: string } };
  if (value.workflow?.id !== id) throw new Error("WORKFLOW_SCOPE_MISMATCH");
  return value;
}
