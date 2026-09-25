import {
  matchesJawReview,
  normalizeWalletAddress,
  parseJawReview,
  parseJawSdkPermission,
  type JawPermissionGrant,
  type JawPermissionReview,
} from "@humanos/schemas";
import type { RequestProvider } from "../auth/jaw";

interface PermissionBackend {
  record(grant: JawPermissionGrant): Promise<unknown>;
  revoke(permissionId: string): Promise<unknown>;
}
export type PermissionOutcome =
  | { status: "CANCELLED" }
  | { status: "RECORDED"; result: unknown }
  | { status: "RECONCILIATION_REQUIRED"; permissionId?: string };
function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
function cancelled(value: unknown): boolean {
  const record = object(value);
  return (
    record?.code === 4001 ||
    record?.code === "4001" ||
    object(record?.error)?.code === 4001 ||
    object(record?.error)?.code === "4001"
  );
}
export function createJawPermissionClient(
  provider: RequestProvider,
  backend: PermissionBackend,
  address: string,
) {
  const account = normalizeWalletAddress(address);
  return {
    async grant(input: JawPermissionReview): Promise<PermissionOutcome> {
      const review = parseJawReview(input);
      if (
        review.account !== account ||
        review.end * 1000 <= Date.now() ||
        review.start > Math.floor(Date.now() / 1000) ||
        review.start + 300 < Math.floor(Date.now() / 1000)
      )
        throw new Error(
          "Permission review is expired or belongs to another account.",
        );
      let permissionId: string | undefined;
      let walletResponded = false;
      try {
        const response = await provider.request({
          method: "wallet_grantPermissions",
          params: [
            {
              address: account,
              chainId: "0xaa36a7",
              expiry: review.end,
              spender: review.spender,
              permissions: { calls: review.calls, spends: review.spends },
            },
          ],
        });
        if (cancelled(response)) return { status: "CANCELLED" };
        walletResponded = true;
        const returned = parseJawSdkPermission(response);
        permissionId = returned.permissionId;
        const grant: JawPermissionGrant = {
          ...review,
          ...returned,
          id: permissionId,
          reviewId: review.id,
          status: "UNVERIFIED",
          revokedAt: null,
        };
        if (
          !matchesJawReview(grant, review) ||
          returned.start > Math.floor(Date.now() / 1000) ||
          returned.end * 1000 <= Date.now()
        )
          throw new Error("PERMISSION_CONTEXT_MISMATCH");
        return { status: "RECORDED", result: await backend.record(grant) };
      } catch (error) {
        if (!walletResponded && cancelled(error))
          return { status: "CANCELLED" };
        // The SDK can fail after broadcasting. Do not imply no grant exists.
        return {
          status: "RECONCILIATION_REQUIRED",
          ...(permissionId ? { permissionId } : {}),
        };
      }
    },
    async list() {
      const response = await provider.request({
        method: "wallet_getPermissions",
        params: [{ address: account, chainId: "0xaa36a7" }],
      });
      if (!Array.isArray(response))
        throw new Error("Invalid JAW permission listing.");
      return response.map((input) => {
        const permission = parseJawSdkPermission(input);
        if (permission.account !== account)
          throw new Error("JAW permission account mismatch.");
        return permission;
      });
    },
    async revoke(permissionId: string): Promise<PermissionOutcome> {
      if (!/^0x[0-9a-f]{64}$/.test(permissionId))
        throw new Error("Invalid permission identifier.");
      let walletResponded = false;
      try {
        const response = await provider.request({
          method: "wallet_revokePermissions",
          params: [{ address: account, id: permissionId }],
        });
        if (cancelled(response)) return { status: "CANCELLED" };
        walletResponded = true;
        if (object(response)?.success !== true)
          return { status: "RECONCILIATION_REQUIRED", permissionId };
        return {
          status: "RECORDED",
          result: await backend.revoke(permissionId),
        };
      } catch (error) {
        return !walletResponded && cancelled(error)
          ? { status: "CANCELLED" }
          : { status: "RECONCILIATION_REQUIRED", permissionId };
      }
    },
  };
}
