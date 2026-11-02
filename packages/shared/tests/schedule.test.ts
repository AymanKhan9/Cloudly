import { test, expect } from "bun:test";
import { nextRun, describeSchedule, ScheduleSpecSchema, zonedTime } from "../src/schedule";

const at = (iso: string) => new Date(iso);
const iso = (d: Date) => d.toISOString();

test("daily, weekdays and weekly runs land on the wall-clock time in the schedule's zone", () => {
  const ny = { timeZone: "America/New_York", minuteOfDay: 9 * 60 };
  // Friday 2026-11-06 15:00 UTC is 10:00 in New York: today's 9:00 has passed.
  expect(iso(nextRun({ ...ny, frequency: "daily" }, at("2026-11-06T15:00:00Z")))).toBe("2026-11-07T14:00:00.000Z");
  // Weekdays skip the weekend to Monday.
  expect(iso(nextRun({ ...ny, frequency: "weekdays" }, at("2026-11-06T15:00:00Z")))).toBe("2026-11-09T14:00:00.000Z");
  // Weekly on Wednesday.
  expect(iso(nextRun({ ...ny, frequency: "weekly", weekday: 3 }, at("2026-11-06T15:00:00Z")))).toBe("2026-11-11T14:00:00.000Z");
  // Exactly at the time: the next one, not the same.
  expect(iso(nextRun({ ...ny, frequency: "daily" }, at("2026-11-07T14:00:00Z")))).toBe("2026-11-08T14:00:00.000Z");
});

test("daylight saving keeps the local time, and half-hour zones work", () => {
  const ny = { timeZone: "America/New_York", minuteOfDay: 9 * 60, frequency: "daily" as const };
  // US clocks go forward on 2026-03-08: 9:00 is 14:00 UTC before, 13:00 UTC after.
  expect(iso(nextRun(ny, at("2026-03-07T15:00:00Z")))).toBe("2026-03-08T13:00:00.000Z");
  expect(iso(nextRun(ny, at("2026-03-06T15:00:00Z")))).toBe("2026-03-07T14:00:00.000Z");
  // India is UTC+5:30.
  expect(iso(nextRun({ timeZone: "Asia/Kolkata", minuteOfDay: 18 * 60, frequency: "daily" }, at("2026-11-02T00:00:00Z")))).toBe("2026-11-02T12:30:00.000Z");
  // 02:30 doesn't exist on the spring-forward night; it runs right after the gap.
  expect(iso(new Date(zonedTime("America/New_York", 2026, 3, 8, 2, 30)))).toBe("2026-03-08T07:30:00.000Z");
});

test("hourly runs at the minute past each local hour", () => {
  const h = { timeZone: "Asia/Kolkata", minuteOfDay: 15, frequency: "hourly" as const };
  // 10:50 local (05:20 UTC): next is 11:15 local.
  expect(iso(nextRun(h, at("2026-11-02T05:20:00Z")))).toBe("2026-11-02T05:45:00.000Z");
  expect(iso(nextRun({ ...h, timeZone: "UTC" }, at("2026-11-02T23:30:00Z")))).toBe("2026-11-03T00:15:00.000Z");
});

test("specs are checked, and read back in words", () => {
  expect(ScheduleSpecSchema.safeParse({ frequency: "weekly", minuteOfDay: 60, timeZone: "UTC" }).success).toBe(false);
  expect(ScheduleSpecSchema.safeParse({ frequency: "daily", minuteOfDay: 60, timeZone: "Mars/Olympus" }).success).toBe(false);
  expect(ScheduleSpecSchema.safeParse({ frequency: "daily", minuteOfDay: 1440, timeZone: "UTC" }).success).toBe(false);
  expect(ScheduleSpecSchema.safeParse({ frequency: "weekly", weekday: 1, minuteOfDay: 60, timeZone: "Europe/London" }).success).toBe(true);
  expect(describeSchedule({ frequency: "weekdays", minuteOfDay: 9 * 60 })).toBe("Weekdays at 09:00");
  expect(describeSchedule({ frequency: "weekly", weekday: 1, minuteOfDay: 18 * 60 + 30 })).toBe("Mondays at 18:30");
  expect(describeSchedule({ frequency: "hourly", minuteOfDay: 5 })).toBe("Every hour at :05");
});
