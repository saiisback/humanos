import * as v from "valibot";
import {
  MissionSchema,
  AgentAuthorizationSchema,
  type Mission,
  type AgentAuthorization,
  type Capability,
} from "@humanos/schemas";
export function effectiveCapabilities(input: {
  mission: Mission;
  authorization: AgentAuthorization;
  now: Date;
  maxAuthorizationAgeMs?: number;
}): Capability[] {
  const { mission: m, authorization: a, now } = input;
  if (
    !v.safeParse(MissionSchema, m).success ||
    !v.safeParse(AgentAuthorizationSchema, a).success ||
    !Number.isFinite(now.getTime())
  )
    return [];
  const age = now.getTime() - Date.parse(a.checkedAt);
  if (
    !["AUTHORIZED", "RUNNING", "AWAITING_APPROVAL", "EXECUTING"].includes(
      m.state,
    ) ||
    !a.active ||
    a.revoked ||
    !a.finalized ||
    age < 0 ||
    age > (input.maxAuthorizationAgeMs ?? 30000) ||
    Date.parse(m.expiresAt) <= now.getTime() ||
    Date.parse(a.expiresAt) <= now.getTime() ||
    a.rootId !== m.rootId ||
    a.agentEns !== m.agentEns
  )
    return [];
  return [
    ...new Set(
      m.capabilities.filter(
        (c) => m.approvedCapabilities.includes(c) && a.capabilities.includes(c),
      ),
    ),
  ];
}
