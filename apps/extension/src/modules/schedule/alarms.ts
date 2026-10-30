import { createLogger } from "@/lib/logger";
import type { Schedule } from "./types";

const log = createLogger("schedule");

/**
 * The alarm primitives, kept in a leaf of their own. `scheduler.ts` reaches
 * into the agent to actually start runs, so anything the agent's own tools need
 * — arming and clearing — has to live below that line or the import graph
 * closes a cycle (prompt → schedule → scheduler → start-run → prompt).
 */
const ALARM_PREFIX = "schedule:";

export function alarmNameFor(id: string): string {
  return `${ALARM_PREFIX}${id}`;
}

export function isScheduleAlarm(name: string): boolean {
  return name.startsWith(ALARM_PREFIX);
}

export function scheduleIdFromAlarm(name: string): string {
  return name.slice(ALARM_PREFIX.length);
}

/**
 * Points the alarm at the schedule's next fire. A time already in the past is
 * armed for a moment from now rather than dropped — that is the fire the
 * browser was closed for, and it is meant to run late.
 */
export async function armSchedule(schedule: Schedule): Promise<void> {
  try {
    await chrome.alarms.create(alarmNameFor(schedule.id), {
      when: Math.max(schedule.nextFireAt, Date.now() + 1_000),
    });
  } catch (e) {
    log.warn("could not arm schedule:", e instanceof Error ? e.message : String(e));
  }
}

/**
 * Drops the alarm, and never throws for it — symmetric with `armSchedule`, and
 * for a sharper reason: this runs inside deleting a conversation, so letting it
 * fail would abandon that delete half-done over an alarm that, at worst, fires
 * once into a record `fireSchedule` will find missing anyway.
 */
export async function disarmSchedule(id: string): Promise<void> {
  try {
    await chrome.alarms.clear(alarmNameFor(id));
  } catch (e) {
    log.warn("could not disarm schedule:", e instanceof Error ? e.message : String(e));
  }
}
