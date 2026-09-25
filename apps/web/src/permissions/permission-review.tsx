import React, { useState } from "react";
import type { JawPermissionGrant, JawPermissionReview } from "@humanos/schemas";
import type {
  createJawPermissionClient,
  PermissionOutcome,
} from "./jaw-permissions";
export type JawPermissionClient = ReturnType<typeof createJawPermissionClient>;
const statuses = {
  ACTIVE:
    "Grant verified at recording. Execution requires a fresh server check.",
  UNVERIFIED:
    "Wallet grant recorded; independent verification is unavailable. Onchain execution is blocked.",
  REVOKED: "Revocation verified. This permission cannot authorize new effects.",
  EXPIRED: "This permission has expired. Onchain execution is blocked.",
  RECONCILIATION_REQUIRED:
    "The wallet outcome needs reconciliation. Onchain execution is blocked. Check the permission in JAW before trying again.",
};
const functions: Record<string, string> = {
  "0xa9059cbb": "Transfer tokens",
  "0x095ea7b3": "Approve token spending",
  "0x23b872dd": "Transfer tokens from an account",
  "0xe0e0e0e0": "Call with empty data",
};
export function PermissionReview({
  review,
  grant,
  enabled,
  client,
  onRecorded,
}: {
  review: JawPermissionReview;
  grant: JawPermissionGrant | null;
  enabled: boolean;
  client?: JawPermissionClient | undefined;
  onRecorded?: (() => Promise<void>) | undefined;
}) {
  const key = `humanos:jaw-pending:${review.accountId}:${review.id}`;
  const [local, setLocal] = useState<string>(() => {
    try {
      return sessionStorage.getItem(key) ? "RECONCILIATION_REQUIRED" : "";
    } catch {
      return "";
    }
  });
  const [busy, setBusy] = useState(false);
  async function operate(revoke: boolean) {
    if (!client || busy) return;
    setBusy(true);
    // An interrupted wallet/HTTP flow must not look safe to repeat after reload.
    try {
      sessionStorage.setItem(key, "pending");
    } catch {
      /* Storage may be disabled. */
    }
    let result: PermissionOutcome;
    try {
      result =
        revoke && grant
          ? await client.revoke(grant.permissionId)
          : await client.grant(review);
    } catch {
      result = { status: "RECONCILIATION_REQUIRED" };
    }
    if (result.status === "RECORDED") {
      try {
        await onRecorded?.();
        setLocal("");
        try {
          sessionStorage.removeItem(key);
        } catch {
          /* No storage. */
        }
      } catch {
        setLocal("RECONCILIATION_REQUIRED");
      }
    } else {
      setLocal(result.status);
      if (result.status === "CANCELLED") {
        try {
          sessionStorage.removeItem(key);
        } catch {
          /* No storage. */
        }
      }
    }
    setBusy(false);
  }
  const uncertain = local === "RECONCILIATION_REQUIRED";
  const closed = !enabled || review.end * 1000 <= Date.now();
  return (
    <section className="review-block" aria-label="Onchain permission review">
      <span className="eyebrow">JAW onchain permission</span>
      <h2>Review delegated calls and spending</h2>
      <p>
        Allow signer <span className="hash">{review.spender}</span> to make
        these calls on Sepolia:
      </p>
      <ul>
        {review.calls.map((call) => (
          <li key={`${call.target}:${call.selector}`}>
            <span className="hash">{call.target}</span> —{" "}
            {functions[call.selector] ?? "Contract function"} ({call.selector})
          </li>
        ))}
      </ul>
      <ul>
        {review.spends.map((spend) => (
          <li key={spend.token}>
            {spend.allowance} base units of{" "}
            <span className="hash">{spend.token}</span>,{" "}
            {spend.unit === "forever"
              ? "across the full permission lifetime"
              : `every ${spend.multiplier} ${spend.unit}`}
            .
          </li>
        ))}
      </ul>
      {!review.spends.length && <p>No token spending is permitted.</p>}
      <p>
        Expires {new Date(review.expiresAt).toLocaleString()}. No spender
        prefunding is requested.
      </p>
      <p className="fine">
        Onchain transfer execution is not implemented in this release.
      </p>
      <p role="status">
        {uncertain
          ? statuses.RECONCILIATION_REQUIRED
          : grant
            ? statuses[grant.status]
            : local === "CANCELLED"
              ? "Permission request cancelled. No grant was recorded."
              : closed
                ? "This review is no longer available."
                : "Review the exact scope before opening JAW."}
      </p>
      {!client && (
        <p role="status">JAW permissions are unavailable for this session.</p>
      )}
      <div className="actions">
        {!grant && !uncertain && local !== "CANCELLED" && (
          <>
            <button
              disabled={busy || closed || !client}
              onClick={() => void operate(false)}
            >
              Grant permission
            </button>
            <button
              className="secondary"
              disabled={busy}
              onClick={() => setLocal("CANCELLED")}
            >
              Cancel
            </button>
          </>
        )}
        {grant &&
          ["ACTIVE", "UNVERIFIED"].includes(grant.status) &&
          !uncertain && (
            <button
              className="secondary"
              disabled={busy || !client}
              onClick={() => void operate(true)}
            >
              Revoke permission
            </button>
          )}
      </div>
    </section>
  );
}
