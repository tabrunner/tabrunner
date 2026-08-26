import { useTranslation } from "react-i18next";
import { useConversationStore } from "./store";
import { XIcon } from "@/components/Icon";

/**
 * A committed item waiting its turn — the dashed one-liner this replaced read
 * as a draft. The amber accent bar is the panel's parked/waiting language (the
 * awaiting dot, the board's "?"), the chip numbers the line like the run board
 * does, and two lines of text beat a truncated one.
 */
function QueueCard({
  chip,
  title,
  text,
  onRemove,
  removeAria,
}: {
  chip: string;
  title: string;
  text: string;
  onRemove: () => void;
  removeAria: string;
}) {
  return (
    <div className="settle flex items-start gap-2 rounded-lg border border-neutral-200 border-l-2 border-l-amber-400 bg-neutral-50 px-2.5 py-1.5 dark:border-neutral-800 dark:border-l-amber-500 dark:bg-neutral-900">
      <span
        title={title}
        className="mt-px shrink-0 rounded border border-amber-300 px-1 py-px text-[10px] font-medium text-amber-700 dark:border-amber-700 dark:text-amber-300"
      >
        {chip}
      </span>
      <span
        title={text}
        className="min-w-0 flex-1 line-clamp-2 text-xs text-neutral-700 dark:text-neutral-300"
      >
        {text}
      </span>
      <button
        type="button"
        onClick={onRemove}
        aria-label={removeAria}
        className="flex shrink-0 items-center rounded px-1 text-neutral-500 hover:bg-neutral-100 focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:outline-none dark:text-neutral-400 dark:hover:bg-neutral-800"
      >
        <XIcon />
      </button>
    </div>
  );
}

/**
 * Everything committed but not yet running — queued steers, our own submission
 * behind another run, a deferred command — as one band under the transcript,
 * above the plan: the plan approval card ends the transcript and the live
 * band's peek sits below it, so both now read AFTER what the user has already
 * put in line (read the queue top-down, then decide on the gate). The composer
 * keeps the behavior — recall, steering, queueing — and sheds only these cards.
 */
export function QueueCards() {
  const { t } = useTranslation();
  const queued = useConversationStore((s) => s.queued);
  const unqueueMessage = useConversationStore((s) => s.unqueueMessage);
  const queuedRun = useConversationStore((s) => s.queuedRun);
  const cancelQueuedRun = useConversationStore((s) => s.cancelQueuedRun);
  // The chip's position reads the board live (like RunBoard does) — entries
  // ahead of ours leaving the line move it up without a new event.
  const queuedPosition = useConversationStore((s) => {
    if (!s.queuedRun) return 0;
    const at = s.board.queue.findIndex((q) => q.id === s.queuedRun?.id);
    return at >= 0 ? at + 1 : s.queuedRun.position;
  });
  const deferred = useConversationStore((s) => s.deferred);
  const cancelDeferred = useConversationStore((s) => s.cancelDeferred);

  if (queued.length === 0 && !queuedRun && !deferred) return null;

  return (
    <div className="flex flex-col gap-1.5 px-3 py-2">
      {queued.length > 0 && (
        // Capped and scrolled: nothing bounds how many steers you can queue, and
        // the transcript is the only `min-h-0 flex-1` sibling — so an unbounded
        // stack is the composer squeezing the conversation to zero height.
        <div className="flex max-h-40 flex-col gap-1 overflow-y-auto">
          {queued.map((q, i) => (
            <QueueCard
              key={q.id}
              chip={String(i + 1)}
              title={t("chat.queuedSteerTitle")}
              text={q.text}
              onRemove={() => unqueueMessage(q.id)}
              removeAria={t("chat.unqueueAria")}
            />
          ))}
        </div>
      )}
      {queuedRun && (
        <QueueCard
          chip={t("queue.position", { position: queuedPosition })}
          title={t("queue.queuedTitle")}
          text={queuedRun.task}
          onRemove={cancelQueuedRun}
          removeAria={t("queue.cancel")}
        />
      )}
      {/* A command that had to wait its turn — the same card as a queued steer,
          because it is the same fact: something committed, not yet run, still
          take-back-able. */}
      {deferred && (
        <QueueCard
          chip={t("commands.deferred.chip")}
          title={t("commands.deferred.title")}
          text={`/${deferred.name}`}
          onRemove={cancelDeferred}
          removeAria={t("commands.deferred.cancelAria")}
        />
      )}
    </div>
  );
}
