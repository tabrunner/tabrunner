import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ClipboardEvent, KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { boardRunHere, runsHere, useConversationStore } from "./store";
import { pendingAskId } from "./ask-gate";
import { toAttachment } from "./image";
import { recallStep, sentMessages } from "./history-recall";
import { caretVisualLine } from "./caret-line";
import { useEngine, useQueueBusy, useRestrictedPage } from "./hooks";
import { expandText, insertToken, linesOf, nextToken, shouldCollapse } from "./paste-collapse";
import { RunModeToggle } from "./RunModeToggle";
import { SlashMenu } from "./SlashMenu";
import { openHelp } from "./help-open";
import { executeSlash, findCommand, runSlash, slashItems } from "./slash-commands";
import type { SlashItem } from "./slash-commands";
import { TipLine } from "@/modules/tips/ui";
import { EnginePicker } from "@/modules/providers/ui";
import { TextArea } from "@/components/TextArea";
import { Button } from "@/components/Button";
import { Icon, XIcon } from "@/components/Icon";
import { ZoomableImage } from "@/components/ZoomableImage";

interface Attachment {
  /** The "[Image #1]" token that stands in for this image inside the task text. */
  token: string;
  dataUrl: string;
}

/** The send glyph — arrow up, the agentic-composer idiom. */
function SendIcon() {
  return (
    <Icon>
      <path d="M12 19V5" />
      <path d="m5 12 7-7 7 7" />
    </Icon>
  );
}

/** Filled square — stop, solid on the danger circle. */
function StopIcon() {
  return (
    <Icon>
      <rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor" stroke="none" />
    </Icon>
  );
}

