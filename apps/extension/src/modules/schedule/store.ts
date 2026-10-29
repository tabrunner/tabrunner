import { createWriteQueue, defineItem } from "@/lib/storage";
import { i18n } from "@/i18n";
import { nextFireAt } from "./recurrence";
import type { Schedule } from "./types";

/**
 * ponytail: one flat array in `chrome.storage.local`, read-modify-written whole
 * — the same shape the conversation index uses, and for the same reason (there
 * are tens of these, not thousands). Ceiling: every write rewrites the list.
 * Upgrade path is one key per schedule if the cap ever rises meaningfully.
 */
const schedulesItem = defineItem<Schedule[]>("schedules", []);

/**
 * The bound on unattended work. A scheduled run's plan auto-approves, so the
 * agent holds a tool that creates more auto-approved future work — this is the
 * ceiling on how far that can go before the user is asked again.
 */
export const MAX_SCHEDULES = 20;

/** Consecutive self-reschedules before a self-paced loop has to stop and ask. */
export const MAX_CHAIN = 20;

// Fires can land while the settings page is editing — one write queue.
const serialized = createWriteQueue();

export function listSchedules(): Promise<Schedule[]> {
  return schedulesItem.get();
}

export function watchSchedules(cb: (list: Schedule[]) => void): () => void {
  return schedulesItem.watch(cb);
}

export async function getSchedule(id: string): Promise<Schedule | undefined> {
  return (await schedulesItem.get()).find((s) => s.id === id);
}

/** Every schedule writing into one thread — what deleting that thread has to answer for. */
export async function schedulesForConversation(conversationId: string): Promise<Schedule[]> {
  return (await schedulesItem.get()).filter((s) => s.conversationId === conversationId);
}

/**
 * Holds a schedule, or lets it go again. Resuming recomputes the next fire from
 * NOW: the stored one has been sitting still the whole time it was paused, so
 * arming it would fire the instant the user flipped the switch back.
 *
 * Returns the updated record so the caller can arm it — or `undefined` when
 * resuming found nothing left to run, which is a one-shot whose moment passed
 * while it was held. Retiring it here is the same rule `advanceSchedule`
 * follows: a rule with no next fire is spent, and a spent record is deleted.
 */
export function setSchedulePaused(id: string, paused: boolean): Promise<Schedule | undefined> {
  return serialized(async () => {
    const list = await schedulesItem.get();
    const i = list.findIndex((s) => s.id === id);
    const current = list[i];
    if (!current) return undefined;

    if (paused) {
      const held: Schedule = { ...current, paused: true };
      await schedulesItem.set(list.with(i, held));
      return held;
    }

    const when = nextFireAt(current.recurrence, Date.now());
    if (when === null) {
      await schedulesItem.set(list.filter((s) => s.id !== id));
      return undefined;
    }
    const live: Schedule = { ...current, nextFireAt: when, paused: false };
    await schedulesItem.set(list.with(i, live));
    return live;
  });
}

export type SaveResult = { ok: true; schedule: Schedule } | { ok: false; error: string };

/**
 * Stores a new schedule, or replaces one by id. The cap is enforced here rather
 * than at the call site so the tool, the settings page and any future caller
 * cannot each carry their own version of the limit.
 */
export function saveSchedule(schedule: Schedule): Promise<SaveResult> {
  return serialized(async () => {
    const list = await schedulesItem.get();
    const existing = list.findIndex((s) => s.id === schedule.id);
    if (existing < 0 && list.length >= MAX_SCHEDULES) {
      return { ok: false, error: i18n.t("schedule.errors.tooMany", { max: MAX_SCHEDULES }) };
    }
    const next = existing < 0 ? [...list, schedule] : list.with(existing, schedule);
    await schedulesItem.set(next);
    return { ok: true, schedule };
  });
}

/** Removes a schedule. False when it was already gone — the caller's cue not to lie about it. */
export function deleteSchedule(id: string): Promise<boolean> {
  return serialized(async () => {
    const list = await schedulesItem.get();
    const next = list.filter((s) => s.id !== id);
    if (next.length === list.length) return false;
    await schedulesItem.set(next);
    return true;
  });
}

/**
 * Moves a fired schedule to its next fire, or deletes it when the rule is spent
 * (a `once` that ran). Called the moment the run is submitted, not when it ends:
 * a worker killed mid-run must never leave a schedule pointing at a time that
 * has already passed, which would fire it again at the next boot.
 */
export function advanceSchedule(id: string, nextFireAt: number | null): Promise<void> {
  return serialized(async () => {
    const list = await schedulesItem.get();
    const i = list.findIndex((s) => s.id === id);
    const current = list[i];
    if (!current) return;
    await schedulesItem.set(
      nextFireAt === null
        ? list.filter((s) => s.id !== id)
        : list.with(i, { ...current, nextFireAt }),
    );
  });
}

/** Records how the last fire went — the settings row's "✓ 09:00" line. No-op
 *  for a one-shot, which advanceSchedule already retired. */
export function stampOutcome(id: string, at: number, ok: boolean): Promise<void> {
  return serialized(async () => {
    const list = await schedulesItem.get();
    const i = list.findIndex((s) => s.id === id);
    const current = list[i];
    if (!current) return;
    await schedulesItem.set(list.with(i, { ...current, lastRun: { at, ok } }));
  });
}
