import { useTranslation } from "react-i18next";
import { useConversationStore } from "./store";
import { XIcon } from "@/components/Icon";
import { Bubble } from "@/components/Bubble";

/**
 * A message the user has committed but nothing has sent yet.
 *
 * Drawn as their own bubble — same geometry, same side of the column as a sent
 * turn — because that is what it is: the next thing they said, still in line.
 * The neutral bordered card this replaced sat in the composer's chrome and read
 * as a control, so the one question it had to answer ("did that go through?")
 * was the one it never did.
 *
 * Two signals separate it from a sent turn, and they are redundant on purpose:
 * the fill is gone (filled = sent, and that reads at a glance without a word),
 * and the edge is dashed. The amber meta line above carries the words and the
 * take-back — same slot and same size as a user message's TabStamp, which is
 * already this panel's idiom for "annotation on your own turn", and amber is
 * already its parked/waiting colour (the run band's park, the board's "?").
 */
function QueuedBubble({
  label,
  title,
  text,
  onRemove,
  removeAria,
}: {
  label: string;
  title: string;
  text: string;
  onRemove: () => void;
  removeAria: string;
}) {
  return (
    <div className="settle flex flex-col items-end gap-0.5">
      <div
        title={title}
        className="flex items-center gap-1 text-[11px] text-amber-700 dark:text-amber-300"
      >
        {/* Still, not pulsing: the live band owns the panel's one waiting
            motion, and a second blink in the same corner says nothing. */}
        <span aria-hidden className="inline-block h-1.5 w-1.5 rounded-full bg-amber-400" />
        {label}
        <button
          type="button"
          onClick={onRemove}
          aria-label={removeAria}
          className="-my-0.5 ml-0.5 flex items-center rounded px-0.5 text-neutral-500 hover:bg-neutral-100 hover:text-neutral-800 focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:outline-none dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
        >
          <XIcon />
        </button>
      </div>
      <Bubble variant="pending" align="end">
        {/* Clamped, not truncated to a line: a queued paste is still a message
            and deserves to be read back, but this band sits between the
            transcript and the composer and must never grow into either. */}
        <span title={text} className="line-clamp-4">
          {text}
        </span>
      </Bubble>
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
  // The label's position reads the board live (like RunBoard does) — entries
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
    // Same 12px gutter as the transcript's, so a queued bubble's right edge
    // lands exactly on the sent ones above it — the whole point is that the eye
    // reads one column of the user's own turns, the last of them not sent yet.
    <div className="flex flex-col gap-2 px-3 pt-1 pb-2">
      {queued.length > 0 && (
        // Capped and scrolled: nothing bounds how many steers you can queue, and
        // the transcript is the only `min-h-0 flex-1` sibling — so an unbounded
        // stack is the composer squeezing the conversation to zero height.
        <div className="flex max-h-44 flex-col gap-2 overflow-y-auto">
          {queued.map((q, i) => (
            <QueuedBubble
              key={q.id}
              // Numbered only once there is a line to be in — "#1" beside a
              // lone queued message invents a queue the user cannot see.
              label={
                queued.length > 1
                  ? t("chat.queuedSteerPosition", { position: i + 1 })
                  : t("chat.queuedSteer")
              }
              title={t("chat.queuedSteerTitle")}
              text={q.text}
              onRemove={() => unqueueMessage(q.id)}
              removeAria={t("chat.unqueueAria")}
            />
          ))}
        </div>
      )}
      {queuedRun && (
        <QueuedBubble
          label={t("queue.position", { position: queuedPosition })}
          title={t("queue.queuedTitle")}
          text={queuedRun.task}
          onRemove={cancelQueuedRun}
          removeAria={t("queue.cancel")}
        />
      )}
      {/* A command that had to wait its turn — the same bubble as a queued
          steer, because it is the same fact: something the user committed, not
          yet run, still take-back-able. */}
      {deferred && (
        <QueuedBubble
          label={t("commands.deferred.chip")}
          title={t("commands.deferred.title")}
          text={`/${deferred.name}`}
          onRemove={cancelDeferred}
          removeAria={t("commands.deferred.cancelAria")}
        />
      )}
    </div>
  );
}
