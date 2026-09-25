import { afterAll, describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { createDemoService } from "../src/app.js";
import { signEnvelope } from "@humanos/tools";
import { hashCanonical } from "@humanos/schemas";
const secret = "test-key-that-is-at-least-32-bytes-long";
const service = await createDemoService({
  databaseUrl:
    process.env.TEST_DATABASE_URL ??
    "postgresql://saikarthik@127.0.0.1:55432/humanos",
  secret,
});
afterAll(() => service.close());
describe("persistent protected submission endpoint", () => {
  it("rejects unsigned submissions", async () => {
    expect(
      (
        await service.app.request("/effects", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        })
      ).status,
    ).toBe(401);
  });
  it("persists one effect across concurrent retry and rejects substitution", async () => {
    const id = randomUUID();
    const body = {
      idempotencyKey: id,
      actionId: id,
      kind: "application",
      payload: { name: "Test participant" },
      payloadHash: hashCanonical({ name: "Test participant" }),
      issuedAt: Date.now(),
    };
    const submit = (b: typeof body) =>
      service.app.request("/effects", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-humanos-authorization": signEnvelope(b, secret),
        },
        body: JSON.stringify(b),
      });
    const responses = await Promise.all(
      Array.from({ length: 5 }, () => submit(body)),
    );
    expect(responses.every((r) => r.status === 200)).toBe(true);
    const values = await Promise.all(responses.map((r) => r.json()));
    expect(new Set(values.map((r) => r.externalId)).size).toBe(1);
    expect(
      (
        await submit({
          ...body,
          payload: { name: "Other" },
          payloadHash: hashCanonical({ name: "Other" }),
        })
      ).status,
    ).toBe(409);
  });
});
