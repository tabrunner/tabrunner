import { useTranslation } from "react-i18next";
import { useConversationStore } from "./store";
import { focusTab } from "@/modules/browser";
import { Button } from "@/components/Button";
import { Icon, XIcon } from "@/components/Icon";

function JumpIcon() {
  return (
    <Icon>
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
      <path d="M15 3h6v6M10 14 21 3" />
    </Icon>
  );
}

function StopIcon() {
  return (
    <Icon>
      <rect x="6" y="6" width="12" height="12" rx="2" />
    </Icon>
  );
}

/**
 * Why a task the user never typed is on their board. Without it a schedule
 * firing mid-chat reads as TabRunner inventing work for itself — the one thing
 * an agent driving your real browser must never look like it is doing. A glyph
 * rather than a text chip: the strip is one line of `text-xs`, and it echoes
 * the clock this feature already wears in the settings nav.
 */
function ScheduledMark({ label }: { label: string }) {
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className="shrink-0 text-neutral-400 dark:text-neutral-500"
    >
      <svg
        width="12"
        height="12"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5l3 2" />
      </svg>
    </span>
  );
}

/**
 * What TabRunner is doing that this chat cannot see — a run driving another
 * conversation (or an MCP client's), and tasks queued behind it. Reads the same
 * run board the widget paints from, so the two can never disagree.
 *
 * Strictly what is missing elsewhere. The open conversation's own run already
 * has the live band (verb, elapsed, driven-tab chip, plan peek), the composer's
 * Stop and Esc, and its task sits in the transcript one message up — repeating
 * all of it in a strip under the header was four controls saying what two
 * already said. Same for our own queued submission: the composer carries its
 * card, with position and cancel. So both hide per entry, and the section is
 * gone entirely in the common case of one chat, one run.
 */
export function RunBoard() {
  const { t } = useTranslation();
  const board = useConversationStore((s) => s.board);
  const stop = useConversationStore((s) => s.stop);
  const cancelQueuedById = useConversationStore((s) => s.cancelQueuedById);
  const activeId = useConversationStore((s) => s.activeId);
  const queuedRunId = useConversationStore((s) => s.queuedRun?.id);

  // The band below covers a run living on the open conversation — and covers it
  // whether the panel watched it start or reopened into it (the worker re-sends
  // the driving event on connect, so the tab chip is there either way).
  const running = board.running?.conversationId === activeId ? undefined : board.running;
  // Pulled out of the object before the guard below: TypeScript drops a
  // narrowing on `obj.prop` the moment it crosses into a callback, so reading
  // running.tabId inside onClick would need a cast the guard already earned.
  const { tabId: runningTabId, windowId: runningWindowId } = running ?? {};
  // Numbered off the whole line, not the visible remainder: hiding our own
  // entry must not renumber the ones behind it — the composer card and this
  // strip name the same positions.
  const queue = board.queue
    .map((q, i) => ({ ...q, position: i + 1 }))
    .filter((q) => q.id !== queuedRunId);

  if (!running && queue.length === 0) return null;

  return (
    <section
      aria-label={t("board.title")}
      className="arrive flex flex-col gap-1 border-b border-neutral-100 px-3 py-2 dark:border-neutral-800"
    >
      {running && (
        <div className="flex items-center gap-1.5">
          {running.awaiting ? (
            // Blocked on the user's answer — the still "?", never the pulse.
            <span
              aria-hidden
              title={t("run.awaitingApproval")}
              className="grid size-3.5 shrink-0 place-items-center rounded-full bg-amber-400 text-[10px] font-bold leading-none text-amber-950"
            >
              ?
            </span>
          ) : (
            /* The same pulsing amber the widget and the favicon dot speak. */
            <span
              aria-hidden
              className="size-1.5 shrink-0 animate-pulse rounded-full bg-amber-400 motion-reduce:animate-none"
            />
          )}
          {running.owner === "schedule" && <ScheduledMark label={t("schedule.agentLabel")} />}
          <span
            className="min-w-0 flex-1 truncate text-xs font-medium text-neutral-800 dark:text-neutral-100"
            title={running.task}
          >
            {running.task}
          </span>
          {runningTabId !== undefined && (
            <Button
              variant="ghost"
              size="sm"
              className="shrink-0 px-1.5"
              title={t("board.jump")}
              aria-label={t("board.jump")}
              onClick={() => void focusTab(runningTabId, runningWindowId)}
            >
              <JumpIcon />
            </Button>
          )}
          <Button
            variant="ghost-danger"
            size="sm"
            className="shrink-0 px-1.5"
            title={t("board.stop")}
            aria-label={t("board.stop")}
            onClick={stop}
          >
            <StopIcon />
          </Button>
        </div>
      )}
      {queue.map((q) => (
        <div key={q.id} className="flex items-center gap-1.5">
          <span
            aria-hidden
            className="shrink-0 rounded border border-neutral-300 px-1 py-px text-[10px] font-medium text-neutral-500 dark:border-neutral-600 dark:text-neutral-400"
          >
            {q.position}
          </span>
          {q.owner === "schedule" && <ScheduledMark label={t("schedule.agentLabel")} />}
          <span
            className="min-w-0 flex-1 truncate text-xs text-neutral-500 dark:text-neutral-400"
            title={q.task}
          >
            {q.task}
          </span>
          {/* Waving off a queued fire skips this one run; the schedule stands. */}
          {q.owner !== "bridge" && (
            <Button
              variant="ghost"
              size="sm"
              className="shrink-0 px-1.5"
              title={t("board.cancel")}
              aria-label={t("board.cancel")}
              onClick={() => cancelQueuedById(q.id)}
            >
              <XIcon />
            </Button>
          )}
        </div>
      ))}
    </section>
  );
}
