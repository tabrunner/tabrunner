import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useConversationStore } from "./store";
import type { ConversationMeta } from "../conversations";
import { describeRecurrence, type Schedule } from "@/modules/schedule";
import { useSchedules } from "@/modules/schedule/ui";
import { Button } from "@/components/Button";
import { CometPose } from "@/components/CometPose";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Icon, PencilIcon, PlusIcon, TrashIcon } from "@/components/Icon";
import { formatMoney } from "@/lib/format";
import { TitleInput } from "./TitleInput";

function BackIcon() {
  return (
    <Icon>
      <path d="M19 12H5m7-7-7 7 7 7" />
    </Icon>
  );
}

function HistoryIcon() {
  return (
    <Icon>
      <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
      <path d="M3 3v5h5M12 7v5l3.5 2" />
    </Icon>
  );
}

/**
 * Why the panel may not leave this thread right now, as the tooltip that says
 * so — undefined when it may. Both controls in this row switch conversations
 * (New Chat outright, History by way of a row), and every window follows the
 * open one, so leaving does not just move this panel: it takes the others off
 * a run somebody may be watching, plan card and all.
 *
 * `status`, not `runsHere`: it means this panel is drawing the stream, so the
 * run is the thing on screen. A schedule's or the bridge's run deliberately
 * does not count — it sends this panel nothing, the transcript refetch keeps
 * the thread current on its own, and the board and the toolbar badge go on
 * saying it is alive. Holding the extension shut for the length of an
 * overnight schedule would cost more than it protects.
 *
 * It is no longer "the stream would be misrouted". That stopped being true
 * when run events started carrying the conversation they belong to, and a
 * panel showing another thread began dropping them.
 */
function useSwitchBlocked(): string | undefined {
  const { t } = useTranslation();
  const running = useConversationStore((s) => s.status === "running");
  return running ? t("sidepanel.busyRunning") : undefined;
}

