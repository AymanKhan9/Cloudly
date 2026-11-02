import { z } from "zod";

// When a schedule next runs. Times are wall-clock times in the schedule's own
// time zone, so "weekdays at 9:00" stays 9:00 across daylight saving.

export const FREQUENCIES = ["hourly", "daily", "weekdays", "weekly"] as const;
export type Frequency = (typeof FREQUENCIES)[number];

export interface ScheduleSpec {
  frequency: Frequency;
  /** Minutes after midnight; for hourly, only the minutes past the hour count. */
  minuteOfDay: number;
  /** 0 = Sunday. Weekly only. */
  weekday?: number | null;
  timeZone: string;
}

export const ScheduleSpecSchema = z
  .object({
    frequency: z.enum(FREQUENCIES),
    minuteOfDay: z.number().int().min(0).max(1439),
    weekday: z.number().int().min(0).max(6).nullable().optional(),
    timeZone: z.string().min(1).max(64).refine(validTimeZone, "Unknown time zone"),
  })
  .refine((s) => s.frequency !== "weekly" || typeof s.weekday === "number", { message: "Pick a day of the week.", path: ["weekday"] });

export function validTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function localParts(tz: string, at: number) {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" });
    formatters.set(tz, f);
  }
  const p = Object.fromEntries(f.formatToParts(new Date(at)).map((x) => [x.type, x.value]));
  return { y: Number(p.year), m: Number(p.month), d: Number(p.day), h: Number(p.hour) % 24, mi: Number(p.minute), s: Number(p.second) };
}

/** How far the zone's wall clock is ahead of UTC at that moment, in ms. */
function offset(tz: string, at: number): number {
  const p = localParts(tz, at);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - Math.floor(at / 1000) * 1000;
}

/**
 * The moment a wall-clock time happens in a zone. Tries the zone's offset from
 * either side of any change that day: a time that happens twice (clocks going
 * back) is the first one, and a time that never happens (clocks going forward)
 * lands just after the gap.
 */
export function zonedTime(tz: string, y: number, m: number, d: number, h: number, mi: number): number {
  const wall = Date.UTC(y, m - 1, d, h, mi);
  const offsets = [...new Set([offset(tz, wall - 12 * 3600_000), offset(tz, wall + 12 * 3600_000)])];
  const matching = offsets
    .map((o) => wall - o)
    .filter((t) => {
      const p = localParts(tz, t);
      return p.h === h && p.mi === mi && p.d === d;
    });
  if (matching.length) return Math.min(...matching);
  return wall - Math.min(...offsets);
}

/** The first time the schedule runs strictly after `after`. */
export function nextRun(spec: ScheduleSpec, after: Date): Date {
  const t = after.getTime();
  const now = localParts(spec.timeZone, t);
  if (spec.frequency === "hourly") {
    const minute = spec.minuteOfDay % 60;
    for (let k = 0; k <= 26; k++) {
      const day = new Date(Date.UTC(now.y, now.m - 1, now.d, now.h + k));
      const at = zonedTime(spec.timeZone, day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), day.getUTCHours(), minute);
      if (at > t) return new Date(at);
    }
  } else {
    const hh = Math.floor(spec.minuteOfDay / 60);
    const mm = spec.minuteOfDay % 60;
    for (let k = 0; k <= 8; k++) {
      const day = new Date(Date.UTC(now.y, now.m - 1, now.d + k));
      const dow = day.getUTCDay();
      if (spec.frequency === "weekdays" && (dow === 0 || dow === 6)) continue;
      if (spec.frequency === "weekly" && dow !== spec.weekday) continue;
      const at = zonedTime(spec.timeZone, day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), hh, mm);
      if (at > t) return new Date(at);
    }
  }
  throw new Error("No next run found");
}

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const clock = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

/** "Weekdays at 09:00", "Every hour at :15", "Mondays at 18:30". */
export function describeSchedule(spec: Omit<ScheduleSpec, "timeZone">): string {
  switch (spec.frequency) {
    case "hourly":
      return `Every hour at :${String(spec.minuteOfDay % 60).padStart(2, "0")}`;
    case "daily":
      return `Every day at ${clock(spec.minuteOfDay)}`;
    case "weekdays":
      return `Weekdays at ${clock(spec.minuteOfDay)}`;
    case "weekly":
      return `${DAYS[spec.weekday ?? 1]}s at ${clock(spec.minuteOfDay)}`;
  }
}
