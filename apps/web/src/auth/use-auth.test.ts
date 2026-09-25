import { describe, expect, it, vi } from "vitest";
import { createAuthStore } from "./use-auth";
import type { JawAuthClient } from "./jaw";

const challenge = {
  challengeId: "c1",
  nonce: "abcd",
  domain: "localhost:5173",
  uri: "http://localhost:5173",
  chainId: 11155111,
  expiresAt: "2099-01-01T00:00:00.000Z",
};
const account = {
  id: "11155111:0x1111111111111111111111111111111111111111",
  address: "0x1111111111111111111111111111111111111111",
  chainId: 11155111,
  createdAt: "2026-09-25T00:00:00.000Z",
};
const signedOut = { account: null, root: null, jawConfigured: true };

describe("server-authoritative auth", () => {
  it("serializes concurrent sign-ins and refreshes the issued session", async () => {
    const calls: string[] = [];
    const request = vi.fn(async (path: string) => {
      calls.push(path);
      if (path.endsWith("/nonce")) return challenge;
      if (path.endsWith("/verify")) return { ...signedOut, account };
      return { ...signedOut, account };
    });
    const jaw: JawAuthClient = {
      connect: vi.fn(async () => ({ message: "signed", signature: "0x1234" })),
      disconnect: vi.fn(async () => {}),
    };
    const store = createAuthStore(jaw, request);
    await Promise.all([store.signIn(), store.signIn()]);
    expect(calls).toEqual([
      "/auth/siwe/nonce",
      "/auth/siwe/verify",
      "/auth/session",
    ]);
    expect(store.getSnapshot()).toMatchObject({ status: "signed-in", account });
  });

  it("keeps SDK disconnect failure independent of backend revocation", async () => {
    const request = vi.fn(async (path: string) =>
      path === "/auth/logout" ? signedOut : { ...signedOut, account },
    );
    const jaw: JawAuthClient = {
      connect: vi.fn(),
      disconnect: vi.fn().mockRejectedValue(new Error("SDK unavailable")),
    };
    const store = createAuthStore(jaw, request);
    await store.refresh();
    await store.signOut();
    expect(request).toHaveBeenCalledWith("/auth/logout", {});
    expect(store.getSnapshot()).toMatchObject({
      status: "signed-out",
      account: null,
    });
  });

  it("ignores a session refresh that resolves after logout", async () => {
    let resolveRefresh!: (value: unknown) => void;
    const request = vi.fn(async (path: string) => {
      if (path === "/auth/session")
        return await new Promise((resolve) => {
          resolveRefresh = resolve;
        });
      return signedOut;
    });
    const store = createAuthStore(null, request);
    const refresh = store.refresh();
    await store.signOut();
    resolveRefresh({ ...signedOut, account });
    await refresh;
    expect(store.getSnapshot()).toMatchObject({
      status: "signed-out",
      account: null,
    });
  });
  it("keeps the server account when logout fails", async () => {
    const request = vi.fn(async (path: string) => {
      if (path === "/auth/logout") throw new Error("Backend unavailable");
      return { ...signedOut, account };
    });
    const store = createAuthStore(null, request);
    await store.refresh();
    await expect(store.signOut()).rejects.toThrow("Backend unavailable");
    expect(store.getSnapshot()).toMatchObject({ status: "signed-in", account });
  });
  it("reports missing backend readiness", async () => {
    const store = createAuthStore(
      null,
      vi.fn(async () => ({ ...signedOut, jawConfigured: false })),
    );
    await store.refresh();
    expect(store.getSnapshot()).toMatchObject({
      status: "signed-out",
      jawConfigured: false,
    });
    await expect(store.signIn()).rejects.toMatchObject({ code: "UNAVAILABLE" });
  });
  it("does not send verify when JAW rejects the capability", async () => {
    const request = vi.fn(async (path: string) =>
      path === "/auth/siwe/nonce" ? challenge : signedOut,
    );
    const jaw: JawAuthClient = {
      connect: vi.fn().mockRejectedValue({ code: "MISSING_CAPABILITY" }),
      disconnect: vi.fn(),
    };
    const store = createAuthStore(jaw, request);
    await expect(store.signIn()).rejects.toMatchObject({
      code: "MISSING_CAPABILITY",
    });
    expect(
      request.mock.calls.some(([path]) => path === "/auth/siwe/verify"),
    ).toBe(false);
  });
});
