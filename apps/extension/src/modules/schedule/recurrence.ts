import { i18n } from "@/i18n";
import type { Recurrence, Weekday } from "./types";

/**
 * The recurrence math, kept pure: no storage, no chrome APIs, no clock of its
 * own. Everything takes `after` explicitly, which is what makes the whole thing
 * testable against a fixed date — including the DST boundary that is the entire
 * reason this exists instead of `chrome.alarms.periodInMinutes`.
 */

/** How far ahead we will look for a fire before calling the rule unsatisfiable. */
const MAX_LOOKAHEAD_DAYS = 14;

/**
 * `chrome.alarms` resolves to roughly half a minute, and anything tighter than
 * this is a runaway rather than a schedule — a browser task that takes two
 * minutes cannot usefully run every one.
 */
export const MIN_INTERVAL_MINUTES = 5;

interface Clock {
  h: number;
  m: number;
}

function parseHHMM(value: string | undefined): Clock | undefined {
  if (!value) return undefined;
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(value.trim());
  if (!match) return undefined;
  return { h: Number(match[1]), m: Number(match[2]) };
}

/**
 * That wall-clock time on the local calendar day `d` falls in, `dayOffset` days
 * later. Going through the Date constructor (rather than adding milliseconds)
 * is what keeps 09:00 at 09:00 across a DST shift — the constructor resolves
 * local wall-clock, an offset arithmetic would land at 08:00 or 10:00.
 */
function atLocal(d: Date, clock: Clock, dayOffset = 0): number {
  return new Date(
    d.getFullYear(),
    d.getMonth(),
    d.getDate() + dayOffset,
    clock.h,
    clock.m,
    0,
    0,
  ).getTime();
}

function dayAllowed(ms: number, days: Weekday[] | undefined): boolean {
  return !days || days.includes(new Date(ms).getDay() as Weekday);
}

const MIDNIGHT: Clock = { h: 0, m: 0 };
const END_OF_DAY: Clock = { h: 23, m: 59 };

/**
 * The next fire strictly after `after`, or null when the rule can never fire
 * again — a `once` that has passed, or a day filter that excludes every day.
 * Null is the scheduler's cue to delete the record.
 */
export function nextFireAt(rec: Recurrence, after: number): number | null {
  if (rec.kind === "once") return rec.at > after ? rec.at : null;
  if (rec.days?.length === 0) return null;

  if (rec.kind === "daily") {
    const time = parseHHMM(rec.time);
    if (!time) return null;
    const base = new Date(after);
    for (let i = 0; i <= MAX_LOOKAHEAD_DAYS; i++) {
      const candidate = atLocal(base, time, i);
      if (candidate > after && dayAllowed(candidate, rec.days)) return candidate;
    }
    return null;
  }

  const from = parseHHMM(rec.from);
  const to = parseHHMM(rec.to);
  if (rec.minuteOfHour !== undefined) {
    if (
      rec.everyMinutes !== 60 ||
      !Number.isInteger(rec.minuteOfHour) ||
      rec.minuteOfHour < 0 ||
      rec.minuteOfHour > 59
    ) {
      return null;
    }
    const base = new Date(after);
    const opens = from ? from.h * 60 + from.m : 0;
    const closes = to ? to.h * 60 + to.m : 24 * 60 - 1;
    for (let day = 0; day <= MAX_LOOKAHEAD_DAYS; day++) {
      for (let h = 0; h < 24; h++) {
        const minute = h * 60 + rec.minuteOfHour;
        if (minute < opens || minute > closes) continue;
        const candidate = atLocal(base, { h, m: rec.minuteOfHour }, day);
        const local = new Date(candidate);
        // Date picks the first repeated hour. Reject gap normalization too,
        // including half-hour DST shifts that preserve the hour but not the minute.
        if (
          candidate > after &&
          local.getHours() === h &&
          local.getMinutes() === rec.minuteOfHour &&
          dayAllowed(candidate, rec.days)
        ) {
          return candidate;
        }
      }
    }
    return null;
  }

  const step = Math.max(1, Math.round(rec.everyMinutes)) * 60_000;
  let candidate = after + step;
  if (!from && !to && !rec.days) return candidate;

  // Walk the candidate forward: inside its day's window on an allowed day it
  // stands; before the window it jumps to the opening; past it (or on a day the
  // rule excludes) it jumps to tomorrow's opening and the check runs again.
  for (let i = 0; i <= MAX_LOOKAHEAD_DAYS; i++) {
    const day = new Date(candidate);
    const opens = atLocal(day, from ?? MIDNIGHT);
    const closes = atLocal(day, to ?? END_OF_DAY);
    if (dayAllowed(candidate, rec.days) && candidate >= opens && candidate <= closes) {
      return candidate;
    }
    candidate =
      dayAllowed(candidate, rec.days) && candidate < opens
        ? opens
        : atLocal(day, from ?? MIDNIGHT, 1);
  }
  return null;
}

/**
 * Whether a rule is coherent enough to store. The model writes these, so the
 * error it gets back has to name the fix — a rejected schedule that only says
 * "invalid" leaves it guessing at which field.
 */
