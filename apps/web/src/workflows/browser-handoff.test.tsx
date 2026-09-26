import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { BrowserHandoff, type BrowserBookingPreview } from "./browser-handoff";

const preview: BrowserBookingPreview = {
  venue: "Sakura Kitchen — a very long venue name that must wrap without hiding the price on mobile screens",
  origin: "https://book.example.com", date: "2026-10-02", time: "19:00", timezone: "Asia/Tokyo", guests: "2",
  name: "Ada Lovelace", contact: "ada@example.com", offer: "Counter seats", price: "JPY 1,000 deposit",
  terms: "Refundable until 24 hours before. After that the deposit is kept. ".repeat(5),
};
const render = (props: Partial<React.ComponentProps<typeof BrowserHandoff>>) =>
  renderToStaticMarkup(<BrowserHandoff state="preparing" accountLabel="0x1111…1111" {...props} />);

it("shows every material booking detail before final confirmation", () => {
  const html = render({ state: "awaiting_confirmation", preview });
  for (const value of ["Sakura Kitchen", "https://book.example.com", "2026-10-02", "19:00 (Asia/Tokyo)", "Ada Lovelace", "ada@example.com", "Counter seats", "JPY 1,000 deposit", "Refundable until"])
    expect(html).toContain(value);
  expect(html).toContain("overflow-wrap:anywhere");
  expect(render({ state: "awaiting_confirmation", preview: null })).toContain("can&#x27;t be confirmed");
});

it("an uncertain outcome never says booked", () => {
  const html = render({ state: "uncertain", reference: "R-ABC123" });
  expect(html).toContain("may or may not");
  expect(html).not.toMatch(/>Booked</);
  expect(html).not.toContain("R-ABC123");
});

it("unavailable runtime and missing sites never look connected", () => {
  expect(render({ state: "unavailable" })).toContain("Nothing was opened or booked");
  expect(render({ state: "disconnected" })).toContain("No inspected booking site");
});

it("asks for missing details and scopes handoff to the account without secrets", () => {
  expect(render({ state: "needs_details", missing: ["Party size", "Contact email"] })).toContain("<li>Contact email</li>");
  const handoff = render({ state: "needs_login" });
  expect(handoff).toContain("For 0x1111…1111 only");
  expect(handoff).toContain("never sees your password");
  expect(render({ state: "confirmed", reference: "R-ABC123" })).toContain("R-ABC123");
});

// --- Run-level view as mounted in WorkflowWorkspace's run card ---
import { readFileSync } from "node:fs";
import { RunBrowserHandoff, browserBookingView } from "./browser-handoff";
import type { WorkflowRunDetailResponse, WorkflowVersion } from "@humanos/schemas";

const version = (destination: string) => ({ id: "v1", graph: { nodes: [
  { id: "review", type: "human.confirm", blockVersion: "1.0.0", dependsOn: [], input: {}, capability: null, timeoutMs: 1000, maxAttempts: 1 },
  { id: "book", type: "browser.submit", blockVersion: "1.0.0", dependsOn: ["review"], input: { destination, payload: { name: "Ada" } }, capability: "application.submit", timeoutMs: 1000, maxAttempts: 3 },
] } }) as unknown as WorkflowVersion;
const runWith = (status: string, pauseReason: string | null = null, receipts: unknown[] = []) =>
  ({ run: { id: "r1", workflowVersionId: "v1", status, pauseReason }, steps: [], attempts: [], events: [], confirmations: [], receipts }) as unknown as WorkflowRunDetailResponse;
const browserUse = version("browser-use:fixture-restaurant");
const renderRun = (run: WorkflowRunDetailResponse, preview: unknown = null, v: WorkflowVersion = browserUse) =>
  renderToStaticMarkup(<RunBrowserHandoff run={run} version={v} preview={preview as never} accountLabel="11155111:0xabc" />);

it("is mounted in the workspace run card", () => {
  const source = readFileSync(new URL("./workspace.tsx", import.meta.url), "utf8");
  expect(source).toMatch(/import \{ RunBrowserHandoff \} from "\.\/browser-handoff"/);
  expect(source).toMatch(/<RunBrowserHandoff run=\{run\} version=\{detail\?\.versions\.find\(v => v\.id === run\.run\.workflowVersionId\)\} preview=\{preview\?\.preview \?\? null\}/);
});

it("renders nothing for runs that are not Browser Use bookings", () => {
  expect(renderRun(runWith("CONNECTION_REQUIRED", "Sign in"), null, version("recipe:harbor-table"))).toBe("");
  expect(browserBookingView(runWith("RUNNING"), undefined, null)).toBeNull();
});

it("shows missing booking details and login handoff from the durable pause reason", () => {
  const missing = renderRun(runWith("INPUT_REQUIRED", "Provide the party size, contact email for this booking."));
  expect(missing).toContain("More details needed");
  expect(missing).toContain("party size, contact email");
  const login = renderRun(runWith("CONNECTION_REQUIRED", "Sign in to the site in the HumanOS browser window, then resume."));
  expect(login).toContain("Your turn in the HumanOS browser");
  expect(login).toContain("For 11155111:0xabc only");
  expect(renderRun(runWith("CONNECTION_REQUIRED", "No inspected site policy is installed for this booking site. No page was opened."))).toContain("Booking site not connected");
  expect(renderRun(runWith("CONNECTION_REQUIRED", "The local Browser Use worker is not enabled on this HumanOS server."))).toContain("Booking browser unavailable");
});

it("shows every prepared field before approval, and only a bound receipt counts as booked", () => {
  const preview = { destination: "http://fixture.humanos.test:8123/reserve",
    payload: { fields: { name: "Ada Lovelace", party_size: "2", email: "ada@example.com", slot: "1900" }, material: ["Sakura Kitchen", "Friday 19:00", "Refundable until 24h before"], value: { amount: "1000", currency: "JPY" }, materialHash: `0x${"a".repeat(64)}` },
    binding: { executor: "browser-use", policyId: "fixture-restaurant", site: "Fixture", origin: "http://fixture.humanos.test:8123" } };
  const html = renderRun(runWith("CONFIRMATION_REQUIRED"), preview);
  for (const text of ["Confirm this exact booking", "Ada Lovelace", "party size", "ada@example.com", "1900", "Sakura Kitchen", "Refundable until 24h before", "JPY 1000", "http://fixture.humanos.test:8123/reserve"])
    expect(html).toContain(text);
  // A preview bound to a different executor is not shown as a booking preview.
  expect(renderRun(runWith("CONFIRMATION_REQUIRED"), { ...preview, binding: { executor: "resend" } })).toContain("can&#x27;t be confirmed");
  expect(renderRun(runWith("RECONCILIATION_REQUIRED", "UNKNOWN_OUTCOME"))).toContain("may or may not");
  expect(renderRun(runWith("COMPLETED", null, [{ providerReference: "R-ABC123", metadata: { executor: "browser-use" } }]))).toContain("R-ABC123");
  expect(renderRun(runWith("COMPLETED", null, []))).toBe("");
});

it("does not show a window handoff when the server browser has no visible window", () => {
  const html = renderRun(runWith("CONNECTION_REQUIRED", "The site needs you to sign in, but this server runs HumanOS with no visible browser window. Ask the operator to set HUMANOS_BROWSER_HEADLESS=false, then resume. Nothing was booked."));
  expect(html).toContain("Booking browser unavailable");
  expect(html).not.toContain("Your turn in the HumanOS browser");
  expect(renderRun(runWith("CONNECTION_REQUIRED", "Complete the site's check in the HumanOS browser window on this computer, then resume."))).toContain("Your turn in the HumanOS browser");
});
