import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { runsHere, useConversationStore, retryTargetFrom } from "./store";
import { Markdown } from "./Markdown";
import { PlanMark } from "./PlanMark";
import { groupBursts, type Burst } from "./bursts";
import { useNow } from "./hooks";
import { toolVerbKey, toolHint, displacedHint } from "./tool-labels";
import { pendingAskId } from "./ask-gate";
import type { Message } from "../types";
import { splitErrorDetail } from "../error-detail";
import type { ErrorKind } from "@/modules/providers/error-classify";
import { formatDuration, formatTokens, hostnameOf } from "@/lib/format";
import { newIssueUrl } from "@/lib/report";
import { showReasoning } from "@/lib/prefs";
import { AddProviderDialog, useProvidersStore, activeProviderOf } from "@/modules/providers/ui";
import type { ProviderConfig } from "@/modules/providers/types";
import { Button, buttonClasses } from "@/components/Button";
import { CometPose } from "@/components/CometPose";
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  DotIcon,
  Icon,
  XIcon,
} from "@/components/Icon";
import { Bubble, BubbleContent } from "@/components/Bubble";
import {
  MessageScroller,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
  useMessageScroller,
  useMessageScrollerScrollable,
} from "@/components/MessageScroller";
import { ZoomableImage } from "@/components/ZoomableImage";
import { ArtifactCard } from "@/modules/walkthrough/ui";
import { useStoredItem } from "@/components/useStoredItem";

type HintKey =
  "badKey" | "signedOut" | "quota" | "rateLimited" | "rejected" | "network" | "noProvider";
type CtaKey = "updateKey" | "signIn" | "checkUrl" | "addProvider" | "compact";

const HINT_KEYS = {
  badKey: "chat.hint.badKey",
  signedOut: "chat.hint.signedOut",
  quota: "chat.hint.quota",
  rateLimited: "chat.hint.rateLimited",
  rejected: "chat.hint.rejected",
  network: "chat.hint.network",
  noProvider: "chat.hint.noProvider",
} as const;

const CTA_KEYS = {
  updateKey: "chat.cta.updateKey",
  signIn: "chat.cta.signIn",
  checkUrl: "chat.cta.checkUrl",
  addProvider: "chat.cta.addProvider",
  compact: "chat.cta.compact",
} as const;

/**
 * Raw provider/agent error → likely-cause key + fix (house rule: never a bare error).
 * Regexes match the raw English provider text — provider errors arrive in English
 * regardless of UI locale. `cta` opens the provider setup dialog in place.
 *
 * `signedIn` swaps the credential advice: a subscription provider holds no key,
 * so "update your API key" would send that user looking for something that
 * doesn't exist — the fix there is signing in again.
 */
function errorHint(message: string, signedIn: boolean): { key: HintKey; cta?: CtaKey } | null {
  const m = message.toLowerCase();
  // Quota first: a 403/429 body that talks about billing is not a bad key, and
  // telling the user to re-enter a working key would send them the wrong way.
  if (/usage limit|quota|out of credit|insufficient (balance|credit|funds)|billing/.test(m))
    return { key: "quota", cta: "addProvider" };
  if (/401|403|unauthorized|forbidden|invalid api key|authentication|sign-in/.test(m))
    return signedIn ? { key: "signedOut", cta: "signIn" } : { key: "badKey", cta: "updateKey" };
  if (/429|rate limit/.test(m)) return { key: "rateLimited" };
  if (/400|invalid/.test(m)) return { key: "rejected" };
  if (/failed to fetch|networkerror|network/.test(m)) return { key: "network", cta: "checkUrl" };
  if (/no (active )?provider/.test(m)) return { key: "noProvider", cta: "addProvider" };
  return null;
}

/**
 * Classified provider failure → the fix action it offers. No hint text: the
 * classified message already leads with its own actionable line, so a second
 * generic line below it would only paraphrase it. `model` gets none on purpose:
 * its fix is the header's model picker, already on screen — a dialog would
 * only stand between the user and the control that resolves it.
 */
function kindCta(kind: ErrorKind, signedIn: boolean): CtaKey | undefined {
  if (kind === "quota" || kind === "entitlement") return "addProvider";
  if (kind === "auth") return signedIn ? "signIn" : "updateKey";
  // The run already tried folding its own turns and still didn't fit, so the
  // conversation replayed into it is what's left to shrink. One button, because
  // the entire remedy is "compact and carry on" — the click compacts, and the
  // failed task re-runs itself when the summary lands.
  if (kind === "context") return "compact";
  return undefined;
}

/**
 * Whether this failure is worth a bug report — deliberately narrow.
 *
 * Almost every error here is an anticipated condition we wrote copy for: a
 * chrome:// page Chrome won't let us read, a rate limit, a wrong key, a tab
 * the user closed. Each already states its cause and its fix, and a "Report"
 * next to them would invite noise while diluting the one action that actually
 * resolves it. None of them is a bug.
 *
 * `unexpected` is set at the three emit sites that produce text nobody
 * authored — two raw exception catches and a provider failure the classifier
 * couldn't read. Those dead-end: Retry is all they offer, and when Retry fails
 * twice there is nowhere left to go. The house rule says an error must always
 * offer a way forward; for these, telling us IS the way forward.
 *
 * The hint guard is the last filter: a crash whose text still smells like
 * connectivity ("Failed to fetch") gets the network advice, not a bug report.
 */
function reportable(msg: Message, hint: HintKey | undefined): boolean {
  return msg.unexpected === true && hint === undefined;
}

/** The error notice's landmark — quiet surface, drawn accent (single-use: stays local). */
function AlertIcon({ size, className }: { size?: number; className?: string }) {
  return (
    <Icon size={size} className={className}>
      <path d="M12 4 2.8 20h18.4L12 4Z" />
      <path d="M12 10v4.5" />
      <path d="M12 17.75h.01" />
    </Icon>
  );
}

function StepIcon({ live, ok }: { live?: boolean; ok?: boolean }) {
  // The live row's motion is its label's shimmer — the band's own idiom. A
  // spinning ring here was a fourth motion language, and the one the
  // reduced-motion fallback couldn't speak.
  if (live) return <DotIcon filled className="shrink-0 text-amber-500 dark:text-amber-300" />;
  if (ok === false) return <XIcon className="shrink-0 text-red-500 dark:text-red-400" />;
  if (ok === true) return <CheckIcon className="shrink-0 text-neutral-500 dark:text-neutral-400" />;
  return <DotIcon filled className="shrink-0 text-neutral-400 dark:text-neutral-500" />;
}

