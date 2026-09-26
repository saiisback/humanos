import * as v from "valibot";

const text = v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(200), v.regex(/^[^\u0000-\u001f\u007f]+$/));
const date = v.pipe(text, v.regex(/^\d{4}-\d{2}-\d{2}$/), v.check(value => {
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}));
export const RestaurantBookingDetailsSchema = v.strictObject({
  siteId: v.literal("tablecheck-brooklyn-parlor"), venueId: v.literal("brooklynparlor-shinjuku"),
  date, time: v.pipe(text, v.regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/)), timezone: v.literal("Asia/Tokyo"),
  adults: v.pipe(text, v.regex(/^[1-5]$/)), children: v.pipe(text, v.regex(/^[0-5]$/)),
  guestFirstName: text, guestLastName: text, phone: v.pipe(text, v.regex(/^\+[1-9]\d{7,14}$/)),
  email: v.pipe(text, v.email()), allergies: text,
  offerId: v.literal("66c4d4411c588898fe3bb84b"), intent: v.picklist(["prepare", "book"]),
});
export type RestaurantBookingDetails = v.InferOutput<typeof RestaurantBookingDetailsSchema>;
export type RestaurantField = keyof RestaurantBookingDetails;
export const restaurantFields = Object.keys(RestaurantBookingDetailsSchema.entries) as RestaurantField[];
export const restaurantLabels: Record<RestaurantField, string> = {
  siteId: "Booking service", venueId: "Restaurant", date: "Date", time: "Time", timezone: "Timezone",
  adults: "Adults", children: "Children", guestFirstName: "First / given names", guestLastName: "Last / family name",
  phone: "Mobile number (with country code)", email: "Email", allergies: "Allergies (write none if none)", offerId: "Offer", intent: "Requested action",
};
const MARKER = "\n\n[Restaurant details]\n";
const aliases: Record<string, RestaurantField> = {
  date: "date", time: "time", timezone: "timezone", "time zone": "timezone", adults: "adults", children: "children",
  "first name": "guestFirstName", "given names": "guestFirstName", "last name": "guestLastName", "family name": "guestLastName",
  phone: "phone", "mobile number": "phone", email: "email", "contact email": "email", allergies: "allergies",
};
/** Only explicit labeled lines are parsed; prose never guesses a name split, date or country code. */
function explicitDetails(original: string) {
  const values: Record<string, string> = {};
  const conflicts = new Set<RestaurantField>();
  for (const line of original.split(/\r?\n/)) {
    const match = /^\s*([A-Za-z ]{2,30})\s*:\s*(.*?)\s*$/.exec(line);
    const key = match && aliases[match[1]!.toLowerCase().trim()];
    if (!key || !match) continue;
    const value = match[2]!;
    if (Object.hasOwn(values, key) && values[key] !== value) conflicts.add(key);
    values[key] = value;
  }
  return { values, conflicts };
}
function source(goal: string): { original: string; saved: Record<string, string> } {
  const cut = goal.indexOf(MARKER);
  if (cut < 0) return { original: goal, saved: {} };
  const saved: Record<string, string> = {};
  try {
    const parsed: unknown = JSON.parse(goal.slice(cut + MARKER.length));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
      for (const key of restaurantFields) {
        const value = (parsed as Record<string, unknown>)[key];
        if (typeof value === "string") saved[key] = value;
      }
  } catch { /* Invalid data is not executable; ask for the details again. */ }
  return { original: goal.slice(0, cut), saved };
}
export function restaurantRequestText(goal: string): string { return source(goal).original; }
export function restaurantIntake(goal: string, now: Date = new Date()): {
  isRestaurant: boolean; details: Partial<RestaurantBookingDetails>; missing: RestaurantField[]; invalid: RestaurantField[];
} {
  const { original, saved } = source(goal);
  const explicit = explicitDetails(original);
  const supplied = { ...explicit.values, ...saved };
  const isRestaurant = /\b(?:book|reserve|reservation|availability|prepare)\b/i.test(original) && /\b(?:restaurant|table|dinner|brooklyn parlor)\b/i.test(original);
  const details: Record<string, string> = {};
  const invalid: RestaurantField[] = [];
  const today = new Date(now.getTime() + 9 * 3600000).toISOString().slice(0, 10);
  for (const key of restaurantFields) {
    if (explicit.conflicts.has(key) && !Object.hasOwn(saved, key)) { invalid.push(key); continue; }
    const value = supplied[key]?.trim();
    if (!value) continue;
    const parsed = v.safeParse(RestaurantBookingDetailsSchema.entries[key], value);
    if (!parsed.success || key === "date" && value <= today) invalid.push(key);
    else details[key] = parsed.output;
  }
  if (details.date && details.time && Date.parse(`${details.date}T${details.time}:00+09:00`) <= now.getTime()) {
    invalid.push("time"); delete details.time;
  }
  if (details.adults && details.children && +details.adults + +details.children >= 6) {
    invalid.push("adults", "children"); delete details.adults; delete details.children;
  }
  return { isRestaurant, details: details as Partial<RestaurantBookingDetails>,
    missing: restaurantFields.filter(key => !details[key] && !invalid.includes(key)), invalid };
}
/** Saving answers is not approval and grants no external capability. */
export function updateRestaurantDetails(goal: string, answers: Partial<Record<RestaurantField, string>>): string {
  const { original, saved } = source(goal);
  for (const key of restaurantFields) if (typeof answers[key] === "string") saved[key] = answers[key]!.trim();
  return original + MARKER + JSON.stringify(saved);
}
