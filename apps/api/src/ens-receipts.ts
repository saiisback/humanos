import * as v from "valibot";
import {
  canonicalize,
  hashCanonical,
  HexSchema,
  AgentAuthorizationSchema,
  ExecutionReceiptSchema,
  type Mission,
  type AgentAuthorization,
} from "@humanos/schemas";
import type { Database } from "@humanos/database";
import {
  createEnsPublicClient,
  loadEnsEnvConfig,
  readText,
  TEXT_KEYS,
  type createEnsAdapterFromEnv,
} from "@humanos/ens";
import type { ExecutionDependencies } from "./services/execute-sensitive-action.js";
type Publisher = NonNullable<ExecutionDependencies["updateEnsReceipt"]>;
export interface ReceiptAuthorization {
  authorization: AgentAuthorization;
  resolver: `0x${string}`;
  latestBlock: bigint;
  finalizedBlock: bigint;
}
export interface ReceiptPublisherIO {
  getMission(id: string): Promise<Mission | null>;
  readAuthorization(name: string): Promise<ReceiptAuthorization>;
  readRecord(input: {
    name: string;
    resolver: `0x${string}`;
    blockNumber: bigint;
  }): Promise<string>;
  writeRecord(mission: Mission, value: string): Promise<unknown>;
}
const MAX_RECORD_BYTES = 32768,
  MAX_ENTRIES = 128;
function parseLedger(text: string): Record<string, string> {
  if (text === "") return Object.create(null) as Record<string, string>;
  if (Buffer.byteLength(text, "utf8") > MAX_RECORD_BYTES)
    throw new Error("ENS_RECEIPT_LEDGER_TOO_LARGE");
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("ENS_RECEIPT_LEDGER_INVALID");
  }
  if (
    !raw ||
    typeof raw !== "object" ||
    Array.isArray(raw) ||
    Object.keys(raw).length > MAX_ENTRIES
  )
    throw new Error("ENS_RECEIPT_LEDGER_INVALID");
  const ledger = Object.create(null) as Record<string, string>;
  for (const [actionId, hash] of Object.entries(raw)) {
    if (
      !/^[a-zA-Z0-9_-]{1,256}$/.test(actionId) ||
      !v.safeParse(HexSchema, hash).success
    )
      throw new Error("ENS_RECEIPT_LEDGER_INVALID");
    ledger[actionId] = hash as string;
  }
  return ledger;
}
function assertAuthorized(
  details: ReceiptAuthorization,
  mission: Mission,
  name: string,
): void {
  const a = v.parse(AgentAuthorizationSchema, details.authorization);
  const now = Date.now();
  if (
    !a.active ||
    !a.finalized ||
    a.revoked ||
    a.rootId !== mission.rootId ||
    a.agentEns !== name ||
    mission.agentEns !== name ||
    ["REVOKED", "EXPIRED", "REJECTED"].includes(mission.state) ||
    Date.parse(mission.expiresAt) <= now ||
    Date.parse(a.expiresAt) <= now ||
    Date.parse(a.checkedAt) > now ||
    now - Date.parse(a.checkedAt) > 30000
  )
    throw new Error("ENS_RECEIPT_NOT_AUTHORIZED");
}
/** Caller must serialize a mission's receipt writers; executor already holds its mission row lock. */
export function createReceiptPublisher(io: ReceiptPublisherIO): Publisher {
  return async ({ agentEns, receiptHash, receipt }) => {
    v.parse(ExecutionReceiptSchema, receipt);
    v.parse(HexSchema, receiptHash);
    if (
      receipt.status !== "SUCCEEDED" ||
      !/^[a-zA-Z0-9_-]{1,256}$/.test(receipt.actionId)
    )
      throw new Error("INVALID_RECEIPT_COMMITMENT");
    const expected = hashCanonical({
      id: receipt.id,
      actionId: receipt.actionId,
      missionId: receipt.missionId,
      payloadHash: receipt.payloadHash,
      externalId: receipt.externalId,
      status: receipt.status,
    });
    if (expected !== receiptHash) throw new Error("INVALID_RECEIPT_COMMITMENT");
    const mission = await io.getMission(receipt.missionId);
    if (!mission) throw new Error("MISSION_NOT_FOUND");
    let details = await io.readAuthorization(agentEns);
    assertAuthorized(details, mission, agentEns);
    const read = (snapshot: ReceiptAuthorization, blockNumber: bigint) =>
      io
        .readRecord({
          name: agentEns,
          resolver: snapshot.resolver,
          blockNumber,
        })
        .then(parseLedger);
    let ledger = await read(details, details.latestBlock);
    function checkConflict(map: Record<string, string>) {
      if (
        Object.hasOwn(map, receipt.actionId) &&
        map[receipt.actionId] !== receiptHash
      )
        throw new Error("ENS_RECEIPT_CONFLICT");
    }
    checkConflict(ledger);
    if (!Object.hasOwn(ledger, receipt.actionId)) {
      // Refresh both authority and latest ledger immediately before the argument-scoped write.
      details = await io.readAuthorization(agentEns);
      assertAuthorized(details, mission, agentEns);
      ledger = await read(details, details.latestBlock);
      checkConflict(ledger);
      if (!Object.hasOwn(ledger, receipt.actionId)) {
        if (Object.keys(ledger).length >= MAX_ENTRIES)
          throw new Error("ENS_RECEIPT_LEDGER_FULL");
        ledger[receipt.actionId] = receiptHash;
        const value = canonicalize(ledger);
        if (Buffer.byteLength(value, "utf8") > MAX_RECORD_BYTES)
          throw new Error("ENS_RECEIPT_LEDGER_TOO_LARGE");
        await io.writeRecord(mission, value);
      }
    }
    // A mined transaction is insufficient: success requires the commitment visible at finalized.
    const confirmed = await io.readAuthorization(agentEns);
    assertAuthorized(confirmed, mission, agentEns);
    const finalLedger = await read(confirmed, confirmed.finalizedBlock);
    if (
      finalLedger[receipt.actionId] &&
      finalLedger[receipt.actionId] !== receiptHash
    )
      throw new Error("ENS_RECEIPT_CONFLICT");
    if (Object.entries(ledger).some(([id, hash]) => finalLedger[id] !== hash))
      throw new Error("ENS_RECEIPT_FINALITY_PENDING");
  };
}
export function createEnsReceiptPublisher(options: {
  db: Pick<Database, "get">;
  ensAdapter: Pick<
    ReturnType<typeof createEnsAdapterFromEnv>,
    "readAuthorizationDetails" | "writeAgentRecord"
  >;
  client?: ReturnType<typeof createEnsPublicClient>;
}): Publisher {
  const client =
    options.client ?? createEnsPublicClient(loadEnsEnvConfig(process.env));
  return createReceiptPublisher({
    getMission: (id) => options.db.get<Mission>("missions", id),
    readAuthorization: async (name) => {
      const result = await options.ensAdapter.readAuthorizationDetails(name);
      return {
        authorization: result.authorization,
        resolver: result.resolver,
        latestBlock: result.latestSnapshot.blockNumber,
        finalizedBlock: result.finalizedSnapshot.blockNumber,
      };
    },
    readRecord: ({ name, resolver, blockNumber }) =>
      readText(client, resolver, name, TEXT_KEYS.receipt, blockNumber),
    writeRecord: (mission, value) =>
      options.ensAdapter.writeAgentRecord(mission, "receipt", value),
  });
}
