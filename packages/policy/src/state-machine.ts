import {
  MissionStateSchema,
  MissionEventSchema,
  type MissionState,
  type MissionEvent,
} from "@humanos/schemas";
import { PolicyError } from "./errors.js";
const edges: Partial<
  Record<MissionState, Partial<Record<MissionEvent, MissionState>>>
> = {
  DRAFT: { PROPOSE: "PROPOSED" },
  PROPOSED: { AUTHORIZE: "AUTHORIZED" },
  AUTHORIZED: { START: "RUNNING" },
  RUNNING: {
    REQUEST_APPROVAL: "AWAITING_APPROVAL",
    EXECUTE: "EXECUTING",
    COMPLETE: "COMPLETED",
  },
  AWAITING_APPROVAL: { APPROVE: "RUNNING" },
  EXECUTING: { RESUME: "RUNNING", COMPLETE: "COMPLETED" },
};
export function transition(
  state: MissionState,
  event: MissionEvent,
): MissionState {
  if (
    !MissionStateSchema.options.includes(state) ||
    !MissionEventSchema.options.includes(event)
  )
    throw new PolicyError("UNKNOWN_STATE_OR_EVENT");
  const row = edges[state];
  if (!row) throw new PolicyError("TERMINAL_STATE");
  const target =
    row[event] ??
    (
      {
        REJECT: "REJECTED",
        EXPIRE: "EXPIRED",
        REVOKE: "REVOKED",
        FAIL: "FAILED",
      } as Partial<Record<MissionEvent, MissionState>>
    )[event];
  if (!target) throw new PolicyError("ILLEGAL_TRANSITION");
  return target;
}
