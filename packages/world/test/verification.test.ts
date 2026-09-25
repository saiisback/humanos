import { describe, it, expect } from "vitest";
import {
  createWorldVerifier,
  approvalBinding,
  verifyApprovalBinding,
  normalizeNullifier,
  WorldVerificationError,
} from "../src/index.js";
import { hashCanonical, type ActionProposal } from "@humanos/schemas";
const now = Date.parse("2026-09-24T00:00:00Z");
const request = {
  requestId: "req",
  action: "humanos-root",
  signal: "session-1",
  appId: "app_test",
  environment: "staging" as const,
  rpContext: {
    nonce: "0x123",
    expires_at: now / 1000 + 300,
    rp_id: "rp_test",
    created_at: now / 1000,
    signature: "sig",
  },
};
const proof = {
  protocol_version: "4.0",
  action: request.action,
  nonce: "0x123",
  environment: "staging",
  responses: [
    {
      identifier: "proof_of_human",
      issuer_schema_id: 1,
      nullifier: "0x01",
      signal_hash: "",
      proof: ["0x1", "0x2", "0x3", "0x4", "0x5"],
      expires_at_min: now / 60000 + 10,
    },
  ],
};
const success = {
  success: true,
  environment: "staging",
  results: [{ identifier: "proof_of_human", success: true }],
};
const config = {
  appId: "app_test",
  rpId: "rp_test",
  signingKey: "ab".repeat(32),
  environment: "staging" as const,
  clock: () => now,
};
async function sample() {
  const { hashSignal } = await import("@worldcoin/idkit-core/hashing");
  return {
    ...proof,
    responses: [
      { ...proof.responses[0], signal_hash: hashSignal(request.signal) },
    ],
  };
}
describe("official World verification boundary", () => {
  it("normalizes numeric nullifiers", () => {
    expect(normalizeNullifier("0x01")).toBe(normalizeNullifier("0x0001"));
    expect(() => normalizeNullifier("1")).toThrow();
  });
  it("forwards full payload to official verifier and validates Proof of Human result", async () => {
    let body = "";
    const verifier = createWorldVerifier({
      ...config,
      fetch: async (url, options) => {
        expect(String(url)).toBe(
          "https://developer.world.org/api/v4/verify/rp_test",
        );
        body = String(options?.body);
        return Response.json(success);
      },
    });
    const p = await sample();
    expect((await verifier.verify(request, p)).nullifier).toBe("1");
    expect(JSON.parse(body)).toEqual(p);
  });
  it.each(["action", "nonce", "environment"])(
    "rejects mismatched %s before upstream",
    async (key) => {
      let calls = 0;
      const v = createWorldVerifier({
        ...config,
        fetch: async () => {
          calls++;
          return Response.json(success);
        },
      });
      await expect(
        v.verify(request, { ...(await sample()), [key]: "wrong" }),
      ).rejects.toThrow();
      expect(calls).toBe(0);
    },
  );
  it("rejects unrelated successful proof, upstream false, wrong environment and unavailable", async () => {
    for (const response of [
      { ...success, results: [{ identifier: "passport", success: true }] },
      { ...success, success: false },
      { ...success, environment: "production" },
    ]) {
      const v = createWorldVerifier({
        ...config,
        fetch: async () => Response.json(response),
      });
      await expect(v.verify(request, await sample())).rejects.toThrow();
    }
    const v = createWorldVerifier({
      ...config,
      fetch: async () => {
        throw new Error("offline");
      },
    });
    await expect(v.verify(request, await sample())).rejects.toThrow();
  });
  it("classifies provider outage separately from an invalid proof", async () => {
    const p = await sample();
    const invalid = createWorldVerifier({
      ...config,
      fetch: async () => Response.json({ ...success, success: false }),
    });
    const unavailable = createWorldVerifier({
      ...config,
      fetch: async () => {
        throw new Error("network down");
      },
    });
    await expect(invalid.verify(request, p)).rejects.toMatchObject({
      reason: "invalid_proof",
    });
    await expect(unavailable.verify(request, p)).rejects.toMatchObject({
      reason: "unavailable",
    });
    expect(new WorldVerificationError().reason).toBe("invalid_proof");
  });
  it.each([429, 502, 503, 504])(
    "treats upstream HTTP %i as unavailable",
    async (status) => {
      const verifier = createWorldVerifier({
        ...config,
        fetch: async () => new Response(null, { status }),
      });
      await expect(
        verifier.verify(request, await sample()),
      ).rejects.toMatchObject({ reason: "unavailable" });
    },
  );
  it("rejects wrong signal, expired challenge, legacy and wrong human", async () => {
    const v = createWorldVerifier({
      ...config,
      fetch: async () => Response.json(success),
    });
    const p = await sample();
    await expect(
      v.verify(request, {
        ...p,
        responses: [{ ...p.responses[0], signal_hash: "0x0" }],
      }),
    ).rejects.toThrow();
    await expect(
      v.verify(
        {
          ...request,
          rpContext: { ...request.rpContext, expires_at: now / 1000 },
        },
        p,
      ),
    ).rejects.toThrow();
    await expect(
      v.verify(request, { ...p, protocol_version: "3.0" }),
    ).rejects.toThrow();
    await expect(v.verify(request, p, "2")).rejects.toThrow();
  });
  it("creates server signed fresh request, never exposing key", () => {
    const v = createWorldVerifier(config);
    const a = v.createRequest("humanos-root", "session-1");
    const b = v.createRequest("humanos-root", "session-1");
    expect(a.rpContext.nonce).not.toBe(b.rpContext.nonce);
    expect(JSON.stringify(a)).not.toContain(config.signingKey);
  });
});
describe("approval bindings", () => {
  const a: ActionProposal = {
    id: "a",
    rootId: "r",
    missionId: "m",
    agentEns: "task.human.eth",
    type: "SUBMIT_APPLICATION",
    capability: "application.submit",
    payload: { name: "Alice" },
    payloadHash: hashCanonical({ name: "Alice" }),
    nonce: "nonce",
    expiresAt: "2026-09-24T00:05:00Z",
    createdAt: "2026-09-24T00:00:00Z",
    reason: "Apply",
  };
  it("binds full action context and rejects payload substitution", () => {
    const b = approvalBinding(a);
    expect(verifyApprovalBinding(a, b, hashCanonical(b), now)).toBe(true);
    for (const field of [
      "rootId",
      "missionId",
      "agentEns",
      "nonce",
      "actionType",
      "expiresAt",
    ] as const) {
      expect(
        verifyApprovalBinding(
          a,
          { ...b, [field]: "changed" },
          hashCanonical({ ...b, [field]: "changed" }),
          now,
        ),
      ).toBe(false);
    }
    expect(
      verifyApprovalBinding(
        { ...a, payload: { name: "Bob" } },
        b,
        hashCanonical(b),
        now,
      ),
    ).toBe(false);
    expect(verifyApprovalBinding(a, b, hashCanonical(b), now + 300000)).toBe(
      false,
    );
  });
});
