import { beforeEach, describe, expect, it, vi } from "vitest";
import { cancelSchedule, scheduleTask } from "../agent-tools";
import { listSchedules, saveSchedule, MAX_CHAIN, MAX_SCHEDULES } from "../store";
import type { Schedule } from "../types";

/**
 * The guards on unattended work. A scheduled run's plan auto-approves, so
 * `schedule_task` is the one tool that can commit the browser to more
 * auto-approved future work — these are the bounds that keep a self-paced loop
 * from becoming a runaway that spends the user's money overnight.
 */

beforeEach(() => {
  // The scheduler arms real alarms; nothing here cares what they hold, only
  // that the calls don't throw through the tool.
  (globalThis as Record<string, unknown>).chrome = {
    ...(globalThis.chrome as object),
    alarms: {
      create: () => Promise.resolve(),
      clear: () => Promise.resolve(true),
      getAll: () => Promise.resolve([]),
    },
  };
});

const daily = { kind: "daily", time: "09:00" };
const panel = { owner: "panel" };

async function seed(overrides: Partial<Schedule> = {}): Promise<Schedule> {
  const schedule: Schedule = {
    id: "s1",
    task: "check the inbox",
    recurrence: { kind: "daily", time: "09:00" },
    conversationId: "c1",
    nextFireAt: Date.now() + 3_600_000,
    createdAt: Date.now(),
    ...overrides,
  };
  await saveSchedule(schedule);
  return schedule;
}

describe("schedule_task from the panel", () => {
  it("creates a schedule in a conversation of its own", async () => {
    const res = await scheduleTask({ task: "summarize my inbox", recurrence: daily }, panel);
    expect(res.ok).toBe(true);

    const [stored] = await listSchedules();
    expect(stored?.task).toBe("summarize my inbox");
    // A 3am run must never land in the chat the user is reading.
    expect(stored?.conversationId).toBeTruthy();
    expect(stored?.nextFireAt).toBeGreaterThan(Date.now());
  });

  it("stores and arms a fixed hourly minute", async () => {
    const armed = vi.spyOn(chrome.alarms, "create");
    const res = await scheduleTask(
      {
        task: "check the inbox",
        recurrence: { kind: "interval", every_minutes: 60, minute_of_hour: 17 },
      },
      panel,
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data).toMatchObject({ recurrence: "Every hour at minute 17" });
    const [stored] = await listSchedules();
    expect(stored?.recurrence).toEqual({ kind: "interval", everyMinutes: 60, minuteOfHour: 17 });
    expect(new Date(stored!.nextFireAt).getMinutes()).toBe(17);
    expect(stored!.nextFireAt).toBeGreaterThan(Date.now());
    expect(armed).toHaveBeenCalledWith(`schedule:${stored!.id}`, { when: stored!.nextFireAt });
    armed.mockRestore();
  });

  it("rejects invalid fixed minutes with a useful error before storing or arming", async () => {
    const armed = vi.spyOn(chrome.alarms, "create");
    const invalid = [
      { kind: "interval", every_minutes: 60, minute_of_hour: "17" },
      { kind: "interval", every_minutes: 60, minute_of_hour: null },
      { kind: "interval", every_minutes: 60, minute_of_hour: 17.5 },
      { kind: "interval", every_minutes: 60, minute_of_hour: -1 },
      { kind: "interval", every_minutes: 60, minute_of_hour: 60 },
      { kind: "interval", every_minutes: 30, minute_of_hour: 17 },
      { kind: "daily", time: "09:00", minute_of_hour: 17 },
      { kind: "once", at: "2030-01-01T09:00", minute_of_hour: 17 },
      { kind: "interval", every_minutes: 60, minuteOfHour: 17 },
    ];
    for (const recurrence of invalid) {
      const res = await scheduleTask({ task: "check the inbox", recurrence }, panel);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toMatch(/minute_of_hour.*0 to 59/);
    }
    expect(await listSchedules()).toHaveLength(0);
    expect(armed).not.toHaveBeenCalled();
    armed.mockRestore();
  });

  it("refuses a rule that would misfire, and says which field", async () => {
    const past = await scheduleTask(
      { task: "x", recurrence: { kind: "once", at: "2020-01-01T09:00" } },
      panel,
    );
    expect(past.ok).toBe(false);
    expect(await listSchedules()).toHaveLength(0);

    const garbled = await scheduleTask({ task: "x", recurrence: { kind: "weekly" } }, panel);
    expect(garbled.ok).toBe(false);
    if (!garbled.ok) expect(garbled.error).toMatch(/once|daily|interval/);
  });

  it("stops at the cap rather than growing without bound", async () => {
    for (let i = 0; i < MAX_SCHEDULES; i++) {
      await seed({ id: `s${i}`, conversationId: `c${i}` });
    }
    const res = await scheduleTask({ task: "one more", recurrence: daily }, panel);
    expect(res.ok).toBe(false);
    expect(await listSchedules()).toHaveLength(MAX_SCHEDULES);
  });

  it("edits an existing schedule by id, and that releases the loop's leash", async () => {
    await seed({ chainCount: 7 });
    const res = await scheduleTask(
      { id: "s1", task: "check the inbox", recurrence: { kind: "daily", time: "07:30" } },
      panel,
    );
    expect(res.ok).toBe(true);

    const [stored] = await listSchedules();
    expect(stored?.recurrence).toMatchObject({ time: "07:30" });
    // The user touching a schedule is what resets the self-reschedule count.
    expect(stored?.chainCount).toBe(0);
    expect(await listSchedules()).toHaveLength(1);
  });
});

