import { i18n } from "@/i18n";
import { createLogger, truncate } from "@/lib/logger";
import { armSchedule, disarmSchedule } from "./alarms";
import {
  describeRecurrence,
  nextFireAt,
  recurrenceFromArgs,
  validateRecurrence,
} from "./recurrence";
import { deleteSchedule, getSchedule, saveSchedule, MAX_CHAIN } from "./store";
import { getConversationMeta } from "@/modules/conversation";
import type { Schedule } from "./types";

const log = createLogger("schedule");

/** Structurally the agent's ToolResult, without importing back into that module. */
type Result = { ok: true; data: unknown } | { ok: false; error: string };

/** Who is asking — the run's own bounds, handed down from the loop. */
export interface AgentCaller {
  owner?: string;
  /** Set only for a run a schedule fired: the one record it is allowed to touch. */
  scheduleId?: string;
  /** The run's own thread — what the new schedule inherits its engine from, so
   *  work handed to a timer runs on the engine that agreed to it. */
  conversationId?: string;
}

function fail(error: string): Result {
  return { ok: false, error };
}

/** What the model gets back — enough to say what it just committed to, in words. */
function describe(schedule: Schedule): Result {
  return {
    ok: true,
    data: {
      id: schedule.id,
      task: schedule.task,
      recurrence: describeRecurrence(schedule.recurrence),
      next_run: new Date(schedule.nextFireAt).toLocaleString(i18n.language, {
        dateStyle: "medium",
        timeStyle: "short",
      }),
    },
  };
}

/**
 * `schedule_task`. Creates a schedule, or re-times one that already exists.
 *
 * The interesting half is what a SCHEDULED run may do here. Its plan gate
 * auto-approves, so if it could create new schedules it could fan out
 * unattended — instead it may only re-time the schedule it fired from, which is
 * exactly the self-paced loop ("check again in twenty minutes") and nothing
 * more. `chainCount` then bounds how long that can go without a human: past
 * MAX_CHAIN it has to stop and ask, which caps the spend of a loop that never
 * decides it is finished.
 */
export async function scheduleTask(
  args: Record<string, unknown>,
  caller: AgentCaller,
): Promise<Result> {
  const recurrence = recurrenceFromArgs(args.recurrence);
  if (!recurrence) return fail(i18n.t("schedule.errors.badRecurrence"));
  const now = Date.now();
  const invalid = validateRecurrence(recurrence, now);
  if (invalid) return fail(invalid);

  const next = nextFireAt(recurrence, now);
  if (next === null) return fail(i18n.t("schedule.errors.neverFires"));

  const engine = caller.conversationId
    ? (await getConversationMeta(caller.conversationId))?.engine
    : undefined;
  const task = String(args.task ?? "").trim();
  const url = typeof args.url === "string" && args.url ? args.url : undefined;
  const fromSchedule = caller.owner === "schedule";

  // A scheduled run re-times itself and nothing else.
  const targetId = fromSchedule ? caller.scheduleId : (args.id as string | undefined);
  const existing = targetId ? await getSchedule(targetId) : undefined;

  if (fromSchedule && !existing) return fail(i18n.t("schedule.errors.selfOnly"));
  if (fromSchedule && (existing?.chainCount ?? 0) >= MAX_CHAIN) {
    return fail(i18n.t("schedule.errors.chainExhausted", { max: MAX_CHAIN }));
  }
  if (!existing && !task) return fail(i18n.t("schedule.errors.noTask"));

  const schedule: Schedule = existing
    ? {
        ...existing,
        ...(task ? { task } : {}),
        ...(url ? { url } : {}),
        recurrence,
        nextFireAt: next,
        // The user touching a schedule is what releases a self-paced loop's
        // leash; the loop extending itself is what tightens it.
        chainCount: fromSchedule ? (existing.chainCount ?? 0) + 1 : 0,
      }
    : {
        id: crypto.randomUUID(),
        task,
        ...(url ? { url } : {}),
        recurrence,
        // A thread of its own: 3am runs must not land in the chat the user is
        // reading, and one thread per schedule is what lets a recurring run
        // read what it did last time.
        conversationId: crypto.randomUUID(),
        // Frozen at setup, not at first fire: what the user (or the run they
        // approved this in) was working with is what unattended work should
        // keep using, however the default moves in between.
        ...(engine ? { engine } : {}),
        nextFireAt: next,
        createdAt: now,
        chainCount: 0,
      };

  const saved = await saveSchedule(schedule);
  if (!saved.ok) return fail(saved.error);
  await armSchedule(schedule);
  log.info("schedule saved", { id: schedule.id, task: truncate(schedule.task, 80) });
  return describe(schedule);
}

/**
 * `cancel_schedule`. Ungated and open to every owner: cancelling only ever
 * removes future work, and it is how a self-paced loop decides it is done.
 */
export async function cancelSchedule(args: Record<string, unknown>): Promise<Result> {
  const id = String(args.id ?? "").trim();
  if (!id) return fail(i18n.t("schedule.errors.noId"));
  const schedule = await getSchedule(id);
  if (!(await deleteSchedule(id))) return fail(i18n.t("schedule.errors.notFound", { id }));
  await disarmSchedule(id);
  log.info("schedule cancelled", { id });
  return { ok: true, data: { id, task: schedule?.task ?? "" } };
}
