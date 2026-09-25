import { afterAll, beforeAll, expect, it } from "vitest";
import { Pool } from "pg";
import { createPersistence } from "../src/persistence.js";
const connectionString =
  process.env.TEST_DATABASE_URL ??
  "postgresql://saikarthik@127.0.0.1:55432/humanos";
const schema = "flue_recovery_" + Date.now();
const admin = new Pool({ connectionString });
beforeAll(async () => {
  await admin.query(`CREATE SCHEMA "${schema}"`);
});
afterAll(async () => {
  await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
  await admin.end();
});
it("accepted direct prompt survives pool restart and expired owner is reclaimable", async () => {
  const first = createPersistence(connectionString, schema);
  await first.migrate?.();
  const stores = await first.connect();
  const submission = await stores.submissionStore.admitDirect({
    kind: "direct",
    submissionId: "accepted-1",
    agent: "humanos",
    id: "mission-1",
    message: { kind: "user", body: "Prepare my application" },
    acceptedAt: new Date().toISOString(),
  });
  expect(submission.submissionId).toBe("accepted-1");
  await stores.submissionStore.markSubmissionCanonicalReady("accepted-1");
  const claim = {
    submissionId: "accepted-1",
    attemptId: "attempt-old",
    ownerId: "dead-process",
    leaseExpiresAt: Date.now() - 1000,
  };
  expect(await stores.submissionStore.claimSubmission(claim)).not.toBeNull();
  await first.close?.();
  const second = createPersistence(connectionString, schema);
  await second.migrate?.();
  try {
    const reopened = await second.connect();
    const persisted =
      await reopened.submissionStore.getSubmission("accepted-1");
    expect(persisted?.input.message).toEqual({
      kind: "user",
      body: "Prepare my application",
    });
    expect(await reopened.submissionStore.hasUnsettledSubmissions()).toBe(true);
    expect(
      (await reopened.submissionStore.listRunningSubmissions()).map(
        (s) => s.submissionId,
      ),
    ).toContain("accepted-1");
    expect(
      await reopened.submissionStore.requeueSubmission({
        submissionId: "accepted-1",
        attemptId: "attempt-old",
      }),
    ).toBe(true);
    expect(
      await reopened.submissionStore.claimSubmission({
        submissionId: "accepted-1",
        attemptId: "attempt-new",
        ownerId: "replacement-process",
        leaseExpiresAt: Date.now() + 30000,
      }),
    ).not.toBeNull();
  } finally {
    await second.close?.();
  }
});
