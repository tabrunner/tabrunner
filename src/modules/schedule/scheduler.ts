import { i18n } from "@/i18n";
import { createLogger, truncate } from "@/lib/logger";
import { defaultStartUrl } from "@/lib/prefs";
import { getActiveRun } from "@/modules/agent/active-runs";
import { listQueue, submitRun } from "@/modules/agent/run-queue";
import { startAgentRun } from "@/modules/agent/start-run";
import { openScheduledConversation } from "@/modules/conversation/conversations";
import { TranscriptWriter } from "@/modules/conversation/transcript";
import type { Event } from "@/shared/protocol";
import { armSchedule, disarmSchedule, isScheduleAlarm, scheduleIdFromAlarm } from "./alarms";
import { nextFireAt } from "./recurrence";
import { advanceSchedule, getSchedule, listSchedules, stampOutcome } from "./store";
import type { Schedule } from "./types";

const log = createLogger("schedule");

/**
 * How late a fire has to be before the run is told it ran late. Alarm delivery
 * is only accurate to about a minute, so a small overshoot is normal operation
 * and saying so every time would be noise; this is "the browser was closed".
 */
const LATE_AFTER_MS = 5 * 60_000;

/**
 * What the scheduler needs from the entrypoint. Same shape as `startBridge`'s
 * callback: the module owns the mechanism, `background.ts` owns the surfaces —
 * notifications are its business, not the scheduler's.
 */
export interface SchedulerHooks {
  /** A scheduled run finished with nobody watching — the OS notification. */
  onRunEnded: (conversationId: string, task: string, event: Event) => void;
  /** The run ended asking something. Nobody is there, so this has to reach out. */
  onAskUser: (conversationId: string, question: string, choices?: string[]) => void;
}

let hooks: SchedulerHooks | null = null;

/**
 * Boot: adopt the stored schedules as the truth and make the alarms match.
 * Alarms normally survive a browser restart, but they do NOT survive every
 * extension update or reload — so storage is authoritative and this re-arms
 * from it, clearing any `schedule:` alarm whose record is gone.
 */
export async function startScheduler(h: SchedulerHooks): Promise<void> {
  hooks = h;
  const [schedules, alarms] = await Promise.all([
    listSchedules(),
    chrome.alarms.getAll().catch(() => [] as chrome.alarms.Alarm[]),
  ]);
  const live = new Set(schedules.map((s) => s.id));
  for (const alarm of alarms) {
    if (isScheduleAlarm(alarm.name) && !live.has(scheduleIdFromAlarm(alarm.name))) {
      void chrome.alarms.clear(alarm.name);
    }
  }
  for (const schedule of schedules) {
    // A held schedule keeps its record and its thread but owns no alarm — and
    // boot is the one place that would hand it one back by accident.
    if (schedule.paused) void disarmSchedule(schedule.id);
    else await armSchedule(schedule);
  }
  log.info("scheduler started", {
    schedules: schedules.length,
    paused: schedules.filter((s) => s.paused).length,
  });
}

/** The alarm listener's entry point — `background.ts` routes `schedule:` here. */
export function onScheduleAlarm(name: string): void {
  void fireSchedule(scheduleIdFromAlarm(name));
}

/** The settings page's "Run now", routed through the worker where runs live. */
export function runScheduleNow(id: string): void {
  void fireSchedule(id, { manual: true });
}

/**
 * One fire. Submits the run and moves the schedule on in the same breath —
 * the advance never waits for the run to end, so a worker killed mid-task
 * cannot leave a schedule pointing at a time that has already passed (which
 * would fire it again at the next boot, forever).
 */
async function fireSchedule(id: string, opts: { manual?: boolean } = {}): Promise<void> {
  const schedule = await getSchedule(id);
  if (!schedule) {
    // The record went while the alarm was in flight — take the alarm with it.
    void disarmSchedule(id);
    return;
  }
  // Held schedules own no alarm, so this is a stale one that beat the clear —
  // take it with us. "Run now" deliberately still works: pausing stops the
  // timer, it does not take away the button that tests the task.
  if (schedule.paused && !opts.manual) {
    void disarmSchedule(id);
    return;
  }
  const now = Date.now();

  // One schedule, one run at a time. An hourly task that takes ninety minutes
  // must skip the fire it overlaps, not queue a second copy of itself behind
  // the first — that is how a slow schedule turns into a backlog.
  const busy =
    getActiveRun()?.conversationId === schedule.conversationId ||
    listQueue().some((q) => q.conversationId === schedule.conversationId);
  if (busy) {
    log.info("fire skipped — schedule already running", { id, task: truncate(schedule.task, 80) });
    if (!opts.manual) await advance(schedule, now);
    return;
  }

  // Idempotent — and it reports whether the thread was already there. The label
  // is what makes a transcript the user never started say where it came from.
  const hadThread = await openScheduledConversation(
    schedule.conversationId,
    i18n.t("schedule.agentLabel"),
    schedule.engine,
  );

  // The notes prepended to the task, in the order they'd be read. Both exist
  // because a scheduled run is told its own history IS the conversation above
  // it — so when that premise stops holding, the run has to hear about it.
  const notes: string[] = [];

  // A fire the browser was closed for runs late — once — and the run is told so,
  // because "summarize today's inbox" means something different at 2am the next
  // day and the model has to be able to say so.
  if (!opts.manual && now - schedule.nextFireAt > LATE_AFTER_MS) {
    notes.push(
      i18n.t("schedule.lateNote", {
        scheduled: new Date(schedule.nextFireAt).toLocaleString(i18n.language, {
          dateStyle: "medium",
          timeStyle: "short",
        }),
      }),
    );
  }

  // The thread is gone but the schedule has run before: its transcript fell off
  // the conversation cap. Silence here is the worse failure — the run would
  // read an empty history and quietly conclude it had never done this before.
  if (!hadThread && schedule.lastRun) notes.push(i18n.t("schedule.historyLostNote"));

  const task = notes.length ? `${schedule.task}\n\n${notes.join("\n\n")}` : schedule.task;

  // Never the tab the user is on: a scheduled run always names its own start
  // page, which is what keeps `resolveRunTab` out of the adoption branch.
  const url = schedule.url || (await defaultStartUrl.get());

  submitRun({
    conversationId: schedule.conversationId,
    owner: "schedule",
    task,
    launch: () => {
      const writer = new TranscriptWriter(schedule.conversationId);
      void startAgentRun({
        conversationId: schedule.conversationId,
        owner: "schedule",
        scheduleId: schedule.id,
        task,
        url,
        emit: (event) => {
          writer.apply(event);
          if (event.type === "done" || event.type === "error") {
            void stampOutcome(schedule.id, Date.now(), event.type === "done");
            hooks?.onRunEnded(schedule.conversationId, schedule.task, event);
          }
        },
        onAskUser: (question, choices) =>
          hooks?.onAskUser(schedule.conversationId, question, choices),
      }).catch((e) => {
        log.error("scheduled run failed to start:", e instanceof Error ? e.message : String(e));
      });
    },
  });

  if (!opts.manual) await advance(schedule, now);
}

/** Next fire from NOW, never from the time that was missed — a browser closed
 *  for three days resumes its schedule, it does not replay seventy-two fires. */
async function advance(schedule: Schedule, from: number): Promise<void> {
  const next = nextFireAt(schedule.recurrence, from);
  await advanceSchedule(schedule.id, next);
  if (next === null) {
    void disarmSchedule(schedule.id);
    return;
  }
  await armSchedule({ ...schedule, nextFireAt: next });
}
