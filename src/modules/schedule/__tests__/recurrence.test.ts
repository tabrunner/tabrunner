import { afterEach, describe, expect, it, vi } from "vitest";
import {
  describeRecurrence,
  nextFireAt,
  recurrenceFromArgs,
  validateRecurrence,
} from "../recurrence";
import type { Recurrence } from "../types";

/** Local wall-clock helper — the tests are written in the zone vitest pins. */
const at = (y: number, m: number, d: number, h = 0, min = 0) =>
  new Date(y, m - 1, d, h, min, 0, 0).getTime();

const hourOf = (ms: number) => new Date(ms).getHours();
const dayOf = (ms: number) => new Date(ms).getDay();

describe("once", () => {
  it("fires at its time, then never again", () => {
    const rec: Recurrence = { kind: "once", at: at(2026, 8, 20, 15, 0) };
    expect(nextFireAt(rec, at(2026, 8, 20, 14, 0))).toBe(at(2026, 8, 20, 15, 0));
    // Spent: the scheduler reads null as "delete the record".
    expect(nextFireAt(rec, at(2026, 8, 20, 15, 0))).toBeNull();
    expect(nextFireAt(rec, at(2026, 8, 21, 0, 0))).toBeNull();
  });
});

describe("daily", () => {
  const nine: Recurrence = { kind: "daily", time: "09:00" };

  it("takes today when the hour is still ahead, tomorrow once it has passed", () => {
    expect(nextFireAt(nine, at(2026, 8, 20, 7, 30))).toBe(at(2026, 8, 20, 9, 0));
    expect(nextFireAt(nine, at(2026, 8, 20, 9, 30))).toBe(at(2026, 8, 21, 9, 0));
  });

  it("stays at 9am across a DST shift — the whole reason this is not an interval", () => {
    // Two US transitions: 2026-11-01 (clocks back) and 2027-03-14 (forward).
    // An implementation adding 24h in milliseconds drifts to 8am or 10am here.
    let cursor = at(2026, 10, 28, 12, 0);
    for (let i = 0; i < 200; i++) {
      const next = nextFireAt(nine, cursor);
      expect(next).not.toBeNull();
      expect(hourOf(next as number)).toBe(9);
      cursor = (next as number) + 60_000;
    }
  });

  it("skips to the next allowed weekday", () => {
    // 2026-08-21 is a Friday; weekdays-only lands on Monday the 24th.
    const weekdays: Recurrence = { kind: "daily", time: "09:00", days: [1, 2, 3, 4, 5] };
    expect(nextFireAt(weekdays, at(2026, 8, 21, 10, 0))).toBe(at(2026, 8, 24, 9, 0));
  });

  it("is unsatisfiable with an empty day list rather than looping forever", () => {
    expect(nextFireAt({ kind: "daily", time: "09:00", days: [] }, at(2026, 8, 20))).toBeNull();
    expect(nextFireAt({ kind: "daily", time: "nope" }, at(2026, 8, 20))).toBeNull();
  });
});

describe("interval", () => {
  it("steps by its period when no window bounds it", () => {
    const hourly: Recurrence = { kind: "interval", everyMinutes: 60 };
    expect(nextFireAt(hourly, at(2026, 8, 20, 14, 0))).toBe(at(2026, 8, 20, 15, 0));
  });

  it("clamps into the window: before it opens, jump to the opening", () => {
    const rec: Recurrence = { kind: "interval", everyMinutes: 60, from: "09:00", to: "17:00" };
    expect(nextFireAt(rec, at(2026, 8, 20, 6, 0))).toBe(at(2026, 8, 20, 9, 0));
  });

  it("clamps into the window: past its close, jump to tomorrow's opening", () => {
    const rec: Recurrence = { kind: "interval", everyMinutes: 60, from: "09:00", to: "17:00" };
    // 16:40 + 60m = 17:40, past the close — the next fire is tomorrow at 09:00.
    expect(nextFireAt(rec, at(2026, 8, 20, 16, 40))).toBe(at(2026, 8, 21, 9, 0));
  });

  it("stays inside the window all day long", () => {
    const rec: Recurrence = { kind: "interval", everyMinutes: 60, from: "09:00", to: "17:00" };
    let cursor = at(2026, 8, 20, 8, 0);
    for (let i = 0; i < 50; i++) {
      const next = nextFireAt(rec, cursor) as number;
      expect(hourOf(next)).toBeGreaterThanOrEqual(9);
      expect(hourOf(next)).toBeLessThanOrEqual(17);
      cursor = next;
    }
  });

  it("honours a weekday filter alongside the window", () => {
    const rec: Recurrence = {
      kind: "interval",
      everyMinutes: 120,
      from: "09:00",
      to: "17:00",
      days: [1, 2, 3, 4, 5],
    };
    // Friday 16:30 → +2h is past the close, and the weekend is excluded.
    expect(nextFireAt(rec, at(2026, 8, 21, 16, 30))).toBe(at(2026, 8, 24, 9, 0));
    let cursor = at(2026, 8, 20, 9, 0);
    for (let i = 0; i < 40; i++) {
      const next = nextFireAt(rec, cursor) as number;
      expect(dayOf(next)).toBeGreaterThanOrEqual(1);
      expect(dayOf(next)).toBeLessThanOrEqual(5);
      cursor = next;
    }
  });
});

