import { randomUUID } from "node:crypto";
import { signRequest } from "@worldcoin/idkit-core/signing";
import { hashSignal } from "@worldcoin/idkit-core/hashing";
import {
  hashCanonical,
  type ActionProposal,
  type ApprovalBinding,
  type WorldProofRequest,
} from "@humanos/schemas";
export class WorldVerificationError extends Error {
  constructor(
    message = "World proof verification failed",
    public readonly reason: "invalid_proof" | "unavailable" = "invalid_proof",
  ) {
    super(message);
    this.name = "WorldVerificationError";
  }
}
export interface WorldConfig {
  appId: string;
  rpId: string;
  signingKey: string;
  environment: "staging" | "production";
  clock?: () => number;
  fetch?: typeof fetch;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new WorldVerificationError();
  return value as Record<string, unknown>;
}
export function normalizeNullifier(value: unknown): string {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{1,64}$/.test(value))
    throw new WorldVerificationError("Invalid nullifier");
  return BigInt(value).toString(10);
}
export function approvalBinding(action: ActionProposal): ApprovalBinding {
  return {
    rootId: action.rootId,
    agentEns: action.agentEns,
    missionId: action.missionId,
    actionType: action.type,
    payloadHash: action.payloadHash,
    nonce: action.nonce,
    expiresAt: action.expiresAt,
  };
}
export function verifyApprovalBinding(
  action: ActionProposal,
  binding: ApprovalBinding,
  bindingHash: string,
  now: number,
): boolean {
  try {
    return (
      Date.parse(action.expiresAt) > now &&
      hashCanonical(action.payload) === action.payloadHash &&
      hashCanonical(binding) === bindingHash &&
      hashCanonical(approvalBinding(action)) === bindingHash
    );
  } catch {
    return false;
  }
}
export function createWorldVerifier(config: WorldConfig) {
  const transport = config.fetch ?? fetch;
  const clock = config.clock ?? Date.now;
  if (
    !/^app_/.test(config.appId) ||
    !/^rp_/.test(config.rpId) ||
    !config.signingKey
  )
    throw new WorldVerificationError("World configuration required");
  return {
    createRequest(action: string, signal: string): WorldProofRequest {
      const signed = signRequest({
        signingKeyHex: config.signingKey,
        action,
        ttl: 300,
      });
      return {
        requestId: randomUUID(),
        action,
        signal,
        appId: config.appId,
        environment: config.environment,
        rpContext: {
          rp_id: config.rpId,
          nonce: signed.nonce,
          signature: signed.sig,
          created_at: signed.createdAt,
          expires_at: signed.expiresAt,
        },
      };
    },
    async verify(
      expected: WorldProofRequest,
      payload: unknown,
      expectedNullifier?: string,
    ): Promise<{ nullifier: string; nullifierHash: `0x${string}` }> {
      const proof = object(payload);
      if (
        expected.environment !== config.environment ||
        expected.appId !== config.appId ||
        expected.rpContext.rp_id !== config.rpId ||
        typeof expected.rpContext.expires_at !== "number" ||
        expected.rpContext.expires_at * 1000 <= clock()
      )
        throw new WorldVerificationError("Expired or mismatched challenge");
      if (
        proof.protocol_version !== "4.0" ||
        proof.action !== expected.action ||
        proof.nonce !== expected.rpContext.nonce ||
        proof.environment !== config.environment ||
        !Array.isArray(proof.responses) ||
        proof.responses.length !== 1
      )
        throw new WorldVerificationError("Proof context mismatch");
      const item = object(proof.responses[0]);
      if (
        item.identifier !== "proof_of_human" ||
        item.issuer_schema_id !== 1 ||
        !Array.isArray(item.proof) ||
        item.proof.length !== 5 ||
        item.proof.some(
          (x) => typeof x !== "string" || !/^0x[0-9a-fA-F]+$/.test(x),
        ) ||
        typeof item.signal_hash !== "string" ||
        BigInt(item.signal_hash) !== BigInt(hashSignal(expected.signal))
      )
        throw new WorldVerificationError("Proof of Human required");
      if (
        typeof item.expires_at_min !== "number" ||
        !Number.isInteger(item.expires_at_min) ||
        item.expires_at_min * 60000 <= clock()
      )
        throw new WorldVerificationError("Expired proof");
      const nullifier = normalizeNullifier(item.nullifier);
      if (expectedNullifier !== undefined && nullifier !== expectedNullifier)
        throw new WorldVerificationError("Proof belongs to another human");
      let response: Response;
      try {
        response = await transport(
          `https://developer.world.org/api/v4/verify/${encodeURIComponent(config.rpId)}`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(15000),
            redirect: "error",
          },
        );
      } catch {
        throw new WorldVerificationError(
          "World verification unavailable",
          "unavailable",
        );
      }
      if (!response.ok)
        throw new WorldVerificationError(
          "World verification failed",
          response.status === 429 || response.status >= 500
            ? "unavailable"
            : "invalid_proof",
        );
      let result: Record<string, unknown>;
      try {
        result = object(await response.json());
      } catch {
        throw new WorldVerificationError(
          "World verification unavailable",
          "unavailable",
        );
      }
      if (
        result.success !== true ||
        result.environment !== config.environment ||
        !Array.isArray(result.results) ||
        !result.results.some((raw) => {
          const r = object(raw);
          return r.identifier === "proof_of_human" && r.success === true;
        })
      )
        throw new WorldVerificationError();
      return {
        nullifier,
        nullifierHash: hashCanonical({
          rpId: config.rpId,
          environment: config.environment,
          nullifier,
        }),
      };
    },
  };
}