export function ChatInput() {
  const { t } = useTranslation();
  // The draft lives in the store: a recalled queue or an ending run writes
  // straight into the composer, no effect needed to ferry it over.
  const text = useConversationStore((s) => s.draft);
  const setText = useConversationStore((s) => s.setDraft);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [attachError, setAttachError] = useState<string | null>(null);
  const status = useConversationStore((s) => s.status);
  const messages = useConversationStore((s) => s.messages);
  // Steering = typing into a run that is driving THIS conversation — the same
  // question /stop, the deferral gate and the ask gate all ask, so it comes
  // from the one predicate rather than `status`, which a panel reopened onto a
  // background run reads idle.
  const runHere = useConversationStore(runsHere);
  // An unanswered ask_user turns the composer into the answer field — the
  // placeholder says so (the card's chips/hint use the same gate, ask-gate.ts).
  const questionPending = pendingAskId(messages, runHere) !== undefined;
  // A parked plan gate does the same, stronger: the run is BLOCKED on the
  // answer with no tool boundary ahead, so a queued steer could never land.
  // Typed text is the answer — it sends the plan back with the note.
  const parkedAtPlan = useConversationStore((s) => s.planApproval !== null);
  const revisePlan = useConversationStore((s) => s.revisePlan);
  const queued = useConversationStore((s) => s.queued);
  const queueBusy = useQueueBusy();
  // Chrome forbids extensions on chrome:// and Web Store pages, so a run has
  // nothing to adopt there — the send still works (it opens a tab of its own),
  // and the footnote says so before a word is typed rather than after. True in
  // either mode: the page the run works never depended on the toggle.
  const pageBlocked = useRestrictedPage();
  const sendTask = useConversationStore((s) => s.sendTask);
  const { provider: engineProvider, setEngine } = useEngine();
  const queueMessage = useConversationStore((s) => s.queueMessage);
  const recallQueued = useConversationStore((s) => s.recallQueued);
  const stop = useConversationStore((s) => s.stop);
  const queuedRun = useConversationStore((s) => s.queuedRun);
  const boardRun = useConversationStore(boardRunHere);
  const bridgeActive = useConversationStore((s) => s.bridgeActive);
  const drivingTab = useConversationStore((s) => s.drivingTab);
  const stepBusy = useConversationStore((s) => s.pendingStepId !== null);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  /** Monotonic, so removing #1 never lets a later paste reuse its token. */
  const imageCount = useRef(0);
  /** Position in `sentHistory` (null = editing your own draft) plus the draft
   *  that browsing stashed, so ↓ past the newest hands it straight back. */
  const browse = useRef<{ index: number | null; draft: string }>({ index: null, draft: "" });
  const sentHistory = useMemo(() => sentMessages(messages), [messages]);

  const running = status === "running";
  // While our own submission only waits in the queue, input starts another
  // task instead of steering the run ahead of it.
  const steering = queuedRun ? false : runHere;
  // The composer's one button is a single morphing slot (the agentic-IDE idiom):
  // ■ Stop appears only while a live run owns this conversation AND the input is
  // empty — the moment there's text, ↑ Send/Queue takes the slot back, so the
  // two never compete for the same click.
  const stopVisible = steering && !text.trim();
  // The paste refusal only holds while the gate does. Nothing else cleared it
  // until the next send, so a run that ended on its own left a red alert pinned
  // over the composer naming a rule that had already lifted. Adjusted during
  // render like the slash menu's state below, not in an effect — the render
  // that lifts the gate is the one that must not draw the message.
  if (!steering && attachError !== null) setAttachError(null);
  // Composer sub-state lives in the store alongside the draft: the draft itself
  // has store-side writers (recalls, conversation resets), and those must reset
  // the collapse state too — two copies would drift.
  const pastedTexts = useConversationStore((s) => s.pastedTexts);
  const collapseDisabled = useConversationStore((s) => s.collapseDisabled);
  const addPastedText = useConversationStore((s) => s.addPastedText);
  const clearPastedTexts = useConversationStore((s) => s.clearPastedTexts);
  /** Caret a token insert asked for, applied on the next paint. */
  const pendingCaret = useRef<number | null>(null);

  // Slash commands: the menu state derives from the draft ("/" first, one
  // line). Esc dismisses until the next edit; the highlight lands on the
  // current value and resets whenever the item list changes. Render-time
  // adjustment, like the plan card's — no effects ferrying keystrokes.
  const slash = useMemo(() => slashItems(text), [text]);
  const slashKey = slash?.items.map((i) => i.key).join(" ") ?? "";
  const [slashState, setSlashState] = useState({ key: "", index: 0 });
  if (slashState.key !== slashKey) {
    // A picker opens with its current value highlighted — Enter untouched is a no-op.
    const current = slash?.items.findIndex((i) => i.current) ?? -1;
    setSlashState({ key: slashKey, index: current >= 0 ? current : 0 });
  }
  const [slashDismissedFor, setSlashDismissedFor] = useState<string | null>(null);
  if (slashDismissedFor !== null && slashDismissedFor !== text) setSlashDismissedFor(null);
  const slashOpen = slash !== null && slash.items.length > 0 && slashDismissedFor === null;
  const slashIndex = Math.min(slashState.index, Math.max(0, (slash?.items.length ?? 1) - 1));
  const slashActive = slashOpen && slash ? slash.items[slashIndex] : undefined;

  // Autogrow with content, capped at ~6 rows.
  useLayoutEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 132)}px`;
  }, [text]);

  // Restore the caret a token insert asked for — a layout effect, so it lands
  // before the browser paints the value (a plain effect would flash it at the
  // end of the text first).
  useLayoutEffect(() => {
    const el = areaRef.current;
    if (el && pendingCaret.current !== null) {
      el.setSelectionRange(pendingCaret.current, pendingCaret.current);
      pendingCaret.current = null;
    }
  }, [text]);

  /**
   * Focus theft, handed back. A navigation commit (or tab activation) in the
   * driven tab pulls keyboard focus out of the side panel mid-typing — Chromium
   * focuses web contents, and the user keeps typing into the void. The panel
   * can't veto the theft, so it restores the composer's focus — but ONLY for
   * the agent's own: a driving event is always agent-initiated, and a
   * navigation counts only while a step is in flight or just finished. A
   * deliberate omnibox trip or page click never gets yanked back.
   */
  const composing = useRef(false);
  const composingExpire = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastStepFlip = useRef(0);
  useEffect(() => {
    lastStepFlip.current = Date.now();
  }, [stepBusy]);

  const restoreComposerFocus = useCallback(() => {
    if (!composing.current) return;
    areaRef.current?.focus({ preventScroll: true });
  }, []);

  // The theft's focus grab can land after the event that caused it — one shared
  // retry covers both triggers. The timer re-checks `composing` at fire time,
  // so a deliberate panel move inside the window is never yanked back.
  const restoreRetry = useRef<ReturnType<typeof setTimeout> | null>(null);
  const restoreWithRetry = useCallback(() => {
    if (!composing.current) return;
    restoreComposerFocus();
    if (restoreRetry.current) clearTimeout(restoreRetry.current);
    restoreRetry.current = setTimeout(restoreComposerFocus, 350);
  }, [restoreComposerFocus]);

  // A driving event (run start, switch_tab) is always the agent moving tabs.
  useEffect(() => {
    restoreWithRetry();
  }, [drivingTab, restoreWithRetry]);

  // A navigation commit on the driven tab, gated on recent agent work.
  useEffect(() => {
    const tabId = drivingTab?.tabId;
    if (tabId === undefined) return;
    const onUpdated = (id: number, info: chrome.tabs.OnUpdatedInfo) => {
      if (id !== tabId || info.status !== "loading") return;
      if (!stepBusy && Date.now() - lastStepFlip.current > 3000) return;
      restoreWithRetry();
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
    return () => chrome.tabs.onUpdated.removeListener(onUpdated);
  }, [drivingTab?.tabId, stepBusy, restoreWithRetry]);

  const onComposerFocus = () => {
    composing.current = true;
    if (composingExpire.current) clearTimeout(composingExpire.current);
  };

  const onComposerBlur = () => {
    // Defer the verdict: focus landing on another panel control is a deliberate
    // move; the panel ending up unfocused is a theft or a page click. A theft's
    // own trigger (driving event, navigation commit) lands within moments, so
    // composing expires fast — a deliberate page click never yanks focus back
    // minutes later.
    setTimeout(() => {
      if (document.hasFocus()) {
        composing.current = false;
        return;
      }
      if (composingExpire.current) clearTimeout(composingExpire.current);
      composingExpire.current = setTimeout(() => {
        composing.current = false;
      }, 2000);
    }, 0);
  };

  /**
   * Pasted images become a "[Image #N]" token in the text plus a thumbnail.
   * The token is the handle: it lets you write "click the button in [Image #1]",
   * and deleting it drops the image from the send. Queued mid-run messages are
   * text-only, so pastes while running are explained, not swallowed.
   */
  const onPaste = async (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = [...e.clipboardData.files].filter((f) => f.type.startsWith("image/"));
    if (files.length > 0) {
      e.preventDefault();
      if (steering) {
        // At the plan gate "queue the text" doesn't exist — point at what does.
        setAttachError(t(parkedAtPlan ? "chat.planNoImages" : "chat.queueNoImages"));
        return;
      }
      setAttachError(null);
      try {
        // Tokens number in paste order (assigned before the first await); the
        // downscale/encode work itself races — an N-image paste is not N× slower.
        const added = await Promise.all(
          files.map(async (file) => ({
            token: `[Image #${++imageCount.current}]`,
            dataUrl: await toAttachment(file),
          })),
        );
        setAttachments((prev) => [...prev, ...added]);
        // The draft as it is NOW, not as it was when the paste fired: the encode
        // above is async, so `text` here is a closure from before it. Writing
        // that back would swallow whatever was typed while it ran — and, on a
        // second image pasted into the same render, drop the first one's token,
        // which is what decides whether that image is sent at all (see submit).
        const draft = useConversationStore.getState().draft;
        setText([draft.trimEnd(), ...added.map((a) => a.token)].filter(Boolean).join(" "));
      } catch {
        setAttachError(t("chat.attachFailed"));
      }
      return;
    }

    // Text paste: the FIRST big block of a draft folds into a token at the
    // caret, its full text spliced back in on send (see paste-collapse.ts).
    // Short pastes fall through to the browser's normal inline paste — and so
    // does everything after that first fold, which armed `collapseDisabled`.
    const pasted = e.clipboardData.getData("text/plain");
    if (!pasted || collapseDisabled || !shouldCollapse(pasted)) return;
    e.preventDefault();
    const el = areaRef.current;
    const caretStart = el?.selectionStart ?? text.length;
    const caretEnd = el?.selectionEnd ?? caretStart;
    const token = nextToken(
      new Set(pastedTexts.map((p) => p.token)),
      t("chat.pasteToken", { count: linesOf(pasted) }),
    );
    // The entry lands before the text write, so setDraft's prune sees the token
    // already present and keeps it.
    addPastedText({ token, content: pasted });
    const { text: newText, caret } = insertToken(text, caretStart, caretEnd, token);
    setText(newText);
    pendingCaret.current = caret;
  };

  const removeAttachment = (token: string) => {
    setAttachments((prev) => prev.filter((a) => a.token !== token));
    setText(text.replaceAll(token, "").replace(/ {2,}/g, " ").trim());
  };

  /** A sent message (or a fired command) leaves a pristine composer. */
  const resetComposer = () => {
    setText("");
    // setDraft("") above pruned everything and armed the inline override; a sent
    // message is a fresh draft, so the fold is fair game again.
    clearPastedTexts();
    setAttachError(null);
    setAttachments([]);
  };

  /** Click/Enter on a menu row: a candidate runs its command with the row's
   *  value; a command row fires at once when it takes no argument, and
   *  completes into the draft otherwise so its picker can open. */
  const acceptSlash = (item: SlashItem, thisChatOnly = false) => {
    if (!slash) return;
    if (slash.kind === "candidates") {
      runSlash(slash.command, item.key, thisChatOnly);
      resetComposer();
      return;
    }
    const command = findCommand(item.key);
    if (!command) return;
    if (command.takesArg) {
      setText(`/${command.name} `);
    } else {
      runSlash(command, undefined);
      resetComposer();
    }
  };

  const submit = () => {
    // Collapse tokens expand to their full text before the message goes out —
    // the model never sees a "[Pasted 5 lines]" placeholder.
    const task = expandText(text, pastedTexts).trim();
    if (!task) return;
    // A leading "/" is a local command — it runs against the panel's stores
    // and never reaches the model, not even as mid-run steering.
    const outcome = executeSlash(task);
    if (outcome !== "not-slash") {
      if (outcome === "executed") resetComposer();
      else setText(outcome.complete);
      return;
    }
    if (parkedAtPlan) {
      // The gate's answer, not a steer: a parked run has no next tool call a
      // queued line could ever land between. Text sends the plan back with the
      // note attached — approve/reject stay the card's one-click buttons.
      revisePlan(task);
    } else if (steering) {
      // Inserted between the next tool batches, never mid-stream.
      queueMessage(task);
    } else {
      // Only images whose token survived in the text are sent — deleting the
      // reference is how you take an image back out.
      const images = attachments.filter((a) => task.includes(a.token)).map((a) => a.dataUrl);
      sendTask(task, images);
    }
    resetComposer();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // "?" on a pristine composer opens the help sheet instead of starting a
    // draft — the GitHub/Linear (and Claude Code) convention. A task that
    // genuinely starts with "?" types any other character first, or pastes.
    if (e.key === "?" && !text && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      openHelp();
      return;
    }
    // An open slash menu owns the keys — its arrows/Tab/Enter/Esc never reach
    // history recall or submit.
    if (slashOpen && slash) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const delta = e.key === "ArrowDown" ? 1 : -1;
        setSlashState({
          key: slashKey,
          index: Math.min(Math.max(slashIndex + delta, 0), slash.items.length - 1),
        });
        return;
      }
      if (e.key === "Tab") {
        // Completion without execution: the command name (plus its arg space),
        // or the highlighted candidate swapped in for the typed arg.
        e.preventDefault();
        if (!slashActive) return;
        if (slash.kind === "candidates") {
          setText(`/${slash.command.name} ${slashActive.key}`);
        } else {
          const command = findCommand(slashActive.key);
          if (command) setText(`/${command.name}${command.takesArg ? " " : ""}`);
        }
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setSlashDismissedFor(text);
        return;
      }
      if (e.key === "Enter" && !e.shiftKey) {
        // The one menu rule: Enter takes the highlighted row. The highlight
        // opens on the current value, so an untouched picker's Enter is a
        // no-op set — never an accidental change.
        e.preventDefault();
        // ⌥ Enter scopes the pick to this chat, exactly as ⌥ does in the
        // engine picker — the same gesture, the same meaning, both ways in.
        if (slashActive) acceptSlash(slashActive, e.altKey);
        else submit();
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
      return;
    }
    // One backspace deletes a whole collapse token, not just its last bracket.
    if (e.key === "Backspace") {
      const el = areaRef.current;
      const caret = el?.selectionStart;
      if (el && caret !== undefined && caret === el.selectionEnd) {
        // Tokens are mutually non-suffix (see nextToken), so at most one can
        // sit right before the caret — no longest-match needed.
        const token = pastedTexts.find((p) => text.slice(0, caret).endsWith(p.token))?.token;
        if (token) {
          e.preventDefault();
          const newCaret = caret - token.length;
          setText(text.slice(0, newCaret) + text.slice(caret));
          pendingCaret.current = newCaret;
          return;
        }
      }
    }
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    // ↑ takes the whole queue back first — it is still unsent, so it is the
    // most likely thing you meant to edit, and merged it is one draft you can
    // rewrite end to end. Once the queue is empty ↑ walks back through what you
    // already sent, ↓ walks forward and out.
    if (e.key === "ArrowUp" && !text && queued.length > 0) {
      e.preventDefault();
      recallQueued();
      return;
    }
    // The caret's VISUAL line decides (soft wraps count): away from the edge
    // row the arrow moves the caret; only the first/last row reaches history.
    // Skip the mirror-div layout when no recall is possible anyway — ↓ with no
    // browse in flight and ↑ into an empty history always return null, and an
    // empty draft sits trivially at both edges.
    const canRecall =
      text.length > 0 &&
      (browse.current.index !== null || (e.key === "ArrowUp" && sentHistory.length > 0));
    const el = areaRef.current;
    const pos = el && canRecall ? caretVisualLine(el) : { line: 0, lines: 1 };
    const atEdge = e.key === "ArrowUp" ? pos.line === 0 : pos.line === pos.lines - 1;
    const recall = recallStep(e.key, sentHistory, {
      ...browse.current,
      text,
      atEdge,
    });
    if (!recall) return;
    e.preventDefault();
    browse.current = { index: recall.index, draft: recall.draft };
    setText(recall.text);
  };

  return (
    <div className="flex flex-col gap-2 border-t border-neutral-200 p-3 dark:border-neutral-800">
      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {attachments.map((a) => (
            <div key={a.token} className="relative">
              <ZoomableImage
                src={a.dataUrl}
                alt={a.token}
                caption={a.token.replace(/[[\]]/g, "")}
                className="h-14 w-14 rounded border border-neutral-200 object-cover dark:border-neutral-700"
              />
              <button
                type="button"
                onClick={() => removeAttachment(a.token)}
                aria-label={t("chat.removeAttachment", { token: a.token })}
                className="absolute -top-1.5 -right-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-neutral-800 text-xs text-white shadow hover:bg-neutral-900 focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:outline-none dark:bg-neutral-200 dark:text-neutral-900 dark:hover:bg-white"
              >
                <XIcon />
              </button>
              <span className="mt-0.5 block text-center text-[10px] text-neutral-500 dark:text-neutral-400">
                {a.token.replace(/[[\]]/g, "")}
              </span>
            </div>
          ))}
        </div>
      )}
      {attachError && (
        <p role="alert" className="text-xs text-red-600 dark:text-red-400">
          {attachError}
        </p>
      )}
      {/* One footnote slot, by priority: what this send is about to do outranks
          a tip. The tip is the zone's lowest-priority tenant — it renders only
          while idle with a pristine composer, since a queue card, an attachment
          or a paste hint already makes the footer tall, and the run band carries
          the tip while working (under the same eviction rule). Both concern a
          run about to start, so both go quiet once one is live. */}
      {!(running || (boardRun && !bridgeActive)) &&
        (pageBlocked ? (
          <p className="line-clamp-2 text-[11px] text-neutral-500 dark:text-neutral-400">
            {t("chat.restrictedPageHint")}
          </p>
        ) : (
          !queueBusy &&
          attachments.length === 0 &&
          !pastedTexts.some((p) => text.includes(p.token)) && <TipLine />
        ))}
      {/* One card, two tenants: the bare input on top, a footer row below with
          the run mode and the engine picker on the left and the morph button
          on the right — so the textarea never shares its width with a button
          column. */}
      <div className="relative rounded-xl border border-neutral-300 transition-colors focus-within:border-brand-500 focus-within:ring-2 focus-within:ring-brand-500 dark:border-neutral-600">
        {slashOpen && slash && (
          <SlashMenu
            items={slash.items}
            index={slashIndex}
            onHover={(index) => setSlashState({ key: slashKey, index })}
            onPick={acceptSlash}
          />
        )}
        <TextArea
          bare
          ref={areaRef}
          className="w-full"
          rows={2}
          autoFocus
          aria-label={t("chat.inputAria")}
          aria-expanded={slashOpen}
          aria-controls={slashOpen ? "slash-menu" : undefined}
          aria-activedescendant={slashActive ? `slash-menu-item-${slashActive.key}` : undefined}
          placeholder={
            parkedAtPlan
              ? t("chat.planPlaceholder")
              : steering
                ? t("chat.queuePlaceholder")
                : questionPending
                  ? t("chat.answerPlaceholder")
                  : t("chat.placeholder")
          }
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          onPaste={(e) => void onPaste(e)}
          onFocus={onComposerFocus}
          onBlur={onComposerBlur}
        />
        <div className="flex items-center gap-1 px-1.5 pb-1.5">
          <RunModeToggle />
          <EnginePicker provider={engineProvider} onPick={setEngine} />
          {pastedTexts.some((p) => text.includes(p.token)) && (
            <p
              className="min-w-0 flex-1 truncate text-right text-[11px] italic text-neutral-500 dark:text-neutral-400"
              title={t("chat.pasteHint")}
            >
              {t("chat.pasteHint")}
            </p>
          )}
          {stopVisible ? (
            <Button
              size="icon"
              variant="danger"
              className="ml-auto shrink-0"
              onClick={stop}
              title={queued.length > 0 ? t("chat.stopTitleQueued") : t("chat.stopTitle")}
              aria-label={t("chat.stop")}
            >
              <StopIcon />
            </Button>
          ) : (
            <Button
              size="icon"
              className="ml-auto shrink-0"
              onClick={submit}
              disabled={!text.trim()}
              title={
                parkedAtPlan
                  ? t("chat.planSendTitle")
                  : steering
                    ? t("chat.queueTitle")
                    : t("chat.sendTitle")
              }
              aria-label={
                parkedAtPlan ? t("chat.planSendTitle") : steering ? t("chat.queue") : t("chat.send")
              }
            >
              <SendIcon />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