/**
 * One tool call: a single quiet line by default, expandable to what the tool
 * actually saw. The transcript stays scannable, but nothing the agent did to
 * your browser is hidden from you.
 */
const StepRow = memo(function StepRow({ msg }: { msg: Message }) {
  const { t } = useTranslation();
  const key = toolVerbKey(msg.tool);
  const label = key ? t(key) : msg.tool;
  const hint = toolHint(msg.tool, msg.args);
  // The row trades the attempt for the outcome on a success, so the id the
  // call reached for moves to the drawer — "Switched to Gmail · #42" reads as
  // "Switching tab · Gmail", with "#42" one click away.
  const attempt = displacedHint(msg.tool, msg.args);
  // A failure's summary IS the error — it must stay on the visible line.
  const trailing = msg.ok === false ? msg.content : (hint ?? msg.content);
  // The row fits one line, so the drawer carries whichever fact it displaced:
  // for a failure that is the attempt itself ("switch to tab 42"), which is
  // exactly what you open a red row to find out.
  const displaced =
    msg.ok === false ? (hint ?? attempt) : (attempt ?? (hint ? msg.content : undefined));
  const expandable = !msg.live && Boolean(msg.detail || msg.images?.length);
  // A tool-less step is a local note (slash-command results): no label, and the
  // text wraps instead of truncating — a note's whole content is the point.
  const isNote = !msg.tool;

  const line = (
    <>
      <StepIcon live={msg.live} ok={msg.ok} />
      {label && (
        <span className={msg.live ? "shimmer-text font-medium" : "font-medium"}>{label}</span>
      )}
      {!msg.live && trailing && (
        <span
          className={
            isNote
              ? "min-w-0 whitespace-pre-wrap text-neutral-500 dark:text-neutral-400"
              : "truncate text-neutral-500 dark:text-neutral-400"
          }
        >
          {trailing}
        </span>
      )}
    </>
  );

  if (!expandable) {
    return (
      <div
        className={`flex gap-1.5 self-start px-1 text-xs text-neutral-500 dark:text-neutral-400 ${isNote ? "items-start" : "items-center"}`}
      >
        {line}
      </div>
    );
  }

  return (
    <details className="group max-w-full self-start px-1 text-xs text-neutral-500 dark:text-neutral-400">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 select-none hover:text-neutral-700 dark:hover:text-neutral-300">
        {line}
        <ChevronRightIcon className="shrink-0 text-neutral-400 transition-transform group-open:rotate-90 dark:text-neutral-500" />
      </summary>
      <div className="mt-1 ml-4 flex flex-col gap-1.5">
        {displaced && <div>{displaced}</div>}
        {msg.images?.map((src, i) => (
          <ZoomableImage
            key={i}
            src={src}
            alt={t("chat.screenshotAlt")}
            className="max-h-64 rounded border border-neutral-200 object-contain dark:border-neutral-700"
          />
        ))}
        {msg.detail && (
          <pre className="max-h-48 overflow-auto rounded bg-neutral-100 p-1.5 font-mono text-[11px] break-all whitespace-pre-wrap text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300">
            {msg.detail}
          </pre>
        )}
      </div>
    </details>
  );
});

/**
 * The agent paused for a decision — ask_user rendered as a card, not a step
 * row: the question is the headline. An answer is just the next user message,
 * so history replay reads it as a plain turn.
 *
 * The choices are laid out on the USER's side, right-aligned toward the
 * composer, in the same brand chip language as a queued message: tapping one
 * sends it verbatim, so it is a draft reply of yours, not a control of the
 * agent's. Answered questions keep the question and drop the chips — the reply
 * is already in the transcript right below. A question with no choices is an
 * OPEN question: no chips to tap, so the card names where the answer goes —
 * a hint while (and only while) the question still awaits one. Once answered,
 * both hint and chips drop and the bare question stays.
 */
function QuestionCard({ msg, onAnswer }: { msg: Message; onAnswer?: (text: string) => void }) {
  const { t } = useTranslation();
  const listed = Array.isArray(msg.args?.choices) ? msg.args.choices : [];
  // Deduped: a repeated option is a dead chip — and a duplicate React key.
  const choices = [
    ...new Set(listed.filter((c): c is string => typeof c === "string" && c.trim() !== "")),
  ];

  const question = (
    <Bubble variant="muted" className="border border-brand-200 dark:border-brand-900">
      <BubbleContent>
        <Markdown>{msg.content}</Markdown>
      </BubbleContent>
    </Bubble>
  );
  if (!onAnswer) return question;

  return (
    <div className="flex flex-col gap-1.5">
      {question}
      <div className="flex flex-col items-end gap-1">
        {choices.length > 0 && (
          <div className="flex max-w-[85%] flex-wrap justify-end gap-1.5">
            {choices.map((c) => (
              <Button key={c} variant="choice" size="sm" onClick={() => onAnswer(c)}>
                {c}
              </Button>
            ))}
          </div>
        )}
        <span className="text-[11px] text-neutral-500 dark:text-neutral-400">
          {t(choices.length > 0 ? "chat.askUserHint" : "chat.askUserOpenHint")}
        </span>
      </div>
    </div>
  );
}

/**
 * The run is parked on a decision: the plan the agent wants to execute. This is
 * the safety gate — nothing that changes the browser runs until the user says
 * yes, and a mid-run replan that deviates from what was approved asks again.
 * Rendered at the transcript's live edge, where the eye already is; answering
 * it resumes or ends the run, so the card itself is never persisted.
 */
