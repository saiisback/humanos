import * as v from "valibot";
import {
  IdSchema,
  MissionStateSchema,
  PayloadSchema,
  TimestampSchema,
} from "./domain.js";
export const MissionEventSchema = v.picklist([
  "PROPOSE",
  "AUTHORIZE",
  "START",
  "REQUEST_APPROVAL",
  "APPROVE",
  "EXECUTE",
  "COMPLETE",
  "REJECT",
  "EXPIRE",
  "REVOKE",
  "FAIL",
  "RESUME",
]);
export type MissionEvent = v.InferOutput<typeof MissionEventSchema>;
export const AuditEventSchema = v.strictObject({
  id: IdSchema,
  missionId: IdSchema,
  actionId: v.nullable(IdSchema),
  type: IdSchema,
  actor: IdSchema,
  previousState: v.nullable(MissionStateSchema),
  nextState: v.nullable(MissionStateSchema),
  policyVersion: IdSchema,
  modelVersions: v.record(v.string(), v.string()),
  metadata: PayloadSchema,
  createdAt: TimestampSchema,
});
export type AuditEvent = v.InferOutput<typeof AuditEventSchema>;
