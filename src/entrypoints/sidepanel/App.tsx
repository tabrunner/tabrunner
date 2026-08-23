import { useEffect, useRef, useState } from "react";
import {
  MessageList,
  ChatInput,
  RunStatus,
  RunBoard,
  ConversationList,
  HistoryToggle,
  NewChatButton,
  TitleInput,
  HelpDialog,
  useConversationStore,
  boardRunHere,
} from "@/modules/conversation/ui";
import { Onboarding, useProvidersStore } from "@/modules/providers/ui";
import { initSkillsCatalog, SkillDraftDialog } from "@/modules/skills/ui";
import { SettingsMenu } from "./SettingsMenu";
import { notePanelOpen, refreshTip } from "@/modules/tips/ui";
import { Button } from "@/components/Button";
import { XIcon } from "@/components/Icon";
import { useTranslation } from "react-i18next";

/**
 * Close the panel — the run keeps going, which is the whole promise.
 *
 * Always rendered, though Chrome draws its own X right above ours: the browsers
 * that host this panel do not agree on that header (Brave draws nothing at
 * all), and `chrome.sidePanel` offers no programmatic close we could sniff to
 * know — a browser we failed to spot would leave the panel with no way out,
 * so a second X on Chrome is the price of the one X Brave needs. It takes the
 * row's end so it sits where the platform's own X does.
 */
function ClosePanelButton() {
  const { t } = useTranslation();
  return (
    <Button
      variant="ghost"
      size="sm"
      className="shrink-0 px-1.5"
      title={t("sidepanel.close")}
      aria-label={t("sidepanel.close")}
      onClick={() => window.close()}
    >
      <XIcon />
    </Button>
  );
}

