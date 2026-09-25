import * as v from "valibot";
import {
  IdSchema,
  TimestampSchema,
  JsonValueSchema,
  RootIdentitySchema,
  WalletAccountSchema,
  RootAccountBindingSchema,
  JawPermissionGrantSchema,
  MissionSchema,
  ActionProposalSchema,
  ApprovalSchema,
  ExecutionReceiptSchema,
  AuditEventSchema,
  canonicalize,
} from "@humanos/schemas";
export const TABLES = [
  "roots",
  "accounts",
  "root_bindings",
  "jaw_permissions",
  "nullifiers",
  "sessions",
  "missions",
  "agents",
  "actions",
  "approvals",
  "receipts",
  "audit",
  "challenges",
] as const;
export type Table = (typeof TABLES)[number];
export function tableName(table: Table): string {
  if (!TABLES.includes(table)) throw new Error("UNKNOWN_TABLE");
  return '"' + table + '"';
}
export const SessionRecordSchema = v.objectWithRest(
  {
    id: IdSchema,
    accountId: IdSchema,
    rootId: v.nullable(IdSchema),
    expiresAt: TimestampSchema,
  },
  JsonValueSchema,
);
export type SessionRecord = v.InferOutput<typeof SessionRecordSchema>;
export const ChallengeRecordSchema = v.objectWithRest(
  {
    id: IdSchema,
    expiresAt: TimestampSchema,
    consumedAt: v.optional(v.nullable(TimestampSchema)),
  },
  JsonValueSchema,
);
export type ChallengeRecord = v.InferOutput<typeof ChallengeRecordSchema>;
const schemas: Partial<Record<Table, v.GenericSchema>> = {
  sessions: SessionRecordSchema,
  challenges: ChallengeRecordSchema,
  roots: RootIdentitySchema,
  accounts: WalletAccountSchema,
  root_bindings: RootAccountBindingSchema,
  jaw_permissions: JawPermissionGrantSchema,
  missions: MissionSchema,
  actions: ActionProposalSchema,
  approvals: ApprovalSchema,
  receipts: ExecutionReceiptSchema,
  audit: AuditEventSchema,
};
export function validateEntity<T extends { id: string }>(
  table: Table,
  entity: T,
): T {
  tableName(table);
  if (typeof entity.id !== "string" || !entity.id)
    throw new Error("INVALID_ID");
  canonicalize(entity);
  const schema = schemas[table];
  if (schema) v.parse(schema, entity);
  return entity;
}