function PlanApprovalCard({
  steps,
  reapproval,
  onApprove,
  onReject,
}: {
  steps: string[];
  reapproval: boolean;
  onApprove: () => void;
  onReject: () => void;
}) {
  const { t } = useTranslation();
  // The card carries only the one-click verdicts. The note channel is the
  // composer: typed text at the gate sends the plan back (ChatInput's
  // parkedAtPlan), the same way an unanswered ask_user turns it into the
  // answer field — one input surface per wait, not two.

  return (
    <div className="flex max-w-[85%] flex-col gap-2 self-start rounded-lg border border-brand-200 bg-brand-50 px-3 py-2 dark:border-brand-900 dark:bg-brand-950/60">
      <div className="text-sm font-medium text-neutral-800 dark:text-neutral-100">
        {t(reapproval ? "plan.reapprovalTitle" : "plan.approvalTitle")}
      </div>
      <ol className="flex flex-col gap-0.5 text-xs text-neutral-600 dark:text-neutral-300">
        {steps.map((step, i) => (
          <li key={i} className="flex gap-1.5">
            {/* Pre-approval every step is "ahead" — PlanMark's dot, never a
                typeface ○, so the card speaks the live plan's language. */}
            <PlanMark index={i} current={-1} />
            <span>{step}</span>
          </li>
        ))}
      </ol>
      <div className="flex gap-2">
        <Button size="sm" onClick={onApprove}>
          {t("plan.approve")}
        </Button>
        <Button size="sm" variant="ghost" onClick={onReject}>
          {t("plan.reject")}
        </Button>
      </div>
    </div>
  );
}

/**
 * The agent's checklist. Collapsed it shows only the step in flight, which is
 * the one thing you want while it works; expanded it shows the whole route so
 * you can tell early that the agent misread the task and stop it. Once the run
 * ends there is no "in flight" anymore — the card stays open so the plan does
 * not vanish into a one-line summary. E folds/unfolds every card at once
 * (plansOpen from Transcript); a summary click folds back into local control.
 */
function PlanCard({
  steps,
  current,
  settled,
  plansOpen,
}: {
  steps: string[];
  current: number;
  settled?: boolean;
  /** Global E-toggle — null leaves the card to its own default. */
  plansOpen: boolean | null;
}) {
  const { t } = useTranslation();
  const done = Math.min(current, steps.length);
  const active = settled ? undefined : steps[current];
  // What the card would do on its own: the global E-toggle when pressed,
  // otherwise open when settled / no step in flight. A summary click overrides
  // until the auto state moves again (render-time adjustment, no effect).
  const auto = plansOpen ?? (settled || !active);
  const [clicked, setClicked] = useState<boolean | null>(null);
  const [prevAuto, setPrevAuto] = useState(auto);
  if (auto !== prevAuto) {
    setPrevAuto(auto);
    setClicked(null);
  }
  const open = clicked ?? auto;

  return (
    <details
      open={open}
      onToggle={(e) => setClicked(e.currentTarget.open)}
      className="group max-w-[85%] self-start rounded-lg border border-neutral-200 px-3 py-1.5 text-xs dark:border-neutral-700"
    >
      <summary className="flex cursor-pointer list-none items-center gap-1.5 select-none">
        <ChevronRightIcon className="shrink-0 text-neutral-400 transition-transform group-open:rotate-90 dark:text-neutral-500" />
        <span className="font-medium text-neutral-700 dark:text-neutral-200">
          {t("plan.title")}
        </span>
        <span className="text-neutral-500 dark:text-neutral-400">
          {t("plan.progress", { done, total: steps.length })}
        </span>
        {active && (
          <span className="truncate text-neutral-500 dark:text-neutral-400">· {active}</span>
        )}
      </summary>
      <ol className="mt-1 flex flex-col gap-0.5">
        {/* The strike belongs to the label, not the row — on the row it drew
            straight through the check mark that says the step succeeded. */}
        {steps.map((step, i) => (
          <li key={i} className="flex items-start gap-1.5">
            <PlanMark index={i} current={current} />
            <span
              className={
                i < current
                  ? "text-neutral-400 line-through dark:text-neutral-500"
                  : i === current
                    ? "font-medium text-neutral-800 dark:text-neutral-100"
                    : "text-neutral-500 dark:text-neutral-400"
              }
            >
              {step}
            </span>
          </li>
        ))}
      </ol>
    </details>
  );
}

/**
 * Reasoning collapses to a one-line summary by default — a wall of tokens is
 * noise for most runs, and "Thought for 3m 48s" says everything that matters.
 * The show/toggle preference is one stored value for ALL blocks, so it is read
 * and watched once in MessageList and handed down.
 */
function ReasoningBlock({
  text,
  startedAt,
  elapsed,
  show,
  onToggle,
}: {
  text: string;
  /** Present while the segment is still streaming. */
  startedAt?: number | null;
  /** Recorded duration once persisted. */
  elapsed?: number;
  show: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  const live = startedAt != null;
  const now = useNow(live);

  const duration = formatDuration(live ? now - (startedAt ?? now) : (elapsed ?? 0));

  return (
    <div className="max-w-[85%] self-start rounded-lg border border-neutral-200 px-3 py-1.5 text-xs text-neutral-500 dark:border-neutral-700 dark:text-neutral-400">
      <button
        type="button"
        aria-expanded={show}
        onClick={onToggle}
        title={t("chat.reasoningToggle")}
        className="flex w-full items-center gap-1.5 rounded select-none hover:text-neutral-700 focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:outline-none dark:hover:text-neutral-300"
      >
        {live ? (
          /* The same shimmer as the run bar: one visual language for "alive". */
          <span className="shimmer-text font-medium">{t("chat.thinkingFor", { duration })}</span>
        ) : (
          <>
            <span
              aria-hidden
              className={`inline-flex transition-transform ${show ? "rotate-90" : ""}`}
            >
              <ChevronRightIcon />
            </span>
            <span className="font-medium">{t("chat.thoughtFor", { duration })}</span>
          </>
        )}
      </button>
      {show && <div className="mt-1 break-words whitespace-pre-wrap">{text}</div>}
    </div>
  );
}

/** A thought inside an expanded burst: a quiet line, not a card. Clicking it turns reasoning back on for everyone. */
function QuietThought({ msg, onToggle }: { msg: Message; onToggle: () => void }) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      onClick={onToggle}
      title={t("chat.reasoningToggle")}
      className="flex items-center gap-1.5 self-start rounded select-none hover:text-neutral-700 focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:outline-none dark:hover:text-neutral-300"
    >
      <ChevronRightIcon className="shrink-0 text-neutral-400 dark:text-neutral-500" />
      <span className="font-medium">
        {t("chat.thoughtFor", { duration: formatDuration(msg.elapsed ?? 0) })}
      </span>
    </button>
  );
}

/** Tool → plural count key for the burst summary ("5 clicks"). Unknown tools fold into "other actions". */
const BURST_COUNT_KEYS = {
  navigate: "chat.burstCount.navigate",
  snapshot: "chat.burstCount.snapshot",
  click: "chat.burstCount.click",
  type: "chat.burstCount.type",
  press_key: "chat.burstCount.pressKey",
  scroll_down: "chat.burstCount.scroll",
  scroll_up: "chat.burstCount.scroll",
  screenshot: "chat.burstCount.screenshot",
  remember: "chat.burstCount.remember",
} as const;

