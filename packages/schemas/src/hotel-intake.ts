/** Deterministic intake only: collecting details never authorizes a reservation. */
export const hotelFields = ["city", "checkIn", "checkOut", "guests", "rooms", "budget", "guestName", "email"] as const;
export type HotelField = typeof hotelFields[number];
export const hotelLabels: Record<HotelField, string> = {
  city: "City or area", checkIn: "Check-in date", checkOut: "Check-out date", guests: "Guests", rooms: "Rooms",
  budget: "Nightly budget (include currency)", guestName: "Guest’s full name", email: "Email",
};
const MARKER = "\n\n[Hotel details]\n";
type Details = Partial<Record<HotelField, string>>;
function source(goal: string): { original: string; saved: Details } {
  const cut = goal.indexOf(MARKER);
  if (cut < 0) return { original: goal, saved: {} };
  let saved: Details = {};
  try {
    const parsed: unknown = JSON.parse(goal.slice(cut + MARKER.length));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
      for (const key of hotelFields) {
        const value = (parsed as Record<string, unknown>)[key];
        if (typeof value === "string") saved[key] = value;
      }
  } catch { /* Invalid appended data grants no capability; collect details again. */ }
  return { original: goal.slice(0, cut), saved };
}
function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value + "T00:00:00Z");
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
function unique(values: string[]): string | undefined {
  const found = [...new Set(values)];
  return found.length === 1 ? found[0] : undefined;
}
function rawDetails(goal: string, now: Date): { isHotel: boolean; details: Details; original: string } {
  const { original, saved } = source(goal);
  const isHotel = /\b(hotel|accommodation)\b/i.test(original);
  const details: Details = {};
  if (/\bTokyo\b/i.test(original)) details.city = "Tokyo";
  const email = unique(original.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) ?? []);
  if (email) details.email = email;
  for (const [field, pattern] of [
    ["guests", /\b(\d+)\s+(?:adults?|guests?|people)\b/gi], ["rooms", /\b(\d+)\s+rooms?\b/gi],
  ] as const) {
    const count = unique([...original.matchAll(pattern)].map(match => match[1]!));
    if (count) details[field] = count;
  }
  const tokyoDate = (offset: number) => new Date(now.getTime() + (9 + 24 * offset) * 3600000).toISOString().slice(0, 10);
  for (const [field, label] of [["checkIn", "in"], ["checkOut", "out"]] as const) {
    const values = [...original.matchAll(new RegExp(`check[ -]?${label}\\s*(?:on|:|=)?\\s*(today|tomorrow|\\d{4}-\\d{2}-\\d{2})`, "gi"))].map(m => m[1]!.toLowerCase());
    values.push(...[...original.matchAll(new RegExp(`\\b(today|tomorrow)\\s+check[ -]?${label}\\b`, "gi"))].map(m => m[1]!.toLowerCase()));
    const value = unique(values);
    if (value && /^\d/.test(value)) details[field] = value;
    else if (value && (saved.city ?? details.city)?.toLowerCase() === "tokyo") details[field] = tokyoDate(value === "tomorrow" ? 1 : 0);
  }
  const range = /\bfrom\s+(today|tomorrow|\d{4}-\d{2}-\d{2})\s+to\s+(today|tomorrow|\d{4}-\d{2}-\d{2})\b/i.exec(original);
  if (range) for (const [field, position] of [["checkIn", 1], ["checkOut", 2]] as const) {
    const value = range[position]!.toLowerCase();
    if (/^\d/.test(value)) details[field] = value;
    else if ((saved.city ?? details.city)?.toLowerCase() === "tokyo") details[field] = tokyoDate(value === "tomorrow" ? 1 : 0);
  }
  const aliases: Record<string, HotelField> = { city: "city", area: "city", "check-in": "checkIn", "check in": "checkIn", "check-out": "checkOut", "check out": "checkOut", guests: "guests", adults: "guests", rooms: "rooms", budget: "budget", "guest name": "guestName", name: "guestName", email: "email" };
  const labelled = new Map<HotelField, string[]>();
  for (const line of original.split(/\r?\n/)) {
    const match = /^\s*([a-z -]+)\s*:\s*(.*)$/i.exec(line);
    const field = match && aliases[match[1]!.trim().toLowerCase()];
    if (field) labelled.set(field, [...(labelled.get(field) ?? []), match![2]!.trim()]);
  }
  for (const [field, values] of labelled) details[field] = unique(values) ?? "";
  if ((saved.city ?? details.city)?.toLowerCase() === "tokyo") for (const field of ["checkIn", "checkOut"] as const) {
    const value = details[field]?.toLowerCase();
    if (value === "today" || value === "tomorrow") details[field] = tokyoDate(value === "tomorrow" ? 1 : 0);
  }
  return { isHotel, original, details: { ...details, ...saved } };
}
export function hotelRequestText(goal: string): string { return source(goal).original; }
export function hotelIntake(goal: string, now: Date = new Date()) {
  const { isHotel, details: raw } = rawDetails(goal, now);
  const details: Details = {};
  for (const key of hotelFields) {
    const value = raw[key]?.trim();
    if (!value || value.length > 200 || /[\r\n\u0000-\u001f]/.test(value)) continue;
    if ((key === "checkIn" || key === "checkOut") && !validDate(value)) continue;
    if ((key === "guests" || key === "rooms") && !/^[1-9]\d?$/.test(value)) continue;
    if (key === "email" && !/^[^@\s]+@[^@\s]+\.[A-Za-z]{2,}$/.test(value)) continue;
    details[key] = value;
  }
  if (details.checkIn && details.checkOut && details.checkOut <= details.checkIn) delete details.checkOut;
  const missing = hotelFields.filter(key => !details[key]);
  const question = missing.length
    ? `For your hotel stay, what ${missing.slice(0, 2).map(key => hotelLabels[key].toLowerCase()).join(" and ")} would you like?`
    : "I have your stay details. A supported hotel-booking service is still needed; nothing has been booked.";
  return { isHotel, details, missing, question };
}
export function updateHotelDetails(goal: string, answers: Details, now: Date = new Date()): string {
  const raw = rawDetails(goal, now);
  if (!raw.isHotel) return goal;
  const details = { ...raw.details };
  for (const key of hotelFields) if (typeof answers[key] === "string") details[key] = answers[key]!.trim();
  return raw.original + MARKER + JSON.stringify(details);
}