describe("hourly at a fixed local minute", () => {
  const hourly: Recurrence = { kind: "interval", everyMinutes: 60, minuteOfHour: 17 };

  afterEach(() => vi.unstubAllEnvs());

  it("takes the next matching minute strictly after now, even after a late fire", () => {
    expect(nextFireAt(hourly, at(2026, 8, 20, 14, 2))).toBe(at(2026, 8, 20, 14, 17));
    expect(nextFireAt(hourly, at(2026, 8, 20, 14, 17))).toBe(at(2026, 8, 20, 15, 17));
    expect(nextFireAt(hourly, at(2026, 8, 20, 14, 41))).toBe(at(2026, 8, 20, 15, 17));
    expect(nextFireAt(hourly, at(2026, 8, 20, 23, 30))).toBe(at(2026, 8, 21, 0, 17));
  });

  it("keeps elapsed intervals unchanged when the minute is omitted", () => {
    const elapsed: Recurrence = { kind: "interval", everyMinutes: 60 };
    expect(nextFireAt(elapsed, at(2026, 8, 20, 14, 41))).toBe(at(2026, 8, 20, 15, 41));
  });

  it("supports the first and last minute of an hour", () => {
    expect(nextFireAt({ ...hourly, minuteOfHour: 0 }, at(2026, 8, 20, 14, 41))).toBe(
      at(2026, 8, 20, 15, 0),
    );
    expect(nextFireAt({ ...hourly, minuteOfHour: 59 }, at(2026, 8, 20, 14, 41))).toBe(
      at(2026, 8, 20, 14, 59),
    );
  });

  it("never clamps to a window boundary that is not the chosen minute", () => {
    const window: Recurrence = { ...hourly, from: "09:30", to: "17:00" };
    expect(nextFireAt(window, at(2026, 8, 20, 7, 0))).toBe(at(2026, 8, 20, 10, 17));
    expect(nextFireAt(window, at(2026, 8, 20, 16, 17))).toBe(at(2026, 8, 21, 10, 17));
    expect(nextFireAt({ ...hourly, from: "09:17", to: "10:17" }, at(2026, 8, 20, 9, 0))).toBe(
      at(2026, 8, 20, 9, 17),
    );
    expect(nextFireAt({ ...hourly, to: "09:17" }, at(2026, 8, 20, 9, 0))).toBe(
      at(2026, 8, 20, 9, 17),
    );
    expect(nextFireAt({ ...hourly, from: "09:30" }, at(2026, 8, 20, 7, 0))).toBe(
      at(2026, 8, 20, 10, 17),
    );
  });

  it("honors weekdays and reports windows with no matching minute", () => {
    const weekdays: Recurrence = {
      ...hourly,
      from: "09:00",
      to: "17:00",
      days: [1, 2, 3, 4, 5],
    };
    expect(nextFireAt(weekdays, at(2026, 8, 21, 16, 30))).toBe(at(2026, 8, 24, 9, 17));
    expect(nextFireAt({ ...hourly, days: [] }, at(2026, 8, 20))).toBeNull();
    expect(nextFireAt({ ...hourly, from: "09:20", to: "09:30" }, at(2026, 8, 20))).toBeNull();
  });

  it.each([
    { zone: "Asia/Kolkata", offset: "+05:30" },
    { zone: "Asia/Kathmandu", offset: "+05:45" },
  ])("keeps the local minute in $zone instead of aligning to UTC", ({ zone, offset }) => {
    vi.stubEnv("TZ", zone);
    expect(nextFireAt(hourly, Date.parse(`2026-08-20T14:02:00${offset}`))).toBe(
      Date.parse(`2026-08-20T14:17:00${offset}`),
    );
  });

  it("skips a spring-forward hour instead of normalizing its time", () => {
    vi.stubEnv("TZ", "America/New_York");
    expect(nextFireAt(hourly, Date.parse("2027-03-14T01:30:00-05:00"))).toBe(
      Date.parse("2027-03-14T03:17:00-04:00"),
    );
    expect(
      nextFireAt(
        { ...hourly, from: "02:00", to: "02:30" },
        Date.parse("2027-03-14T01:30:00-05:00"),
      ),
    ).toBe(Date.parse("2027-03-15T02:17:00-04:00"));
  });

  it("fires once in the repeated autumn hour", () => {
    vi.stubEnv("TZ", "America/New_York");
    expect(nextFireAt(hourly, Date.parse("2026-11-01T00:30:00-04:00"))).toBe(
      Date.parse("2026-11-01T01:17:00-04:00"),
    );
    expect(nextFireAt(hourly, Date.parse("2026-11-01T01:17:00-04:00"))).toBe(
      Date.parse("2026-11-01T02:17:00-05:00"),
    );
    expect(nextFireAt(hourly, Date.parse("2026-11-01T01:05:00-05:00"))).toBe(
      Date.parse("2026-11-01T02:17:00-05:00"),
    );
  });

  it("rejects partial-hour DST normalization in Lord Howe", () => {
    vi.stubEnv("TZ", "Australia/Lord_Howe");
    expect(nextFireAt(hourly, Date.parse("2026-10-04T01:30:00+10:30"))).toBe(
      Date.parse("2026-10-04T03:17:00+11:00"),
    );
    expect(
      nextFireAt({ ...hourly, minuteOfHour: 40 }, Date.parse("2026-10-04T01:45:00+10:30")),
    ).toBe(Date.parse("2026-10-04T02:40:00+11:00"));
  });

  it("skips the second copy of a repeated half-hour in Lord Howe", () => {
    vi.stubEnv("TZ", "Australia/Lord_Howe");
    const minute40: Recurrence = { ...hourly, minuteOfHour: 40 };
    expect(nextFireAt(minute40, Date.parse("2026-04-05T01:00:00+11:00"))).toBe(
      Date.parse("2026-04-05T01:40:00+11:00"),
    );
    expect(nextFireAt(minute40, Date.parse("2026-04-05T01:40:00+11:00"))).toBe(
      Date.parse("2026-04-05T02:40:00+10:30"),
    );
    expect(nextFireAt(minute40, Date.parse("2026-04-05T01:35:00+10:30"))).toBe(
      Date.parse("2026-04-05T02:40:00+10:30"),
    );
  });

  it("describes the fixed minute separately from an elapsed hour", () => {
    expect(describeRecurrence(hourly)).toBe("Every hour at minute 17");
    expect(describeRecurrence({ ...hourly, minuteOfHour: 0 })).toBe("Every hour at minute 00");
    expect(describeRecurrence({ kind: "interval", everyMinutes: 60 })).toBe("Every 1h");
    const description = describeRecurrence({ ...hourly, from: "09:30", to: "17:00", days: [1, 5] });
    expect(description).toContain("Every hour at minute 17");
    expect(description).toContain("09:30");
    expect(description).toContain("Mon");
    expect(description).toContain("Fri");
  });
});