type BurstCountKey =
  (typeof BURST_COUNT_KEYS)[keyof typeof BURST_COUNT_KEYS] | "chat.burstCount.action";

function burstCountKey(tool: string | undefined): BurstCountKey {
  return BURST_COUNT_KEYS[tool as keyof typeof BURST_COUNT_KEYS] ?? "chat.burstCount.action";
}

/**
 * A collapsed action run: one quiet line — "6m 40s · 5 clicks, 3 entries and
 * 2 page reads" — that expands back to the rows it replaces. Counts keep the
 * run's shape without truncation; the per-action hints live on the expanded
 * rows. Live bursts stay open (same rule as the plan card) and settle closed
 * when the run ends.
 *
 * The elapsed leads, and it is the line's only duration. Trailing, it landed
 * at a different x on every burst — a ragged gold rag down the transcript —
 * and it read as a rival to the "Thinking for 3s" the summary used to open
 * with, two numbers with no stated relationship. Leading, every burst's time
 * starts at the same x (chevron + icon are fixed width), truncation eats the
 * tail of the description instead of the number, and thinking is simply part
 * of the total — where it went is on the thought rows one click away.
 */
const BurstCard = memo(function BurstCard({
  burst,
  onToggleReasoning,
}: {
  burst: Burst;
  onToggleReasoning: () => void;
}) {
  const { t, i18n } = useTranslation();
  const now = useNow(burst.live);
  /**
   * `open` is set, not bound: forced true while the burst is live (the run in
   * flight stays expanded), but never forced back to false on settle. A
   * controlled `open={live}` would snap the details shut the instant the run
   * ends — the transcript shrinks by the burst's height and the scroller reads
   * that shrink as a cue to re-follow the bottom, yanking a scrolled-up reader
   * to the end. Left uncontrolled after, the DOM keeps whatever the reader had.
   */
  const detailsRef = useCallback(
    (el: HTMLDetailsElement | null) => {
      if (el && burst.live) el.open = true;
    },
    [burst.live],
  );
  const last = burst.items[burst.items.length - 1];
  const elapsed =
    (burst.endedAt ?? (burst.live ? now : (last?.timestamp ?? burst.startedAt))) - burst.startedAt;
  const failed = burst.steps.some((s) => s.ok === false);

  const counts = new Map<BurstCountKey, number>();
  for (const s of burst.steps) {
    const key = burstCountKey(s.tool);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const list = new Intl.ListFormat(i18n.language, { type: "conjunction" }).format(
    [...counts].map(([key, count]) => t(key, { count })),
  );

  return (
    <details
      ref={detailsRef}
      className="group max-w-full self-start px-1 text-xs text-neutral-500 dark:text-neutral-400"
    >
      <summary className="flex cursor-pointer list-none items-center gap-1.5 select-none hover:text-neutral-700 dark:hover:text-neutral-300">
        <ChevronRightIcon className="shrink-0 text-neutral-400 transition-transform group-open:rotate-90 dark:text-neutral-500" />
        <StepIcon live={burst.live} ok={failed ? false : true} />
        <span className="telemetry shrink-0">{formatDuration(elapsed)}</span>
        <span className="truncate">{list}</span>
      </summary>
      <div className="mt-1 ml-4 flex flex-col gap-1.5">
        {burst.items.map((m) =>
          m.role === "step" ? (
            <StepRow key={m.id} msg={m} />
          ) : (
            <QuietThought key={m.id} msg={m} onToggle={onToggleReasoning} />
          ),
        )}
      </div>
    </details>
  );
});

/**
 * A compaction: the conversation up to here, traded for a summary of it.
 *
 * Drawn as a seam rather than a message, because that is what it is — nothing
 * was said here, something was folded. The receipt is the point: how many
 * messages and what it bought, so a compaction is never a thing that silently
 * happened to your conversation. The summary text itself opens on click for
 * anyone who wants to check what the agent will actually carry forward.
 *
 * Gold, not emerald: this measures the conversation, it does not act on it.
 */
const SummaryCard = memo(function SummaryCard({ msg }: { msg: Message }) {
  const { t } = useTranslation();
  const receipt = msg.compacted;
  return (
    <details className="group max-w-full self-stretch rounded-lg border border-amber-200 bg-amber-50/60 px-3 py-1.5 text-xs dark:border-amber-900/60 dark:bg-amber-950/30">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 select-none">
        <ChevronRightIcon className="shrink-0 text-amber-700 transition-transform group-open:rotate-90 dark:text-amber-300" />
        <span className="font-medium text-neutral-700 dark:text-neutral-200">
          {t("compact.summaryTitle")}
        </span>
        {receipt && (
          <span className="telemetry truncate">
            {t("compact.receipt", {
              count: receipt.messages,
              before: formatTokens(receipt.before),
              after: formatTokens(receipt.after),
            })}
          </span>
        )}
      </summary>
      <div className="mt-1 border-t border-amber-200/70 pt-1 dark:border-amber-900/40">
        <p className="mb-1 text-neutral-500 dark:text-neutral-400">{t("compact.explain")}</p>
        <div className="break-words whitespace-pre-wrap text-neutral-600 dark:text-neutral-300">
          {msg.content}
        </div>
      </div>
    </details>
  );
});

/**
 * The assistant bubble — rendered for stored messages and the live stream alike.
 *
 * The typing caret rides the last markdown block as an ::after, not a sibling
 * span: markdown renders block elements, so a span after them dropped the caret
 * onto a line of its own — a stray grey brick under the text.
 */
function AssistantBubble({ content, cursor }: { content: string; cursor?: boolean }) {
  return (
    <Bubble>
      <BubbleContent className={cursor ? CARET : ""}>
        <Markdown>{content}</Markdown>
      </BubbleContent>
    </Bubble>
  );
}

/**
 * Drawn, not typed. `content: '▊'` was a block-element glyph no UI sans carries,
 * so every platform fell back to whatever font had it and rendered a full-cell
 * brick — a blinking square, not a caret. A 2px box in `currentColor` is
 * font-independent and scales with the text.
 */
const CARET = [
  "[&>*:last-child]:after:content-['']",
  "[&>*:last-child]:after:ml-0.5 [&>*:last-child]:after:inline-block",
  "[&>*:last-child]:after:h-[1em] [&>*:last-child]:after:w-[2px]",
  "[&>*:last-child]:after:translate-y-[0.15em] [&>*:last-child]:after:rounded-full",
  "[&>*:last-child]:after:bg-current",
  "[&>*:last-child]:after:animate-pulse [&>*:last-child]:after:motion-reduce:animate-none",
].join(" ");

/** Ghost-button override for actions inside the red error bubble. */
const ERROR_ACTION_CLASSES =
  "text-red-700 hover:bg-red-100 dark:text-red-300 dark:hover:bg-red-900";

/**
 * Where a user message was sent from. Rendered only when the conversation
 * spans more than one tab — with a single tab every message is obviously
 * there, so the label would be noise.
 */
function TabStamp({ tab }: { tab: NonNullable<Message["tab"]> }) {
  const [iconOk, setIconOk] = useState(true);
  const label = tab.title || hostnameOf(tab.url);
  return (
    <span
      title={tab.url}
      className="flex max-w-[85%] min-w-0 items-center gap-1 text-[11px] text-neutral-500 dark:text-neutral-400"
    >
      {tab.favIconUrl && iconOk && (
        <img
          src={tab.favIconUrl}
          alt=""
          className="h-3 w-3 shrink-0 rounded-[2px]"
          onError={() => setIconOk(false)}
        />
      )}
      <span className="truncate">{label}</span>
    </span>
  );
}

/**
 * How many messages stay rendered. Everything older folds behind one row and
 * leaves the DOM entirely — not `display:none`, not `<details>` (both keep the
 * nodes and their decoded screenshots in memory), but unmounted until asked
 * for. A transcript is capped at 100 messages, so this is the difference
 * between ~100 subtrees and ~50 on the reasoning-shown path where nothing
 * folds into bursts.
 */
const RENDER_WINDOW = 50;

/**
 * The transcript's top edge: how much is folded away above, and the one click
 * that brings it back.
 *
 * Drawn as a pill centered on a rule — deliberately unlike anything else in the
 * chat. A left-aligned chevron line is this panel's disclosure idiom (tool rows,
 * bursts, thoughts), so wearing it made the only way to reach the rest of the
 * conversation read as one more tool call to skip past. A seam across the column
 * says boundary, and a pill says button.
 *
 * Manual on purpose: this fold is what keeps ~50 message subtrees and their
 * decoded screenshots out of the DOM, so auto-loading whenever a reader reaches
 * the top would quietly undo it every time they scrolled up.
 */
function EarlierFold({
  count,
  open,
  onToggle,
}: {
  count: number;
  open: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center gap-2 py-0.5">
      <span aria-hidden className="h-px flex-1 bg-neutral-200 dark:bg-neutral-800" />
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex min-w-0 items-center gap-1.5 rounded-full border border-neutral-200 bg-white px-2.5 py-1 text-[11px] font-medium text-neutral-600 transition-colors select-none hover:border-neutral-300 hover:bg-neutral-50 hover:text-neutral-900 focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:outline-none dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300 dark:hover:border-neutral-600 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
      >
        {/* Points the way the click travels: up into what is hidden, back down
            to fold it away again. */}
        <ChevronDownIcon
          size={12}
          className={`shrink-0 transition-transform ${open ? "" : "rotate-180"}`}
        />
        <span className="truncate">
          {open ? t("compact.hideEarlier") : t("compact.showEarlier", { count })}
        </span>
      </button>
      <span aria-hidden className="h-px flex-1 bg-neutral-200 dark:bg-neutral-800" />
    </div>
  );
}

const MessageBubble = memo(function MessageBubble({
  msg,
  activeProvider,
  onRetry,
  onAnswer,
  onCompact,
  showReasoningOn,
  onToggleReasoning,
  showTab,
  planSettled,
  plansOpen,
}: {
  msg: Message;
  activeProvider?: ProviderConfig;
  /** Present only on the newest error while idle — retry re-sends the same task. */
  onRetry?: () => void;
  /** Present only on the newest unanswered ask_user while idle — the answer starts the next run. */
  onAnswer?: (text: string) => void;
  /** The context-overflow fix — summarize the conversation and free up room. */
  onCompact: () => void;
  showReasoningOn: boolean;
  onToggleReasoning: () => void;
  /** The conversation spans more than one tab, so user messages name theirs. */
  showTab: boolean;
  /** The run has ended — plan cards stay open instead of collapsing to a summary. */
  planSettled?: boolean;
  /** The E-toggle's target state for every plan card — null leaves each to its default. */
  plansOpen: boolean | null;
}) {
  const { t } = useTranslation();
  switch (msg.role) {
    case "user":
      return (
        <div className="flex flex-col items-end gap-0.5">
          {showTab && msg.tab && <TabStamp tab={msg.tab} />}
          <Bubble variant="user" align="end" className="gap-1.5">
            {msg.images?.map((src, i) => (
              <ZoomableImage
                key={i}
                src={src}
                alt={t("chat.attachmentAlt", { number: i + 1 })}
                className="max-h-48 rounded border border-white/25 object-contain"
              />
            ))}
            {msg.content}
          </Bubble>
        </div>
      );
    case "assistant":
      return <AssistantBubble content={msg.content} />;
    case "summary":
      return <SummaryCard msg={msg} />;
    case "reasoning":
      return (
        <ReasoningBlock
          text={msg.content}
          elapsed={msg.elapsed}
          show={showReasoningOn}
          onToggle={onToggleReasoning}
        />
      );
    case "step":
      return msg.tool === "ask_user" ? (
        <QuestionCard msg={msg} onAnswer={onAnswer} />
      ) : (
        <StepRow msg={msg} />
      );
    case "artifact":
      return msg.artifact ? <ArtifactCard artifact={msg.artifact} /> : null;
    case "plan":
      return msg.steps?.length ? (
        <PlanCard
          steps={msg.steps}
          current={msg.current ?? 0}
          settled={planSettled}
          plansOpen={plansOpen}
        />
      ) : null;
    case "error": {
      const signedIn = Boolean(activeProvider?.auth);
      // A provider-classified error carries its kind: its lead line is the
      // whole guidance, so the generic hint is skipped and the raw English
      // tail stays behind Details. Unclassified errors keep the regex hint.
      const hint = msg.kind ? null : errorHint(msg.content, signedIn);
      const cta = msg.kind ? kindCta(msg.kind, signedIn) : hint?.cta;
      const { summary, lead, detail } = splitErrorDetail(msg.content);
      return (
        <Bubble variant="destructive">
          <div className="flex items-start gap-1.5">
            <AlertIcon size={14} className="mt-0.5 shrink-0 text-red-500 dark:text-red-400" />
            <div className="min-w-0 whitespace-pre-wrap">{msg.kind ? lead : summary}</div>
          </div>
          {detail && (
            <details className="group mt-1">
              <summary className="flex cursor-pointer list-none items-center gap-1 text-xs text-red-500 select-none hover:text-red-700 dark:text-red-400 dark:hover:text-red-300">
                <ChevronRightIcon className="shrink-0 transition-transform group-open:rotate-90" />
                {t("chat.details")}
              </summary>
              <pre className="mt-1 max-h-40 overflow-auto rounded bg-red-100/70 p-1.5 font-mono text-xs break-all whitespace-pre-wrap text-red-700 dark:bg-red-900/40 dark:text-red-300">
                {detail}
              </pre>
            </details>
          )}
          {hint && (
            <div className="mt-1 text-xs text-red-600 dark:text-red-400">
              {t(HINT_KEYS[hint.key])}
            </div>
          )}
          <div className="mt-1 -ml-2 flex flex-wrap items-center gap-1">
            {onRetry && (
              <Button variant="ghost" size="sm" onClick={onRetry} className={ERROR_ACTION_CLASSES}>
                {t("chat.retry")}
              </Button>
            )}
            {/* Compaction is not a credential problem — it needs no dialog,
                just the one action, so it never reaches AddProviderDialog. */}
            {cta === "compact" && (
              <Button
                variant="ghost"
                size="sm"
                onClick={onCompact}
                className={ERROR_ACTION_CLASSES}
              >
                {t(CTA_KEYS.compact)}
              </Button>
            )}
            {cta && cta !== "compact" && (
              <AddProviderDialog
                initialProvider={activeProvider}
                // A credential save IS the fix this error asked for — resume
                // the failed run instead of leaving the user to find Retry.
                onSaved={cta === "updateKey" || cta === "signIn" ? onRetry : undefined}
                trigger={
                  <Button variant="ghost" size="sm" className={ERROR_ACTION_CLASSES}>
                    {t(CTA_KEYS[cta])}
                  </Button>
                }
              />
            )}
            {reportable(msg, hint?.key) && (
              // A real anchor, wearing the button's classes: this action leaves
              // the extension, and Base UI's Button would stamp `type="button"`
              // onto the <a>. The summary leads so it becomes the issue title;
              // the raw body follows so the report carries what Details is
              // hiding — the one thing a maintainer cannot ask a user to retype.
              <a
                href={newIssueUrl({
                  provider: activeProvider,
                  error: detail ? `${summary}\n\n${detail}` : msg.content,
                })}
                target="_blank"
                rel="noreferrer"
                className={`inline-block ${buttonClasses("ghost", "sm")} ${ERROR_ACTION_CLASSES}`}
              >
                {t("chat.report")}
              </a>
            )}
          </div>
        </Bubble>
      );
    }
  }
});

export function MessageList() {
  const { t } = useTranslation();
  const messages = useConversationStore((s) => s.messages);
  const streamingText = useConversationStore((s) => s.streamingText);

  if (messages.length === 0 && !streamingText) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
        {/* The tagline, drawn: the comet parked at the head of a route it hasn't
            run, marching toward a target it hasn't reached. This is the panel's
            largest empty slot and the one place the question "what is this for"
            is literally being asked, so it gets the pose with somewhere to go. */}
        <CometPose pose="ready" size={54} className="mb-2" />
        <div className="text-sm font-medium text-neutral-700 dark:text-neutral-200">
          {t("chat.emptyTitle")}
        </div>
        <p className="max-w-[240px] text-xs text-neutral-500 dark:text-neutral-400">
          {t("chat.emptyBody")}
        </p>
        {/* The two things worth typing first: one whole task, and the phrase
            that turns any task into a shareable guide — the one feature whose
            trigger is a phrase rather than a control, and so findable only by
            accident without a line here. Same measure as the copy above, so the
            column reads as one paragraph-width thing rather than three widths. */}
        <div className="mt-1 flex max-w-[240px] flex-col gap-1.5 text-xs text-neutral-500 dark:text-neutral-400">
          <p>{t("chat.emptyExample")}</p>
          <p>{t("chat.emptyExampleDoc")}</p>
        </div>
      </div>
    );
  }

  return (
    <MessageScrollerProvider
      autoScroll
      // Reopened transcripts land at the live edge. Deliberately no scroll
      // anchors anywhere: an appended message never moves the view, so neither
      // your own send nor a consumed steer yanks a scrolled-up reader (or the
      // sender) off what they were reading. Follow engages by proximity only.
      defaultScrollPosition="end"
      // Same stick threshold as before the scroller: near-bottom follows.
      scrollEdgeThreshold={80}
    >
      <Transcript />
    </MessageScrollerProvider>
  );
}

