import type { WorkflowSchedule } from "@humanos/schemas";

export interface WorkflowOccurrence { at: string; logicalId: string }
interface Cron { minute: number; hour: number; day: number | null; weekdays: ReadonlySet<number> | null }

function parseCron(expression: string): Cron {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error("UNSUPPORTED_CRON");
  const [minuteField, hourField, dayField, monthField, weekdayField] = fields as [string, string, string, string, string];
  const integer = (value: string, min: number, max: number) => {
    if (!/^(0|[1-9]\d*)$/.test(value)) throw new Error("UNSUPPORTED_CRON");
    const parsed = Number(value);
    if (parsed < min || parsed > max) throw new Error("UNSUPPORTED_CRON");
    return parsed;
  };
  if (monthField !== "*") throw new Error("UNSUPPORTED_CRON");
  const day = dayField === "*" ? null : integer(dayField, 1, 31);
  let weekdays: ReadonlySet<number> | null = null;
  if (weekdayField !== "*") {
    const match = /^(\d)(?:-(\d))?$/.exec(weekdayField);
    if (!match) throw new Error("UNSUPPORTED_CRON");
    const from = integer(match[1]!, 0, 6), to = match[2] ? integer(match[2], 0, 6) : from;
    if (to < from) throw new Error("UNSUPPORTED_CRON");
    weekdays = new Set(Array.from({ length: to - from + 1 }, (_, index) => from + index));
  }
  if (day !== null && weekdays !== null) throw new Error("UNSUPPORTED_CRON");
  return { minute: integer(minuteField, 0, 59), hour: integer(hourField, 0, 23), day, weekdays };
}

function formatter(timezone: string): Intl.DateTimeFormat {
  try {
    return new Intl.DateTimeFormat("en-US-u-ca-gregory-nu-latn", {
      timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    });
  } catch { throw new Error("INVALID_TIMEZONE"); }
}
function local(format: Intl.DateTimeFormat, instant: number) {
  const parts = Object.fromEntries(format.formatToParts(new Date(instant)).map(({ type, value }) => [type, value]));
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day), hour: Number(parts.hour), minute: Number(parts.minute) };
}
function dateKey(year: number, month: number, day: number) { return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`; }
function occurrence(at: string, slot: string): WorkflowOccurrence { return { at, logicalId: `${slot}@${at}` }; }

/** The supported cron subset has fixed minute/hour, optional day-of-month or weekday (single/range), and wildcard month. */
export function nextOccurrence(schedule: WorkflowSchedule, after: Date): WorkflowOccurrence | null {
  if (!Number.isFinite(after.getTime())) throw new Error("INVALID_AFTER");
  const format = formatter(schedule.definition.timezone);
  if (schedule.definition.kind === "once") {
    const at = schedule.definition.fireAt;
    return Date.parse(at) > after.getTime() ? occurrence(at, at) : null;
  }
  const cron = parseCron(schedule.definition.expression);
  const start = local(format, after.getTime());
  const startDay = Date.UTC(start.year, start.month - 1, start.day);
  // 370 local dates bounds search and covers leap years and all supported day-of-month patterns.
  for (let dayOffset = 0; dayOffset <= 370; dayOffset++) {
    const date = new Date(startDay + dayOffset * 86_400_000);
    const year = date.getUTCFullYear(), month = date.getUTCMonth() + 1, day = date.getUTCDate();
    if (cron.day !== null && day !== cron.day) continue;
    if (cron.weekdays && !cron.weekdays.has(date.getUTCDay())) continue;
    const targetMinute = cron.hour * 60 + cron.minute;
    const naive = Date.UTC(year, month - 1, day, cron.hour, cron.minute);
    let exact: number | null = null;
    let gap: { instant: number; localMinute: number } | null = null;
    // Every IANA offset lies within +/-14h. Enumerate real instants so ambiguous minutes
    // choose their first occurrence, while nonexistent minutes advance within that local day.
    for (let instant = naive - 14 * 3_600_000; instant <= naive + 14 * 3_600_000; instant += 60_000) {
      const wall = local(format, instant);
      if (wall.year !== year || wall.month !== month || wall.day !== day) continue;
      const wallMinute = wall.hour * 60 + wall.minute;
      if (wallMinute === targetMinute) { exact ??= instant; continue; }
      if (wallMinute > targetMinute && (!gap || wallMinute < gap.localMinute || (wallMinute === gap.localMinute && instant < gap.instant))) gap = { instant, localMinute: wallMinute };
    }
    const chosen = exact ?? gap?.instant;
    if (chosen === undefined || chosen === null || chosen <= after.getTime()) continue;
    const at = new Date(chosen).toISOString();
    return occurrence(at, `${dateKey(year, month, day)}T${String(cron.hour).padStart(2, "0")}:${String(cron.minute).padStart(2, "0")}`);
  }
  return null;
}
