import { useTranslation } from "react-i18next";
import { Button } from "@/components/Button";
import { CometPose } from "@/components/CometPose";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Switch } from "@/components/Switch";
import { Icon, TrashIcon } from "@/components/Icon";
import { useStoredItem } from "@/components/useStoredItem";
import { runBoardItem } from "@/modules/agent/run-queue";
import { setActiveConversation } from "@/modules/conversation/conversations";
import { describeRecurrence } from "../recurrence";
import { deleteSchedule, setSchedulePaused, MAX_SCHEDULES } from "../store";
import { armSchedule, disarmSchedule } from "../alarms";
import { useSchedules } from "./hooks";
import type { Schedule } from "../types";

/**
 * Soonest first, and everything paused after everything live. A held schedule's
 * `nextFireAt` is a leftover from before it was paused, so sorting it in by that
 * number would file it under a time it is not going to run at.
 */
function useSortedSchedules(): Schedule[] {
  const rows = useSchedules();
  return [...rows].sort(
    (a, b) => Number(a.paused ?? false) - Number(b.paused ?? false) || a.nextFireAt - b.nextFireAt,
  );
}

/**
 * An absolute time, not "in 4 hours". A schedule is answered by *when*, and a
 * relative reading forces the user to do the arithmetic the row exists to save.
 * Anything inside the week gets a weekday instead of a date — "Tue 09:00" is
 * the shortest form that still says which day.
 */
function formatWhen(ms: number, lang: string): string {
  const ahead = ms - Date.now();
  const nearby = ahead < 6 * 86_400_000 && ahead > -86_400_000;
  return new Date(ms).toLocaleString(
    lang,
    nearby
      ? { weekday: "short", hour: "2-digit", minute: "2-digit" }
      : { dateStyle: "medium", timeStyle: "short" },
  );
}

/**
 * Runs live in the service worker — this page is a separate context with no run
 * slot, no driver and no board. So "Run now" asks rather than calls.
 */
function runNow(id: string): void {
  void chrome.runtime.sendMessage({ type: "tabrunner-run-schedule", id });
}

/**
 * Open the schedule's own thread. Setting it active always lands, so a browser
 * that refuses the panel open (it wants a user gesture, and this one crosses an
 * await) still leaves the user one click from the right conversation rather
 * than nowhere.
 */
async function openConversation(conversationId: string): Promise<void> {
  await setActiveConversation(conversationId);
  try {
    const win = await chrome.windows.getCurrent();
    if (win.id !== undefined) await chrome.sidePanel.open({ windowId: win.id });
  } catch {
    // No panel from here — the thread is still the active one when they open it.
  }
}

/**
 * Pause holds the rule and the thread and drops only the alarm — the answer to
 * "stop it for now" that deleting cannot give, since deleting a schedule's
 * conversation takes its memory with it. Resuming re-arms from the recomputed
 * next fire, never the stale one the record was holding while it sat still.
 */
async function togglePause(schedule: Schedule): Promise<void> {
  const next = await setSchedulePaused(schedule.id, !schedule.paused);
  if (next && !next.paused) await armSchedule(next);
  else await disarmSchedule(schedule.id);
}

/**
 * Delete means make it stop. Removing the record while its run keeps driving the
 * browser is the surprise this avoids — so a fire in flight is halted with it.
 * The button's label says as much while that is what will happen.
 */
async function remove(schedule: Schedule, running: boolean): Promise<void> {
  await deleteSchedule(schedule.id);
  await disarmSchedule(schedule.id);
  if (running) {
    void chrome.runtime.sendMessage({
      type: "tabrunner-stop-run",
      conversationId: schedule.conversationId,
    });
  }
}

/**
 * The management surface for work that runs unattended. Deliberately view-and-
 * cancel only: schedules are created by asking in the panel, where the plan gate
 * turns the request into the user's explicit yes. A form here would be a second
 * way to author the same record, with none of that consent attached.
 */