/**
 * The live edge — the three rows that change on every streamed token.
 *
 * Split out of Transcript deliberately. Both streams live in the same store as
 * the message list, so a component that reads them re-renders on every delta;
 * with the list rendered in that same component, ~60 tokens a second meant
 * rebuilding every bubble, burst and step row in the transcript sixty times a
 * second. Markdown is memoized, so the parse was spared — the reconciliation of
 * a hundred subtrees was not. Subscribing here instead means a token repaints
 * exactly the one row it changed.
 */
function LiveReasoning({ show, onToggle }: { show: boolean; onToggle: () => void }) {
  const reasoningText = useConversationStore((s) => s.reasoningText);
  const reasoningStartedAt = useConversationStore((s) => s.reasoningStartedAt);
  if (!reasoningText) return null;
  return (
    <MessageScrollerItem>
      <ReasoningBlock
        text={reasoningText}
        startedAt={reasoningStartedAt}
        show={show}
        onToggle={onToggle}
      />
    </MessageScrollerItem>
  );
}

function LiveText({ running }: { running: boolean }) {
  const streamingText = useConversationStore((s) => s.streamingText);
  if (!streamingText) return null;
  return (
    <MessageScrollerItem>
      <AssistantBubble content={streamingText} cursor={running} />
    </MessageScrollerItem>
  );
}