describe("validateRecurrence", () => {
  const now = at(2026, 8, 20, 12, 0);
  const ok = (rec: Recurrence) => expect(validateRecurrence(rec, now)).toBeUndefined();
  const rejects = (rec: Recurrence) => expect(validateRecurrence(rec, now)).toBeTruthy();

  it("accepts the shapes the agent is told to send", () => {
    ok({ kind: "once", at: at(2026, 8, 20, 15, 0) });
    ok({ kind: "daily", time: "09:00", days: [1, 2, 3, 4, 5] });
    ok({ kind: "interval", everyMinutes: 60, from: "09:00", to: "17:00" });
    ok({ kind: "interval", everyMinutes: 60, minuteOfHour: 0 });
    ok({ kind: "interval", everyMinutes: 60, minuteOfHour: 59 });
  });

  it("refuses invalid hourly minutes and minutes on a different rule", () => {
    for (const minuteOfHour of [-1, 60, 17.5, NaN, Infinity]) {
      rejects({ kind: "interval", everyMinutes: 60, minuteOfHour });
    }
    rejects({ kind: "interval", everyMinutes: 30, minuteOfHour: 17 });
    const wrongKind: Recurrence & { minuteOfHour: number } = {
      kind: "daily",
      time: "09:00",
      minuteOfHour: 17,
    };
    rejects(wrongKind);
  });

  it("refuses what would misfire, silently or forever", () => {
    rejects({ kind: "once", at: at(2026, 8, 20, 11, 0) }); // already past
    rejects({ kind: "daily", time: "25:00" });
    rejects({ kind: "daily", time: "09:00", days: [] });
    rejects({ kind: "interval", everyMinutes: 1 }); // under the alarm floor
    rejects({ kind: "interval", everyMinutes: 60, from: "17:00", to: "09:00" }); // inverted
  });
});