export function validateRecurrence(rec: Recurrence, now: number): string | undefined {
  if (
    "minuteOfHour" in rec &&
    (rec.kind !== "interval" ||
      rec.everyMinutes !== 60 ||
      typeof rec.minuteOfHour !== "number" ||
      !Number.isInteger(rec.minuteOfHour) ||
      rec.minuteOfHour < 0 ||
      rec.minuteOfHour > 59)
  ) {
    return i18n.t("schedule.errors.badMinuteOfHour");
  }
  if (rec.kind === "once") {
    return rec.at > now ? undefined : i18n.t("schedule.errors.pastFire");
  }
  if (rec.days && (rec.days.length === 0 || rec.days.some((d) => d < 0 || d > 6))) {
    return i18n.t("schedule.errors.badDays");
  }
  if (rec.kind === "daily") {
    return parseHHMM(rec.time) ? undefined : i18n.t("schedule.errors.badTime", { value: rec.time });
  }
  if (!Number.isFinite(rec.everyMinutes) || rec.everyMinutes < MIN_INTERVAL_MINUTES) {
    return i18n.t("schedule.errors.tooFrequent", { min: MIN_INTERVAL_MINUTES });
  }
  for (const value of [rec.from, rec.to]) {
    if (value !== undefined && !parseHHMM(value)) {
      return i18n.t("schedule.errors.badTime", { value });
    }
  }
  const from = parseHHMM(rec.from);
  const to = parseHHMM(rec.to);
  if (from && to && to.h * 60 + to.m <= from.h * 60 + from.m) {
    return i18n.t("schedule.errors.badWindow");
  }
  return undefined;
}

/** "45m", "1h", "2h 30m" — a cadence, not a stopwatch (that's formatDuration). */
function formatEvery(minutes: number): string {
  const total = Math.max(1, Math.round(minutes));
  if (total < 60) return `${total}m`;
  const h = Math.floor(total / 60);
  const m = total % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

/** Short weekday names from the active locale — cheaper than 7 keys × 3 catalogs. */
function formatDays(days: Weekday[]): string {
  // 2024-01-07 was a Sunday, so the index IS the weekday.
  return days
    .slice()
    .sort((a, b) => a - b)
    .map((d) => new Date(2024, 0, 7 + d).toLocaleDateString(i18n.language, { weekday: "short" }))
    .join(", ");
}

function formatClock(value: string): string {
  const clock = parseHHMM(value);
  if (!clock) return value;
  return new Date(2024, 0, 1, clock.h, clock.m).toLocaleTimeString(i18n.language, {
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * The model's `recurrence` argument, read into a rule. Everything is checked
 * rather than trusted: this is the one place untyped JSON from a provider
 * becomes a record that will wake the browser up on its own.
 *
 * `once` takes a local datetime string ("2026-08-17T09:00") — the prompt hands
 * the model today's date, and JS parses that form as local time, which is what
 * a person means by "tomorrow at 9". An explicit Z or offset is honoured as sent.
 */
export function recurrenceFromArgs(raw: unknown): Recurrence | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const a = raw as Record<string, unknown>;
  if ("minuteOfHour" in a) return undefined;
  const hasMinute = "minute_of_hour" in a;
  const minuteOfHour = a.minute_of_hour;
  if (
    hasMinute &&
    (a.kind !== "interval" ||
      typeof minuteOfHour !== "number" ||
      !Number.isInteger(minuteOfHour) ||
      minuteOfHour < 0 ||
      minuteOfHour > 59)
  ) {
    return undefined;
  }
  const days = Array.isArray(a.days)
    ? (a.days.filter((d) => typeof d === "number" && d >= 0 && d <= 6) as Weekday[])
    : undefined;
  const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

  if (a.kind === "once") {
    const at = typeof a.at === "number" ? a.at : Date.parse(String(a.at ?? ""));
    return Number.isFinite(at) ? { kind: "once", at } : undefined;
  }
  if (a.kind === "daily") {
    const time = str(a.time);
    return time ? { kind: "daily", time, ...(days ? { days } : {}) } : undefined;
  }
  if (a.kind === "interval") {
    const rawMinutes = a.every_minutes ?? a.everyMinutes;
    const everyMinutes = Number(rawMinutes);
    if (
      !Number.isFinite(everyMinutes) ||
      (hasMinute && (typeof rawMinutes !== "number" || everyMinutes !== 60))
    ) {
      return undefined;
    }
    const from = str(a.from);
    const to = str(a.to);
    return {
      kind: "interval",
      everyMinutes,
      ...(typeof minuteOfHour === "number" ? { minuteOfHour } : {}),
      ...(from ? { from } : {}),
      ...(to ? { to } : {}),
      ...(days ? { days } : {}),
    };
  }
  return undefined;
}

/** The rule in the user's own words — the settings row and the agent's prompt. */
export function describeRecurrence(rec: Recurrence): string {
  if (rec.kind === "once") {
    return i18n.t("schedule.desc.once", {
      when: new Date(rec.at).toLocaleString(i18n.language, {
        dateStyle: "medium",
        timeStyle: "short",
      }),
    });
  }
  const onDays = rec.days?.length ? formatDays(rec.days) : "";
  if (rec.kind === "daily") {
    const time = formatClock(rec.time);
    return onDays
      ? i18n.t("schedule.desc.dailyDays", { days: onDays, time })
      : i18n.t("schedule.desc.daily", { time });
  }
  const every = formatEvery(rec.everyMinutes);
  const minute = rec.minuteOfHour?.toString().padStart(2, "0");
  const base =
    rec.from || rec.to
      ? i18n.t(
          minute !== undefined ? "schedule.desc.hourlyWindow" : "schedule.desc.intervalWindow",
          {
            every,
            minute,
            from: formatClock(rec.from ?? "00:00"),
            to: formatClock(rec.to ?? "23:59"),
          },
        )
      : i18n.t(minute !== undefined ? "schedule.desc.hourly" : "schedule.desc.interval", {
          every,
          minute,
        });
  return onDays ? i18n.t("schedule.desc.onDays", { base, days: onDays }) : base;
}