/** Shown only in the gaps — so it, too, must watch the streams that close them. */
function WorkingDots() {
  const { t } = useTranslation();
  const busy = useConversationStore((s) => s.streamingText !== "" || s.reasoningText !== "");
  if (busy) return null;
  return (
    // These mount and unmount in every gap between tool calls, shifting the
    // column each time. The fade takes the flinch out of a move the reader
    // can't predict — deliberately the smallest beat, since it is also the
    // most frequently repeated one in the panel.
    <MessageScrollerItem className="arrive">
      <Bubble variant="muted" role="status" aria-label={t("chat.working")} className="py-2.5">
        <span className="flex items-center gap-1">
          {[0, 150, 300].map((d) => (
            <span
              key={d}
              className="thinking-dot h-1.5 w-1.5 rounded-full bg-neutral-400 dark:bg-neutral-500"
              style={{ animationDelay: `${d}ms` }}
            />
          ))}
        </span>
      </Bubble>
    </MessageScrollerItem>
  );
}

/**
 * The fold, while it happens. A compaction is a model call over a long
 * transcript — seconds of nothing, and the panel owes the same "alive" signal
 * every other wait gets. It wears the live step row's exact clothes (amber dot,
 * shimmering label), because that is what it is: work in flight, at the tail.
 *
 * It leaves no trace of its own. The summary card the worker writes replaces it
 * the moment the fold lands — same spot, same gold, now expandable — so the
 * transient state becomes the permanent record instead of stacking beside it.
 */
