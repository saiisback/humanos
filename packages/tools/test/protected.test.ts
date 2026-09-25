import { describe, it, expect } from "vitest";
import {
  signEnvelope,
  verifyEnvelope,
  createSideEffectClient,
} from "../src/index.js";
const key = "test-key-that-is-at-least-32-bytes-long";
describe("protected downstream transport", () => {
  it("rejects payload substitution, expiry and wrong keys", () => {
    const body = {
      idempotencyKey: "a",
      actionId: "a",
      payload: { name: "Alice" },
      kind: "application",
      issuedAt: 1000,
    };
    const sig = signEnvelope(body, key);
    expect(verifyEnvelope(body, sig, key, 1000)).toBe(true);
    expect(
      verifyEnvelope({ ...body, payload: { name: "Bob" } }, sig, key, 1000),
    ).toBe(false);
    expect(verifyEnvelope(body, sig, "wrong", 1000)).toBe(false);
    expect(verifyEnvelope(body, sig, key, 61001)).toBe(false);
  });
  it("uses stable idempotency keys and reconciles timeouts before retry", async () => {
    let posts = 0;
    const client = createSideEffectClient({
      baseUrl: "http://localhost:3003",
      secret: key,
      fetch: async (url, init) => {
        if (init?.method === "POST") {
          posts++;
          throw new Error("timeout");
        }
        expect(String(url)).toContain("/receipts/a");
        return Response.json({
          externalId: "persisted",
          payloadHash: "hash",
          kind: "application",
        });
      },
    });
    expect(
      await client.execute({
        id: "a",
        payloadHash: "hash",
        payload: { name: "Alice" },
        type: "SUBMIT_APPLICATION",
      }),
    ).toEqual({
      externalId: "persisted",
      payloadHash: "hash",
      kind: "application",
    });
    expect(posts).toBe(1);
  });
  it("does not retry an ambiguous side effect", async () => {
    let posts = 0;
    const client = createSideEffectClient({
      baseUrl: "http://localhost:3003",
      secret: key,
      fetch: async (_url, init) => {
        if (init?.method === "POST") posts++;
        throw new Error("down");
      },
    });
    await expect(
      client.execute({
        id: "a",
        payloadHash: "hash",
        payload: {},
        type: "SUBMIT_APPLICATION",
      }),
    ).rejects.toThrow("RECONCILIATION_REQUIRED");
    expect(posts).toBe(1);
  });
});
it("rejects wrong-kind reconciliation and empty effect identifiers", async () => {
  for (const result of [
    { externalId: "x", payloadHash: "hash", kind: "calendar" },
    { externalId: "", payloadHash: "hash", kind: "application" },
  ]) {
    const client = createSideEffectClient({
      baseUrl: "http://localhost:3003",
      secret: key,
      fetch: async () => Response.json(result),
    });
    await expect(
      client.execute({
        id: "a",
        payloadHash: "hash",
        payload: {},
        type: "SUBMIT_APPLICATION",
      }),
    ).rejects.toThrow("RECONCILIATION_REQUIRED");
  }
});