describe("schedule_task from a scheduled run", () => {
  it("may re-time its own schedule — that is the self-paced loop", async () => {
    await seed({ chainCount: 2 });
    const res = await scheduleTask(
      { task: "check again", recurrence: { kind: "interval", every_minutes: 20 } },
      { owner: "schedule", scheduleId: "s1" },
    );
    expect(res.ok).toBe(true);

    const [stored] = await listSchedules();
    expect(stored?.recurrence).toMatchObject({ kind: "interval", everyMinutes: 20 });
    expect(stored?.chainCount).toBe(3);
  });

  it("may NOT create a new schedule — an auto-approved run must not fan out", async () => {
    await seed();
    const res = await scheduleTask(
      { task: "something else entirely", recurrence: daily },
      { owner: "schedule", scheduleId: undefined },
    );
    expect(res.ok).toBe(false);
    expect(await listSchedules()).toHaveLength(1);
  });

  it("ignores an id argument pointing at somebody else's schedule", async () => {
    await seed({ id: "mine", conversationId: "c1", task: "my job" });
    await seed({ id: "theirs", conversationId: "c2", task: "someone else's job" });

    // The attack this guards: the run asks to rewrite a schedule it does not
    // own. `args.id` is not consulted at all for a scheduled caller — the run's
    // own scheduleId is the only target there is.
    const res = await scheduleTask(
      { id: "theirs", task: "hijacked", recurrence: daily },
      { owner: "schedule", scheduleId: "mine" },
    );
    expect(res.ok).toBe(true);

    const all = await listSchedules();
    expect(all.find((s) => s.id === "theirs")?.task).toBe("someone else's job");
    expect(all.find((s) => s.id === "mine")?.task).toBe("hijacked");
  });

  it("runs out of leash after MAX_CHAIN self-reschedules", async () => {
    await seed({ chainCount: MAX_CHAIN });
    const res = await scheduleTask(
      { task: "again", recurrence: { kind: "interval", every_minutes: 20 } },
      { owner: "schedule", scheduleId: "s1" },
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain(String(MAX_CHAIN));
  });
});

describe("cancel_schedule", () => {
  it("removes the record and reports what it was", async () => {
    await seed();
    const res = await cancelSchedule({ id: "s1" });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data).toMatchObject({ id: "s1", task: "check the inbox" });
    expect(await listSchedules()).toHaveLength(0);
  });

  it("is open to a scheduled run too — cancelling only ever removes work", async () => {
    await seed();
    // No caller bounds at all: this is how a self-paced loop ends itself.
    expect((await cancelSchedule({ id: "s1" })).ok).toBe(true);
  });

  it("says so rather than pretending, when the id is unknown", async () => {
    const res = await cancelSchedule({ id: "nope" });
    expect(res.ok).toBe(false);
    expect((await cancelSchedule({ id: "" })).ok).toBe(false);
  });
});
