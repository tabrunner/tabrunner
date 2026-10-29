import { describe, it, expect } from "vitest";

// Storage stand-in and i18n come from src/test-setup.ts (vitest setupFiles).

import {
  getSchedule,
  listSchedules,
  saveSchedule,
  schedulesForConversation,
  setSchedulePaused,
} from "../store";
import type { Recurrence, Schedule } from "../types";

let seq = 0;
function schedule(recurrence: Recurrence, conversationId = "c1"): Schedule {
  const id = `s${++seq}`;
  return {
    id,
    task: `task ${id}`,
    recurrence,
    conversationId,
    nextFireAt: Date.now() + 60_000,
    createdAt: Date.now(),
  };
}

const DAILY: Recurrence = { kind: "daily", time: "09:00" };

describe("schedulesForConversation", () => {
  it("finds every schedule writing into one thread, and nothing else", async () => {
    const mine = schedule(DAILY, "c-mine");
    await saveSchedule(mine);
    await saveSchedule(schedule(DAILY, "c-other"));

    const found = await schedulesForConversation("c-mine");
    expect(found.map((s) => s.id)).toEqual([mine.id]);
    expect(await schedulesForConversation("c-nobody")).toEqual([]);
  });
});

describe("setSchedulePaused", () => {
  it("holds the record and its thread — only the timer stops", async () => {
    const s = schedule(DAILY);
    await saveSchedule(s);

    const held = await setSchedulePaused(s.id, true);
    expect(held?.paused).toBe(true);
    // The rule, the task and the thread all survive — that is what makes pause
    // the answer to "stop it for now" that deleting cannot give.
    expect(held?.recurrence).toEqual(DAILY);
    expect(held?.conversationId).toBe(s.conversationId);
    expect((await listSchedules()).length).toBe(1);
  });

  it("recomputes the next fire from now on resume, never the stale one", async () => {
    const s = schedule(DAILY);
    // A next-fire from well in the past — what the record is left holding after
    // sitting paused. Arming this verbatim would fire the instant it resumes.
    s.nextFireAt = Date.now() - 5 * 86_400_000;
    await saveSchedule(s);
    await setSchedulePaused(s.id, true);

    const live = await setSchedulePaused(s.id, false);
    expect(live?.paused).toBe(false);
    expect(live?.nextFireAt).toBeGreaterThan(Date.now());
  });

  it("retires a one-shot whose moment passed while it was held", async () => {
    const s = schedule({ kind: "once", at: Date.now() + 60_000 });
    await saveSchedule(s);
    await setSchedulePaused(s.id, true);

    // Its `once` time is now behind us, so there is no next fire to resume to —
    // the same rule advanceSchedule follows: a spent record is deleted.
    s.recurrence = { kind: "once", at: Date.now() - 60_000 };
    await saveSchedule({ ...s, paused: true });

    expect(await setSchedulePaused(s.id, false)).toBeUndefined();
    expect(await getSchedule(s.id)).toBeUndefined();
  });

  it("says nothing happened when the schedule is already gone", async () => {
    expect(await setSchedulePaused("never-existed", true)).toBeUndefined();
  });
});
