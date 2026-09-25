import type { AgentConfig } from "./config.js";
export function canPrepareMission(
  mission: { state: string; agentEns: string | null; expiresAt: string } | null,
  now = Date.now(),
): boolean {
  return (
    !!mission &&
    mission.state === "RUNNING" &&
    !!mission.agentEns &&
    Date.parse(mission.expiresAt) > now
  );
}
export async function prepareNextAction(
  id: string,
  config: AgentConfig,
  transport: typeof fetch = fetch,
): Promise<unknown> {
  if (!config.internalSecret)
    throw new Error("FLUE_INTERNAL_SECRET is required");
  if (!/^[a-zA-Z0-9_-]{1,256}$/.test(id)) throw new Error("Invalid mission ID");
  const response = await transport(
    new URL(
      `/api/internal/missions/${encodeURIComponent(id)}/prepare`,
      config.apiUrl,
    ),
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.internalSecret}`,
        "content-type": "application/json",
      },
      body: "{}",
      redirect: "error",
      signal: AbortSignal.timeout(60000),
    },
  );
  if (!response.ok)
    throw new Error(`HumanOS preparation denied (${response.status})`);
  // Return only the review summary, never raw proof/session or provider credentials.
  const detail = (await response.json()) as {
    mission?: { id?: string; state?: string };
    actions?: unknown[];
  };
  return {
    missionId: detail.mission?.id,
    state: detail.mission?.state,
    actionCount: detail.actions?.length ?? 0,
    message:
      "Review the proposed action in HumanOS. Execution requires policy and human approval.",
  };
}