export default function App() {
  const { t } = useTranslation();
  const connect = useConversationStore((s) => s.connect);
  const disconnect = useConversationStore((s) => s.disconnect);
  const stop = useConversationStore((s) => s.stop);
  // Where Esc-stop applies: this panel's run in flight (not merely queued —
  // Esc must never halt another conversation's run), or the board's run living
  // on this conversation after a reopen (status is idle then, but the Stop is
  // real). The same condition ChatInput calls "steering".
  const stopReady = useConversationStore(
    (s) => (s.status === "running" && !s.queuedRun) || boardRunHere(s) !== undefined,
  );
  // The other thing Esc can be about. A fold and a run are never in flight at
  // once (/compact parks itself while one runs), so there is nothing to
  // arbitrate — but a compaction holds the panel just as a run does, and it is
  // the one wait that used to have no way out at all.
  const compacting = useConversationStore((s) => s.compactingSince !== null);
  const cancelCompact = useConversationStore((s) => s.cancelCompact);
  // Until the first message names the conversation the header says "New chat" —
  // never a blank row.
  const chatTitle = useConversationStore(
    (s) => s.conversations.find((c) => c.id === s.activeId)?.title ?? "",
  );
  const activeId = useConversationStore((s) => s.activeId);
  const renameChat = useConversationStore((s) => s.renameConversation);
  // A fresh chat has no stored row to name yet — the title only becomes
  // editable once the first message has minted one.
  const [renaming, setRenaming] = useState(false);
  const providers = useProvidersStore((s) => s.providers);
  const loaded = useProvidersStore((s) => s.loaded);
  const load = useProvidersStore((s) => s.load);
  const [historyOpen, setHistoryOpen] = useState(false);

  useEffect(() => {
    connect();
    return () => disconnect();
  }, [connect, disconnect]);

  // Esc cancels whatever the panel is waiting on, from anywhere in it: the run
  // (the stop gesture, which auto-sends a pending queue as the next task), or a
  // compaction still summarizing. A Base UI overlay's own Esc-to-close wins:
  // with a dialog/menu open, Esc never halts work by surprise.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (
        document.querySelector(
          '[role="dialog"],[role="alertdialog"],[role="menu"],[role="listbox"]',
        )
      )
        return;
      if (compacting) {
        e.preventDefault();
        cancelCompact();
      } else if (stopReady) {
        e.preventDefault();
        stop();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [stopReady, stop, compacting, cancelCompact]);

  useEffect(() => {
    void load(); // idempotent — the store dedupes concurrent mounts
  }, [load]);

  // The slash menu's skill picker reads synchronously — warm its mirror once.
  useEffect(() => {
    initSkillsCatalog();
  }, []);

  // Tip rotation boundaries — Claude Code re-picks per turn; our run is the
  // turn: once per panel open, then again each time a run ends. A conversation
  // switch re-fires the runEndedAt effect too, which is fine — the composer is
  // re-read then anyway, and pickTip's chain dedupes a mount/run-end race.
  const runEndedAt = useConversationStore((s) => s.runEndedAt);
  const prevRunEndedAt = useRef(runEndedAt);
  useEffect(() => {
    void notePanelOpen().then(() => refreshTip());
  }, []);
  useEffect(() => {
    if (runEndedAt === prevRunEndedAt.current) return;
    prevRunEndedAt.current = runEndedAt;
    refreshTip();
  }, [runEndedAt]);

  const needsProvider = loaded && providers.length === 0;

  return (
    <div className="flex h-screen flex-col bg-white dark:bg-neutral-950">
      <header className="border-b border-neutral-200 px-3 pt-2 dark:border-neutral-800">
        {/* One row: the open chat's title, then the rare utilities quiet, then
            the hot action labeled, with Close at the row's end — where the
            platform's own X sits. A duplicate on Chrome, the only way out on
            Brave (which draws no header at all): that trade is spelled out on
            the button. No brand mark: the browser's own side-panel header
            already sits directly above with our icon and name, and a second
            wordmark is duplicate chrome. Provider/model/effort are NOT here —
            the engine picker lives in the composer footer, where the task is
            typed (the harness convention), not in a header row read a hundred
            times per change. */}
        <div className="flex items-center gap-1 pb-1">
          {renaming && activeId && !historyOpen ? (
            <TitleInput
              value={chatTitle}
              placeholder={t("history.renamePlaceholder")}
              aria-label={t("history.rename")}
              onCommit={(title) => {
                renameChat(activeId, title);
                setRenaming(false);
              }}
              onCancel={() => setRenaming(false)}
              className="mx-1 flex-1 text-sm font-medium text-neutral-700 dark:text-neutral-200"
            />
          ) : (
            <button
              type="button"
              onClick={() => activeId && setRenaming(true)}
              disabled={!activeId}
              title={activeId ? t("history.rename") : undefined}
              className={`min-w-0 flex-1 truncate rounded px-2 text-left text-sm font-medium text-neutral-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 dark:text-neutral-200 ${
                activeId ? "hover:bg-neutral-100 dark:hover:bg-neutral-800" : "cursor-default"
              }`}
            >
              {historyOpen ? "" : chatTitle || t("history.newChat")}
            </button>
          )}
          {!needsProvider && (
            <HistoryToggle open={historyOpen} onToggle={() => setHistoryOpen((v) => !v)} />
          )}
          <SettingsMenu />
          {!needsProvider && (
            <NewChatButton open={historyOpen} onToggle={() => setHistoryOpen((v) => !v)} />
          )}
          <ClosePanelButton />
        </div>
      </header>
      {/* Nothing until the provider list resolves. `needsProvider` needs
          `loaded` to mean anything, so falling through to the chat while it is
          still false shows a fresh install one frame of a composer it cannot
          use before Onboarding replaces it. */}
      {!loaded ? (
        <div className="flex-1" />
      ) : needsProvider ? (
        <Onboarding />
      ) : (
        // Keyed on the branch so the body swap gets the same beat the options
        // rail got — this is the higher-traffic of the two by a wide margin, and
        // it was the one still hard-cutting. Onboarding stays outside the key:
        // it owns a staggered `rise-in` ladder and would be animated twice.
        <div key={historyOpen ? "history" : "chat"} className="arrive flex min-h-0 flex-1 flex-col">
          {historyOpen ? (
            <ConversationList onClose={() => setHistoryOpen(false)} />
          ) : (
            <>
              <RunBoard />
              <MessageList />
              <RunStatus />
              <ChatInput />
            </>
          )}
        </div>
      )}
      {/* One instance for all three doors (/help, "?", the settings item) —
          portaled, so its tree position carries no layout weight. */}
      <HelpDialog />
      {/* /skill new's one dialog — the id rides a prop so skills/ui never
          imports conversation/ui back (slash-commands already points the other way). */}
      <SkillDraftDialog conversationId={activeId} />
    </div>
  );
}