export function SchedulesSection() {
  const { t, i18n } = useTranslation();
  const schedules = useSortedSchedules();
  const board = useStoredItem(runBoardItem);
  const busyOn = board.running?.conversationId;
  // A fire that landed while another run held the slot is waiting, not lost.
  // Without this the row falls back to "Next 09:00" and reads as if the click
  // did nothing at all.
  const queuedOn = new Set(board.queue.map((q) => q.conversationId));

  return (
    <section>
      <div className="flex items-baseline justify-between gap-4">
        <h2 className="text-base font-semibold text-neutral-900 dark:text-neutral-100">
          {t("schedule.ui.title")}
        </h2>
        {schedules.length > 0 && (
          <span className="shrink-0 text-xs text-neutral-500 tabular-nums dark:text-neutral-400">
            {/* `n`, not `count`: an i18next `count` option means pluralization,
                and this is a ratio, not a quantity being pluralized. */}
            {t("schedule.ui.count", { n: schedules.length, max: MAX_SCHEDULES })}
          </span>
        )}
      </div>
      <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">{t("schedule.ui.help")}</p>

      {schedules.length === 0 ? (
        <div className="mt-3 flex items-center gap-2 rounded-lg bg-neutral-50 px-3 py-3 dark:bg-neutral-900/50">
          <CometPose pose="resting" size={40} className="shrink-0" />
          <div className="min-w-0">
            <p className="text-sm font-medium text-neutral-700 dark:text-neutral-200">
              {t("schedule.ui.emptyTitle")}
            </p>
            <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
              {t("schedule.ui.emptyBody")}
            </p>
            <p className="mt-2 text-xs text-neutral-600 dark:text-neutral-300">
              {t("schedule.ui.emptyAction")}
            </p>
          </div>
        </div>
      ) : (
        <ul className="mt-3 space-y-1.5">
          {schedules.map((s) => {
            const running = busyOn === s.conversationId;
            const queued = !running && queuedOn.has(s.conversationId);
            // Paused reads as off, not as a quieter live row — the whole point
            // of the state is that this thing is not going to happen.
            const held = Boolean(s.paused) && !running && !queued;
            return (
              <li
                key={s.id}
                className={`flex items-start justify-between gap-3 rounded-lg bg-neutral-50 px-3 py-2 dark:bg-neutral-900/50 ${held ? "opacity-60" : ""}`}
              >
                <div className="min-w-0 flex-1">
                  <p className="text-sm leading-relaxed text-neutral-800 dark:text-neutral-200">
                    {s.task}
                  </p>
                  <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-neutral-500 dark:text-neutral-400">
                    <span>{describeRecurrence(s.recurrence)}</span>
                    <span aria-hidden="true">·</span>
                    {/* Gold measures, per the two-lights rule — so it carries the
                        next-fire time, and nothing else. "Paused" and "Queued"
                        are states rather than measurements, "Running" is the
                        action state and therefore emerald's, and a held row's
                        stale next-fire is not a time anything will happen at.
                        `tabular-nums` travels with the number for the same
                        reason: it is the only branch that has one. */}
                    {held ? (
                      <span className="font-medium">{t("schedule.ui.paused")}</span>
                    ) : running ? (
                      <span className="font-medium text-brand-700 dark:text-brand-400">
                        {t("schedule.ui.running")}
                      </span>
                    ) : queued ? (
                      <span className="font-medium">{t("schedule.ui.queued")}</span>
                    ) : (
                      <span className="telemetry tabular-nums">
                        {t("schedule.ui.next", { when: formatWhen(s.nextFireAt, i18n.language) })}
                      </span>
                    )}
                    {s.lastRun && (
                      <>
                        <span aria-hidden="true">·</span>
                        <span className={s.lastRun.ok ? "" : "text-red-600 dark:text-red-400"}>
                          {t(s.lastRun.ok ? "schedule.ui.lastOk" : "schedule.ui.lastFailed", {
                            when: formatWhen(s.lastRun.at, i18n.language),
                          })}
                        </span>
                      </>
                    )}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-0.5">
                  {/* A switch, not a play/pause glyph: this is a state, and the
                      row already spends its one ▶ on "Run now". Two triangles
                      side by side would be a coin toss. */}
                  <Switch
                    checked={!s.paused}
                    onChange={() => void togglePause(s)}
                    ariaLabel={t(s.paused ? "schedule.ui.resume" : "schedule.ui.pause")}
                    title={t(s.paused ? "schedule.ui.resume" : "schedule.ui.pause")}
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={running || queued}
                    // Running it by hand is a rehearsal, not the performance: the
                    // timer is untouched, which is the surprising half for a
                    // one-shot — that one still goes off at its own time.
                    aria-label={t(
                      s.recurrence.kind === "once"
                        ? "schedule.ui.runNowOnce"
                        : "schedule.ui.runNow",
                    )}
                    title={t(
                      s.recurrence.kind === "once"
                        ? "schedule.ui.runNowOnce"
                        : "schedule.ui.runNow",
                    )}
                    onClick={() => runNow(s.id)}
                  >
                    <Icon>
                      <path d="M6 4l14 8-14 8V4z" />
                    </Icon>
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={t("schedule.ui.open")}
                    title={t("schedule.ui.open")}
                    onClick={() => void openConversation(s.conversationId)}
                  >
                    <Icon>
                      <path d="M21 3h-7" />
                      <path d="M21 3v7" />
                      <path d="M21 3 10 14" />
                      <path d="M19 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h5" />
                    </Icon>
                  </Button>
                  {/* Confirmed, like the skill list's delete — and this one has
                      the stronger claim on a gate: a schedule is authored through
                      the panel's plan gate, so it cannot be re-made from here,
                      and deleting a live one stops the task mid-flight. */}
                  <ConfirmDialog
                    trigger={
                      <Button
                        variant="ghost-danger"
                        size="sm"
                        aria-label={t(running ? "schedule.ui.deleteRunning" : "schedule.ui.delete")}
                        title={t(running ? "schedule.ui.deleteRunning" : "schedule.ui.delete")}
                      >
                        <TrashIcon />
                      </Button>
                    }
                    title={t("schedule.ui.deleteTitle")}
                    description={t(
                      running ? "schedule.ui.deleteBodyRunning" : "schedule.ui.deleteBody",
                    )}
                    onConfirm={() => void remove(s, running)}
                  />
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