/** Quiet icon toggle to browse the stored transcripts. */
export function HistoryToggle({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  const { t } = useTranslation();
  const blocked = useSwitchBlocked();

  return (
    <Button
      variant="ghost"
      size="sm"
      className={`shrink-0 px-1.5 ${open ? "bg-neutral-100 dark:bg-neutral-800" : ""}`}
      disabled={blocked !== undefined}
      aria-pressed={open}
      title={blocked ?? t("history.title")}
      aria-label={t("history.title")}
      onClick={onToggle}
    >
      <HistoryIcon />
    </Button>
  );
}

/**
 * The panel's most-used action, so it gets the row's end slot, a label, and the
 * outline weight — the rare utilities sit together to its left, quiet.
 */
export function NewChatButton({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  const { t } = useTranslation();
  const blocked = useSwitchBlocked();
  const newConversation = useConversationStore((s) => s.newConversation);
  // Only emptiness matters here — select the boolean, not the whole array.
  const empty = useConversationStore((s) => s.messages.length === 0);

  return (
    <Button
      variant="outline"
      size="sm"
      className="ml-1 flex shrink-0 items-center gap-1"
      disabled={blocked !== undefined || (empty && !open)}
      title={blocked ?? t("history.newChat")}
      onClick={() => {
        newConversation();
        if (open) onToggle();
      }}
    >
      <PlusIcon />
      {t("history.newChat")}
    </Button>
  );
}

/** "2 hours ago" / "yesterday" — Intl does the locale work, no date library. */
function relativeTime(ts: number, locale: string): string {
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ["day", 86_400_000],
    ["hour", 3_600_000],
    ["minute", 60_000],
  ];
  const diff = ts - Date.now();
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  for (const [unit, ms] of units) {
    if (Math.abs(diff) >= ms) return rtf.format(Math.round(diff / ms), unit);
  }
  return rtf.format(0, "second");
}

function ConversationRow({
  conversation,
  active,
  schedule,
  onOpen,
  onDelete,
}: {
  conversation: ConversationMeta;
  active: boolean;
  /** Set when a schedule writes into this thread — deleting it ends that too. */
  schedule?: Schedule;
  onOpen: () => void;
  onDelete: () => void;
}) {
  const { t, i18n } = useTranslation();
  const renameConversation = useConversationStore((s) => s.renameConversation);
  const [editing, setEditing] = useState(false);
  const title = conversation.title || t("history.untitled");
  return (
    <div
      className={`group flex items-center gap-1 rounded-lg px-2 py-1.5 ${
        active
          ? "bg-brand-50 dark:bg-brand-950/40"
          : "hover:bg-neutral-100 dark:hover:bg-neutral-800"
      }`}
    >
      {editing ? (
        // Swapped IN for the open button rather than nested inside it — an
        // <input> in a <button> is invalid markup and eats its own clicks.
        <TitleInput
          value={conversation.title}
          placeholder={t("history.renamePlaceholder")}
          aria-label={t("history.rename")}
          onCommit={(next) => {
            renameConversation(conversation.id, next);
            setEditing(false);
          }}
          onCancel={() => setEditing(false)}
          className="flex-1 text-sm text-neutral-800 dark:text-neutral-100"
        />
      ) : (
        <>
          <button
            type="button"
            onClick={onOpen}
            className="min-w-0 flex-1 cursor-pointer rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 focus-visible:ring-offset-white dark:focus-visible:ring-offset-neutral-950"
          >
            <div
              className={`truncate text-sm ${
                active
                  ? "font-medium text-brand-700 dark:text-brand-300"
                  : "text-neutral-800 dark:text-neutral-100"
              }`}
            >
              {title}
            </div>
            <div className="mt-0.5 flex items-center gap-1 truncate text-xs text-neutral-500 dark:text-neutral-400">
              {conversation.agent && (
                <>
                  {/* The chip reads the same either way; the accessible name
                      must not — a scheduled thread never came over MCP. */}
                  <span className="sr-only">
                    {conversation.scheduled
                      ? t("history.ranOnSchedule")
                      : t("history.drivenBy", { agent: conversation.agent })}
                  </span>
                  <span
                    aria-hidden
                    className="size-1.5 shrink-0 rounded-full bg-neutral-300 dark:bg-neutral-600"
                  />
                  <span
                    aria-hidden
                    className="shrink-0 font-medium text-brand-600 dark:text-brand-400"
                  >
                    {conversation.agent}
                  </span>
                  <span aria-hidden>·</span>
                </>
              )}
              <span className="truncate">
                {/* No count on a thread that has none to show (an MCP thread opened
                    but not yet driven, a row written before the count meant tasks) —
                    "0 tasks" says less than the time alone. */}
                {conversation.taskCount
                  ? `${t("history.tasks", { count: conversation.taskCount })} · `
                  : ""}
                {relativeTime(conversation.updatedAt, i18n.language)}
              </span>
              {/* The thread's lifetime spend — the one number a history row has
                  that the transcript doesn't. Gold because it measures, and it
                  only lands once a run priced: an unpriced model shows nothing
                  rather than a $0.00 that reads as free. */}
              {conversation.spentTotal !== undefined && conversation.spentTotal > 0 && (
                <>
                  <span aria-hidden>·</span>
                  <span className="telemetry shrink-0" title={t("history.spentTip")}>
                    {formatMoney(conversation.spentTotal)}
                  </span>
                </>
              )}
            </div>
          </button>
          <Button
            variant="ghost"
            size="sm"
            className="shrink-0 px-1.5 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
            title={t("history.rename")}
            aria-label={t("history.renameAria", { title })}
            onClick={() => setEditing(true)}
          >
            <PencilIcon />
          </Button>
          <ConfirmDialog
            trigger={
              <Button
                variant="ghost-danger"
                size="sm"
                className="shrink-0 px-1.5 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
                title={t("history.delete")}
                aria-label={t("history.deleteAria", { title })}
              >
                <TrashIcon />
              </Button>
            }
            title={t("history.deleteTitle")}
            // A scheduled thread is not just a transcript — it is the memory its
            // next fire reads back, so deleting it stops the schedule. Say which
            // one, in its own words, before the click that ends it.
            description={
              schedule
                ? t("history.deleteScheduledBody", {
                    recurrence: describeRecurrence(schedule.recurrence),
                  })
                : t("history.deleteBody")
            }
            confirmLabel={t("history.delete")}
            onConfirm={onDelete}
          />
        </>
      )}
    </div>
  );
}

/** Stored transcripts, newest first — opens one in the panel, or starts a fresh one. */
export function ConversationList({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const conversations = useConversationStore((s) => s.conversations);
  const activeId = useConversationStore((s) => s.activeId);
  const openConversation = useConversationStore((s) => s.openConversation);
  const newConversation = useConversationStore((s) => s.newConversation);
  const removeConversation = useConversationStore((s) => s.removeConversation);
  // Keyed by thread, because that is how the rows ask the question. A schedule
  // always owns its own conversation, so one entry per key.
  const scheduleFor = new Map(useSchedules().map((s) => [s.conversationId, s]));

  const startNew = () => {
    newConversation();
    onClose();
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-neutral-100 px-2 py-1.5 dark:border-neutral-800">
        <Button variant="ghost" size="sm" className="flex items-center gap-1.5" onClick={onClose}>
          <BackIcon />
          {t("history.title")}
        </Button>
      </div>

      {conversations.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
          {/* Parked, not waiting on anything: history is empty because nothing
              has run yet, so the comet has no route to show — just a stub of
              trail from a run that never happened. */}
          <CometPose pose="resting" size={44} className="mb-1" />
          <div className="text-sm font-medium text-neutral-700 dark:text-neutral-200">
            {t("history.emptyTitle")}
          </div>
          <p className="max-w-[240px] text-xs text-neutral-500 dark:text-neutral-400">
            {t("history.emptyBody")}
          </p>
          <Button size="sm" className="mt-2" onClick={startNew}>
            {t("history.emptyAction")}
          </Button>
        </div>
      ) : (
        <div className="flex flex-1 flex-col gap-0.5 overflow-y-auto p-1.5">
          {conversations.map((c) => (
            <ConversationRow
              key={c.id}
              conversation={c}
              active={c.id === activeId}
              schedule={scheduleFor.get(c.id)}
              onOpen={() => {
                openConversation(c.id);
                onClose();
              }}
              onDelete={() => removeConversation(c.id)}
            />
          ))}
          <p className="mt-2 px-2 pb-1 text-center text-xs text-neutral-500 dark:text-neutral-400">
            {t("history.storedNote")}
          </p>
        </div>
      )}
    </div>
  );
}