describe("recurrenceFromArgs", () => {
  it("reads what a model actually sends", () => {
    expect(recurrenceFromArgs({ kind: "once", at: "2026-08-20T15:00" })).toEqual({
      kind: "once",
      at: at(2026, 8, 20, 15, 0),
    });
    expect(recurrenceFromArgs({ kind: "daily", time: "09:00", days: [1, 5] })).toEqual({
      kind: "daily",
      time: "09:00",
      days: [1, 5],
    });
    // snake_case is what the tool schema advertises; camelCase is the slip.
    expect(recurrenceFromArgs({ kind: "interval", every_minutes: 30 })).toEqual({
      kind: "interval",
      everyMinutes: 30,
    });
    expect(recurrenceFromArgs({ kind: "interval", everyMinutes: 30 })).toEqual({
      kind: "interval",
      everyMinutes: 30,
    });
  });

  it("reads the fixed minute only from the advertised wire field", () => {
    expect(
      recurrenceFromArgs({
        kind: "interval",
        every_minutes: 60,
        minute_of_hour: 17,
        from: "09:00",
        to: "17:00",
        days: [1, 5],
      }),
    ).toEqual({
      kind: "interval",
      everyMinutes: 60,
      minuteOfHour: 17,
      from: "09:00",
      to: "17:00",
      days: [1, 5],
    });
    for (const minute_of_hour of [0, 59]) {
      expect(recurrenceFromArgs({ kind: "interval", every_minutes: 60, minute_of_hour })).toEqual({
        kind: "interval",
        everyMinutes: 60,
        minuteOfHour: minute_of_hour,
      });
    }
    expect(
      recurrenceFromArgs({ kind: "interval", every_minutes: 60, minuteOfHour: 17 }),
    ).toBeUndefined();
  });

  it("rejects invalid timing instead of dropping the fixed minute", () => {
    for (const minute_of_hour of [
      undefined,
      null,
      "17",
      true,
      [],
      {},
      -1,
      60,
      17.5,
      NaN,
      Infinity,
    ]) {
      expect(
        recurrenceFromArgs({ kind: "interval", every_minutes: 60, minute_of_hour }),
      ).toBeUndefined();
    }
    for (const every_minutes of [5, 30, 120, "60", null, undefined]) {
      expect(
        recurrenceFromArgs({ kind: "interval", every_minutes, minute_of_hour: 17 }),
      ).toBeUndefined();
    }
    expect(
      recurrenceFromArgs({ kind: "daily", time: "09:00", minute_of_hour: 17 }),
    ).toBeUndefined();
    expect(
      recurrenceFromArgs({ kind: "once", at: "2026-08-20T15:00", minute_of_hour: 17 }),
    ).toBeUndefined();
  });

  it("returns undefined rather than a half-built rule", () => {
    expect(recurrenceFromArgs(null)).toBeUndefined();
    expect(recurrenceFromArgs({ kind: "weekly" })).toBeUndefined();
    expect(recurrenceFromArgs({ kind: "once", at: "not a date" })).toBeUndefined();
    expect(recurrenceFromArgs({ kind: "daily" })).toBeUndefined();
    expect(recurrenceFromArgs({ kind: "interval" })).toBeUndefined();
  });
});