function CompactingRow() {
  const { t } = useTranslation();
  const compacting = useConversationStore((s) => s.compacting);
  if (!compacting) return null;
  return (
    <MessageScrollerItem>
      <div
        role="status"
        aria-live="polite"
        className="flex items-center gap-1.5 self-start px-1 text-xs text-neutral-500 dark:text-neutral-400"
      >
        <DotIcon filled className="shrink-0 text-amber-500 dark:text-amber-300" />
        <span className="shimmer-text font-medium">{t("commands.compact.running")}</span>
      </div>
    </MessageScrollerItem>
  );
}

/** Rows + jump pill. The scroller hooks must run under the Provider. */
function Transcript() {
  const { t } = useTranslation();
  const stored = useConversationStore((s) => s.messages);
  // Whether a run owns this conversation, not whether THIS panel is streaming
  // one. A panel opened onto a run already in flight (the on-page pill's click,
  // a second window) reads `status` idle and has no event stream — keyed to
  // that, the transcript closed the tail burst with a ✓, folded every row
  // behind it, and left the panel looking empty while the run worked. Same
  // predicate as the composer, /stop and the deferral gate.
  const live = useConversationStore(runsHere);
  // Narrower than `!live`: the jump pill promises an ANSWER, so a run that
  // ended on an error keeps the neutral "jump to latest".
  const settled = useConversationStore((s) => s.status === "idle") && !live;
  const retry = useConversationStore((s) => s.retry);
  const sendTask = useConversationStore((s) => s.sendTask);
  const planApproval = useConversationStore((s) => s.planApproval);
  const approvePlan = useConversationStore((s) => s.approvePlan);
  const rejectPlan = useConversationStore((s) => s.rejectPlan);
  // The same provider every other surface calls active — the error bubble's
  // "Update your API key" must open the config the failed run actually used.
  const activeProvider = useProvidersStore(activeProviderOf);
  // One global preference, read and watched once here — never per reasoning block.
  const showReasoningOn = useStoredItem(showReasoning);
  const toggleReasoning = useCallback(
    () => void showReasoning.set(!showReasoningOn),
    [showReasoningOn],
  );

  // Everything below is derived from the message list, and this component
  // re-renders on every state change the transcript watches. Memoized as one
  // block so a liveness flip — or anything else — does not redo five O(n) scans
  // over a hundred messages.
  const { messages, hasLiveStep, tappableAskId, multiTab, hasPlan } = useMemo(() => {
    // Internal entries are the model's, not the chat's — the progress note an
    // interrupted run leaves for the next run's history is written in the
    // model's language ("call read_history…") and would read as the agent
    // talking past the user. Filtered here, before grouping, so nothing
    // downstream — bursts, the ask gate, the newest-error retry — ever counts one.
    const visible = stored.filter((m) => !m.internal);
    return {
      messages: visible,
      hasLiveStep: visible.some((m) => m.live),
      // The newest unanswered question keeps its answer affordance — the gate is
      // shared with the composer's answer placeholder (ask-gate.ts).
      tappableAskId: pendingAskId(visible, live),
      // User messages name their tab only once a conversation spans more than
      // one — with a single tab every message is obviously there, so the label
      // is noise.
      multiTab:
        new Set(visible.flatMap((m) => (m.role === "user" && m.tab ? [m.tab.url] : []))).size > 1,
      hasPlan: visible.some((m) => m.role === "plan" && m.steps?.length),
    };
  }, [stored, live]);

  // `end` is "unseen content below the viewport" — the old !stuck: true once
  // the reader scrolls off the live edge, so the pill shows exactly then.
  const { end: offEnd } = useMessageScrollerScrollable();
  const { scrollToEnd } = useMessageScroller();

  // E unfolds every plan card (all steps) and folds them back. null means each
  // card follows its own default: current step only mid-run, open once settled.
  const [plansOpen, setPlansOpen] = useState<boolean | null>(null);
  useEffect(() => {
    if (!hasPlan) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "e" || e.ctrlKey || e.metaKey || e.altKey) return;
      // A Base UI overlay's own keys win, and typing must never toggle.
      if (
        document.querySelector(
          '[role="dialog"],[role="alertdialog"],[role="menu"],[role="listbox"]',
        )
      )
        return;
      if (e.target instanceof HTMLElement && e.target.closest("input,textarea,[contenteditable]"))
        return;
      // First press counters the live default: expand mid-run, compact once settled.
      setPlansOpen((v) => !(v ?? !live));
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [hasPlan, live]);

  // Where the rendered transcript starts. A compaction is the natural seam —
  // the summary already stands for everything above it — and a very long
  // uncompacted conversation gets the same treatment by count. Folded messages
  // are not hidden, they are unmounted: `display:none` and a closed <details>
  // both keep every node and every decoded screenshot alive in memory, which is
  // the thing that made a long transcript heavy in the first place.
  // A fold belongs to its transcript, so the state holds WHICH conversation is
  // unfolded rather than a bare flag: opening one and switching threads would
  // otherwise mount every message of a transcript nobody asked to expand.
  const activeId = useConversationStore((s) => s.activeId);
  const [openFor, setOpenFor] = useState<string | null>(null);
  const earlierOpen = openFor !== null && openFor === activeId;
  const toggleEarlier = useCallback(
    () => setOpenFor((id) => (id === activeId ? null : activeId)),
    [activeId],
  );
  const foldAt = useMemo(() => {
    const compactedAt = messages.map((m) => m.role).lastIndexOf("summary");
    return Math.max(compactedAt, messages.length - RENDER_WINDOW, 0);
  }, [messages]);
  const shown = earlierOpen ? messages : messages.slice(foldAt);
  // Retry lives on the newest error no newer user message has superseded — NOT
  // only the tail message. A compaction's summary card lands under the error it
  // fixed, and "compact, then retry" is the remedy the error offered; the button
  // must still be there. A user message sent since closes the error's business
  // (and is what Retry would resend), so those errors stay history.
  const lastUserIdx = messages.map((m) => m.role).lastIndexOf("user");
  const lastErrorIdx = messages.map((m) => m.role).lastIndexOf("error");
  const retryErrorId =
    !live && lastErrorIdx > lastUserIdx && retryTargetFrom(messages) !== null
      ? messages[lastErrorIdx]?.id
      : undefined;
  const answer = useCallback((text: string) => void sendTask(text), [sendTask]);
  // The context-error CTA is the only compact button — its click carries the
  // resume intent: compact, then carry on with the task that hit the wall.
  const compact = useConversationStore((s) => s.compact);
  const compactResume = useCallback(() => compact({ resume: true }), [compact]);
  const rendered = showReasoningOn
    ? shown.map((m) => ({ kind: "message" as const, msg: m }))
    : groupBursts(shown, live);

  return (
    <MessageScroller>
      <MessageScrollerViewport>
        {/* Above the content, not inside it: the scroller treats every child of
            the content as a message, and a permanent first "message" hides the
            prepend it needs to see — unfolding read as fifty new messages
            arriving and threw the reader down the transcript. Outside, the
            recovered messages prepend properly and the reading position holds. */}
        {foldAt > 0 && (
          <div className="mb-2">
            <EarlierFold count={foldAt} open={earlierOpen} onToggle={toggleEarlier} />
          </div>
        )}
        <MessageScrollerContent>
          {rendered.map((item, i) =>
            // Only the tail arrives. Everything else is either already on screen
            // or was prepended by the unfold above — and animating a prepend is
            // exactly the "fifty new messages" illusion the note above exists to
            // prevent. The tail is the one row that is genuinely new, and it is
            // a new element (keyed by id), so the class runs on mount and never
            // replays for the rows it moves off.
            item.kind === "burst" ? (
              <MessageScrollerItem
                key={item.id}
                messageId={item.id}
                className={i === rendered.length - 1 ? "arrive" : ""}
              >
                <BurstCard burst={item} onToggleReasoning={toggleReasoning} />
              </MessageScrollerItem>
            ) : (
              <MessageScrollerItem
                key={item.msg.id}
                messageId={item.msg.id}
                className={i === rendered.length - 1 ? "arrive" : ""}
              >
                <MessageBubble
                  msg={item.msg}
                  activeProvider={activeProvider}
                  showReasoningOn={showReasoningOn}
                  onToggleReasoning={toggleReasoning}
                  showTab={multiTab}
                  planSettled={!live}
                  plansOpen={plansOpen}
                  onRetry={
                    // Only the retryable error offers it — see retryErrorId.
                    item.msg.role === "error" && item.msg.id === retryErrorId ? retry : undefined
                  }
                  onAnswer={item.msg.id === tappableAskId ? answer : undefined}
                  onCompact={compactResume}
                />
              </MessageScrollerItem>
            ),
          )}
          <CompactingRow />
          <LiveReasoning show={showReasoningOn} onToggle={toggleReasoning} />
          {planApproval && (
            // `settle` rather than `arrive`: this is a discrete object asking for
            // a decision, not another line of transcript, and it should read as
            // one — it comes in from slightly under size instead of flowing up.
            <MessageScrollerItem className="settle">
              <PlanApprovalCard
                steps={planApproval.steps}
                reapproval={planApproval.reapproval}
                onApprove={approvePlan}
                onReject={rejectPlan}
              />
            </MessageScrollerItem>
          )}
          <LiveText running={live} />
          {/* Dots cover the gaps only — a live tool row carries its own spinner,
              and a parked approval is not a gap: the run is waiting on the user,
              not working, so "working…" under the card would rush a decision
              that has all the time it needs. */}
          {live && !planApproval && !hasLiveStep && <WorkingDots />}
        </MessageScrollerContent>
      </MessageScrollerViewport>
      {offEnd && (
        // Centered by a full-width flex row rather than `left-1/2
        // -translate-x-1/2`. Not because the two would collide — Tailwind v4
        // compiles `-translate-x-1/2` to the standalone `translate` property
        // (see the note in `components/chrome.ts`), which `arrive`'s filled
        // `transform: none` cannot strip. The row is simply the sturdier
        // centering, and it keeps the button clear of the real hazard of
        // `fill-mode: both`: a filled animation pins `transform` AND `opacity`
        // at animation-origin priority, which outranks author declarations — so
        // what it defeats is a raw `transform:` (inline, arbitrary-value, or an
        // SVG `transform` attribute) and any `opacity-*` utility on the same
        // element. The row also ignores pointer events, so it can span the
        // viewport without swallowing clicks on the transcript underneath it.
        <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void scrollToEnd({ behavior: "smooth" })}
            className={`arrive pointer-events-auto rounded-full border shadow-md ${
              settled
                ? // The run ended while the reader was scrolled up: say the answer
                  // is here, don't just say "scroll down". Brand accent, since the
                  // thing they were waiting for landed.
                  "border-brand-300 bg-brand-50 text-brand-800 hover:bg-brand-100 dark:border-brand-800 dark:bg-brand-950 dark:text-brand-200 dark:hover:bg-brand-900"
                : "border-neutral-200 bg-white hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-900 dark:hover:bg-neutral-800"
            }`}
          >
            {settled ? t("chat.answerReady") : t("chat.jumpToLatest")}
          </Button>
        </div>
      )}
    </MessageScroller>
  );
}
