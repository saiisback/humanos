import type { BrowserUsePolicyRegistry } from "./browser-use-policy.js";

/**
 * Deterministic booking request parsing. Values come only from explicit "key: value"
 * lines in the user's request; nothing is inferred or invented by a model. Anything
 * missing or ambiguous is returned as missing so the user is asked.
 */
export interface BookingRequest {
  site: string;
  restaurant: string;
  date: string;
  time: string;
  timezone: string;
  partySize: string;
  reservationName: string;
  contact: string;
  budget: string;
}
export type BookingKey = keyof BookingRequest;
const REQUIRED: readonly BookingKey[] = ["site", "restaurant", "date", "time", "timezone", "partySize", "reservationName", "contact"];
const ALIASES: Record<string, BookingKey> = {
  site: "site", "booking site": "site", restaurant: "restaurant", venue: "restaurant", date: "date", time: "time",
  timezone: "timezone", "time zone": "timezone", "party size": "partySize", guests: "partySize", party: "partySize",
  name: "reservationName", "reservation name": "reservationName", contact: "contact", email: "contact", budget: "budget",
};

export function parseBookingRequest(input: string, now: Date = new Date()): { request: Partial<BookingRequest>; missing: BookingKey[]; invalid: BookingKey[] } {
  const request: Partial<BookingRequest> = {};
  const invalid = new Set<BookingKey>();
  const seen = new Map<BookingKey, string>();
  for (const line of input.split(/\r?\n/)) {
    const match = /^\s*([A-Za-z ]{2,24})\s*[:=]\s*(.{1,200})$/.exec(line);
    const key = match ? ALIASES[match[1]!.trim().toLowerCase()] : undefined;
    if (!key) continue;
    const value = match![2]!.trim();
    // The same detail given twice with different values is ambiguous, not "last wins".
    if (seen.has(key) && seen.get(key) !== value) invalid.add(key);
    seen.set(key, value);
    request[key] = value;
  }
  if (request.date !== undefined) {
    const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(request.date);
    const parsed = date ? new Date(Date.UTC(+date[1]!, +date[2]! - 1, +date[3]!)) : null;
    if (!parsed || parsed.toISOString().slice(0, 10) !== request.date || parsed.getTime() < Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - 86400000)
      invalid.add("date");
  }
  if (request.time !== undefined && !/^([01]\d|2[0-3]):[0-5]\d$/.test(request.time)) invalid.add("time");
  if (request.timezone !== undefined) {
    try { new Intl.DateTimeFormat("en", { timeZone: request.timezone }); if (!request.timezone.includes("/") && request.timezone !== "UTC") invalid.add("timezone"); }
    catch { invalid.add("timezone"); }
  }
  if (request.partySize !== undefined && !/^([1-9]|1\d|20)$/.test(request.partySize)) invalid.add("partySize");
  if (request.contact !== undefined && !/^[^@\s]+@[^@\s]+\.[A-Za-z]{2,}$/.test(request.contact)) invalid.add("contact");
  if (request.site !== undefined && !/^[a-z][a-z0-9-]{0,63}$/.test(request.site)) invalid.add("site");
  for (const key of invalid) delete request[key];
  return { request, missing: REQUIRED.filter(key => request[key] === undefined && !invalid.has(key)), invalid: [...invalid] };
}

/** A confirmation-gated browser.submit input for an inspected site policy, or the reason it can't be built. */
export function browserUseBookingPlan(request: Partial<BookingRequest>, policies: BrowserUsePolicyRegistry):
  { kind: "plan"; destination: string; payload: Record<string, string> } | { kind: "clarify"; message: string } {
  const policy = request.site ? policies.get(request.site) : null;
  if (!policy) {
    const known = policies.list().filter(p => !p.fixtureOnly).map(p => p.id);
    return { kind: "clarify", message: known.length
      ? `Choose a supported booking site: ${known.join(", ")}. Nothing was booked.`
      : "No booking site has been inspected and installed for HumanOS yet, so this booking can't be prepared. Nothing was booked." };
  }
  const payload: Record<string, string> = { name: request.reservationName ?? "", party_size: request.partySize ?? "", email: request.contact ?? "" };
  if (request.time) payload.preferred_time = request.time;
  return { kind: "plan", destination: `browser-use:${policy.id}`, payload };
}
