import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { boardRunHere, runsHere, useConversationStore } from "./store";
import { DrivenTabChip } from "./DrivenTabChip";
import { PlanMark } from "./PlanMark";
import { ContextGauge } from "./ContextGauge";
import { pendingAskId } from "./ask-gate";
import { useNow, useQueueBusy } from "./hooks";
import { TipLine } from "@/modules/tips/ui";
import { Button } from "@/components/Button";
import { ChevronRightIcon } from "@/components/Icon";
import type { BridgeActive } from "@/shared/protocol";
import { EFFORT_LABEL_KEYS } from "@/modules/providers/types";
import { formatDuration, formatTokens } from "@/lib/format";

export function RunStatus() {
  const { t } = useTranslation();
  const status = useConversationStore((s) => s.status);
  const runStartedAt = useConversationStore((s) => s.runStartedAt);
  const runEndedAt = useConversationStore((s) => s.runEndedAt);
  const runStopped = useConversationStore((s) => s.runStopped);
  const replanning = useConversationStore((s) => s.replanning);
  const recording = useConversationStore((s) => s.recording);
  const usage = useConversationStore((s) => s.usage);
  const bridgeActive = useConversationStore((s) => s.bridgeActive);
  // Selecting only the plan message (reference-stable until rewritten) keeps
  // this bar from re-rendering on every unrelated message churn mid-run.
  const plan = useConversationStore((s) => s.messages.findLast((m) => m.role === "plan"));
  // Parked states: a mid-run plan approval keeps the run open but blocked on
  // the user; an ask_user ends it with the question still open. Both speak
  // "waiting", never the working shimmer/pulse.
  const awaitingApproval = useConversationStore((s) => s.planApproval !== null);
  const awaitingAnswer = useConversationStore(
    (s) =>
      pendingAskId(s.messages, runsHere(s)) !== undefined ||
      (s.activeId !== null && s.board.pendingQuestion?.conversationId === s.activeId),
  );
  // A crowded footer (queued lines, a queued run, a stop-redirect in transit)
  // evicts the band's tip — one shared rule, see useQueueBusy.
  const queueBusy = useQueueBusy();
  // A reopened panel holds no run state of its own — these ambient records
  // stand in. The board names a run still in flight on this conversation (its
  // startedAt drives the elapsed clock; the plan peek reads the transcript as
  // of reopen, not a stream); the index row keeps the summary of the run that
  // ended while the panel was away, retired by the next user message.
  const boardRun = useConversationStore(boardRunHere);
  const stop = useConversationStore((s) => s.stop);
  const lastRun = useConversationStore(
    (s) => s.conversations.find((c) => c.id === s.activeId)?.lastRun,
  );
  // The last tab a run worked — most recently driven first. The finished band
  // offers the one move left once the work is done: go look at it.
  const lastTab = useConversationStore(
    (s) => s.conversations.find((c) => c.id === s.activeId)?.tabs?.[0],
  );

  const idleVerbs = t("run.idle", { returnObjects: true });
  const [verbIdx, setVerbIdx] = useState(0);

  // This panel's own run when it has one; the board's record of the run it
  // reopened into otherwise — but never a bridge session's: that one keeps its
  // own band, which names the client and this one cannot.
  const localLive = status === "running" && runStartedAt !== null;
  const liveStartedAt = localLive
    ? runStartedAt
    : !bridgeActive && boardRun
      ? boardRun.startedAt
      : null;
  const running = liveStartedAt !== null;
  const now = useNow(running);
  // Parked speaks "waiting": the armed approval card (panel memory, re-armed
  // on reconnect) or the board's mark (a run parked while this panel was away).
  // An unanswered ask_user ends the run — it joins here, never the working verb.
  const awaiting = awaitingApproval || boardRun?.awaiting === true || awaitingAnswer;

  useEffect(() => {
    if (!running || awaiting) return;
    let rotate: ReturnType<typeof setTimeout>;
    const schedule = () => {
      // Random 1–2 min. Tools churn in under a second, so a verb that tracked
      // them read as flicker — the live rows above already name the tool.
      // The verb is mood, the shimmer is the "alive" signal; it only needs to
      // keep the bar from feeling like a frozen frame.
      rotate = setTimeout(
        () => {
          // Index 0 is the plain opener every run starts on — a fresh task
          // announcing itself as "Lollygagging" reads like the agent is
          // slacking. After that the pick is random from the rest: walking the
          // list in order means a ten-minute run only ever sees the first
          // handful, so the tail may as well not be there. Never twice in a
          // row — a repeat looks like the frozen frame this rotation exists
          // to disprove.
          setVerbIdx((i) => {
            if (idleVerbs.length < 3) return i;
            const next = 1 + Math.floor(Math.random() * (idleVerbs.length - 1));
            return next !== i ? next : next === 1 ? idleVerbs.length - 1 : next - 1;
          });
          schedule();
        },
        60_000 + Math.random() * 60_000,
      );
    };
    schedule();
    return () => clearTimeout(rotate);
  }, [running, awaiting, idleVerbs.length]);

  // A running approximation, not the run's total: this counts the usage events
  // THIS panel received, and mid-run nobody has published the authoritative sum
  // yet (the writer stamps it at the end). A panel that joined a run already in
  // flight therefore counts low until it settles — see the settled band below,
  // which swaps in the writer's complete number the moment the run ends.
  const totalTokens = usage.input + usage.output;
  const tokenNote =
    totalTokens > 0 ? ` · ${t("run.tokens", { count: formatTokens(totalTokens) })}` : "";

  // What the last run cost, kept up after it ends: while it streams the numbers
  // move too fast to read, and they are gone by the time you look.
  if (liveStartedAt === null) {
    // An external agent's work outranks the last run's summary — it is
    // happening now, and the browser is not the user's while it does. This is
    // the same run already blinking the driven tab's favicon, named here.
    if (bridgeActive) return <BridgeActiveBand active={bridgeActive} />;
    // This panel watched its run end; otherwise the stored summary of the run
    // that ended while the panel was closed stands in — same band either way.
    // A live error marks the band failed: "Done" over a 429 reads as a lie.
    //
    // The TOKENS come from the writer whenever it has stamped them; `usage`
    // stands in for the tick between the settle and that stamp landing. Both
    // say the same thing now — `usage` is the run's running total, kept on the
    // worker's run slot and re-sent whole on `query_run`, so a panel that
    // joined mid-run (a pill click, a notification, a second window) holds the
    // same figure as the one that dispatched. It used to be this panel's own
    // sum of the deltas it happened to witness, which is how a band could read
    // "3m 25s · 15.9k" for a run whose last turn alone sent 15.6k.
    const finished =
      runStartedAt !== null && runEndedAt !== null
        ? {
            startedAt: runStartedAt,
            endedAt: runEndedAt,
            input: lastRun?.input ?? usage.input,
            output: lastRun?.output ?? usage.output,
            ok: status !== "error",
            stopped: runStopped,
            // The engine rides the writer's stamp, which lands a tick after the
            // settle — same fill-in pattern as the token totals above.
            model: lastRun?.model,
            effort: lastRun?.effort,
          }
        : lastRun;
    if (!finished) return null;
    const finishedTokens = finished.input + finished.output;
    const finishedNote =
      finishedTokens > 0 ? ` · ${t("run.tokens", { count: formatTokens(finishedTokens) })}` : "";
    const failed = finished.ok === false;
    // The ink is the panel's one quiet-text pair, not its inverse: this band
    // carries the verdict, and at neutral-400/500 it read fainter than the gold
    // measurement beside it — the number out-shouting the outcome.
    return (
      <div className="arrive flex flex-col gap-0.5 border-t border-neutral-100 px-3 py-1.5 text-xs text-neutral-500 dark:border-neutral-800 dark:text-neutral-400">
        <div className="flex items-center gap-2">
          {/* Two states earn an accent here, and only these two: red for a run
              that failed, gold for the one outcome still asking something of
              the user. "Done"/"Stopped" want no colour — nothing is owed. */}
          <span
            className={
              awaitingAnswer
                ? "text-amber-700 dark:text-amber-300"
                : failed
                  ? "text-red-600 dark:text-red-400"
                  : undefined
            }
          >
            {awaitingAnswer
              ? t("run.awaitingAnswer")
              : failed
                ? t("run.failed")
                : finished.stopped === true
                  ? t("run.stopped")
                  : t("run.finished")}
          </span>
          {/* What answered — identity, not measurement, so it stays out of the
              gold telemetry AND off this crowded first row: it rides the gauge's
              row below, where a wire id has room to truncate. */}
          <span className="telemetry">
            {formatDuration(finished.endedAt - finished.startedAt)}
            {finishedNote}
          </span>
        </div>
        {/* The tab the work happened on, named — same row and same chip the live
            band wears, so the run's target doesn't vanish the moment it ends. */}
        <DrivenTabChip tab={lastTab} />
        {plan?.steps && <PlanPeek steps={plan.steps} current={plan.current ?? 0} />}
        {/* Bottom row: what answered on the left (the wire id, honest over a
            marketing name, effort appended when set), the gauge on the right —
            the number is what you read LAST, after the outcome and the
            checklist, when the only question left is whether the next message
            still fits. The band outlives the run, so both are still there when
            you go to type it. The gauge's own wrapper right-aligns, so the
            model's flex-1 just has to yield it. */}
        <div className="flex items-center gap-2">
          {finished.model && (
            <span
              className="min-w-0 flex-1 truncate"
              title={
                finished.effort
                  ? `${finished.model} · ${t(EFFORT_LABEL_KEYS[finished.effort])}`
                  : finished.model
              }
            >
              {finished.model}
              {finished.effort ? ` · ${t(EFFORT_LABEL_KEYS[finished.effort])}` : ""}
            </span>
          )}
          <ContextGauge />
        </div>
      </div>
    );
  }

  // Modulo, not a bare index: switching language mid-run swaps in a catalog
  // that may be shorter than the index we are sitting on.
  const verb = idleVerbs[verbIdx % idleVerbs.length] ?? idleVerbs[0] ?? "";

  // Parked on the user: an approval gate or an open question. The run is
  // blocked on the answer (the timer keeps counting) — nothing is working, so
  // the shimmer would be lying.
  const parked = awaiting && !replanning;
  const statusLabel = replanning
    ? // A revision was just sent and the revised plan is still being drawn. The
      // generic verb would read as "it ignored your note" — name the gap.
      t("run.revisingPlan")
    : parked
      ? awaitingApproval || boardRun?.awaiting === true
        ? t("run.awaitingApproval")
        : t("run.awaitingAnswer")
      : `${verb}…`;

  /**
   * Loud on purpose. Something is clicking and typing in your browser right now,
   * and the muted one-liner this replaced read like a footer — you could scroll
   * past it and not register that a run was live.
   *
   * `run-band-live` is the panel's one authored moment: the band rises into
   * place and a single wash of brand light crosses it, once, on mount. Taking
   * the wheel of a browser somebody is sitting in front of is the event this
   * product is *about*, and it used to happen by subtree swap — the footer
   * blinked from settled to live and shoved the transcript with no transition.
   */
  return (
    <div
      role="status"
      aria-live="polite"
      className="run-band-live flex flex-col gap-0.5 border-t border-brand-200 bg-brand-50 px-3 py-2 dark:border-brand-900 dark:bg-brand-950/60"
    >
      <div className="flex items-center gap-2 text-sm">
        {/* One motion only — the shimmering verb is the live signal, so the dot stays still. */}
        <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-full bg-amber-400" />
        {/* Keyed on the words, so a verb rotation or a park/resume fades the new
            state in rather than substituting it between frames — the wrapper
            carries the fade because `arrive` and `shimmer-text` are both the
            `animation` shorthand and would overwrite each other on one element.
            Truncates: es/pt-BR at 320px would otherwise eat the timer. */}
        <span key={statusLabel} className="arrive min-w-0 flex-1 truncate">
          {/* Gold, not brand: emerald means the agent is acting, and parked is
              the opposite — the run is stopped dead on the user. It joins the
              amber dot beside it, the board's "?" chip and the queue card's
              amber rail, which already speak for this state everywhere else. */}
          <span
            className={
              parked
                ? "font-semibold text-amber-700 dark:text-amber-300"
                : "shimmer-text font-semibold"
            }
          >
            {statusLabel}
          </span>
        </span>
        {/* Gold, beside the clock: recording is the run measuring itself, and
            the two things this row measures belong together. Red would be the
            product's only red and already means "failed" here. The dot is
            small and still — the left-hand one is the live signal, and two
            competing pulses would say nothing. */}
        {recording && (
          <span className="telemetry ml-auto flex shrink-0 items-center gap-1 text-[11px] font-semibold tracking-wide">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-amber-400" />
            {t("walkthrough.rec")}
          </span>
        )}
        <span
          className={`telemetry shrink-0 text-xs ${recording ? "" : "ml-auto"}`}
          aria-hidden="true"
        >
          {formatDuration(now - liveStartedAt)}
          {tokenNote}
        </span>
        {/* The composer's send/stop morphs away the moment a draft exists, so
            the band carries the one Stop that is always there — same control
            the bridge band already wears. */}
        <Button size="sm" variant="quiet-brand" className="-my-1 shrink-0" onClick={stop}>
          {t("chat.stop")}
        </Button>
      </div>
      {/* The run's target gets its own row: squeezed between the verb and the
          timer it truncated to a letter, and a chip you cannot read cannot be
          clicked. It belongs to the header, so it sits in the DOT's column,
          not the plan's — indented to 1.125rem its favicon landed exactly on
          the glyph column and the tab read as a fifth step. */}
      <DrivenTabChip />
      {/* One list per screen: at the plan gate the approval card right above
          carries the same steps WITH what's done and what changed, and a second
          copy of them 40px below is the clutter that made the ask hard to read.
          The band keeps what only it has — the amber status, the clock, Stop. */}
      {plan?.steps && !awaitingApproval && (
        <PlanPeek steps={plan.steps} current={plan.current ?? 0} />
      )}
      {/* Same corner as the settled band's, so the number does not move when the
          run ends — you look in one place whether it is working or done. */}
      <ContextGauge />
      {/* The working band is the one place the user watches while waiting —
          Claude Code's spinner-tip slot; idle/composer gets the same line. */}
      {!queueBusy && <TipLine className="text-brand-800/60 dark:text-brand-200/50" />}
    </div>
  );
}

/** How many plan rows the footer shows — the full card lives in the transcript. */
const PEEK_ROWS = 4;

const PEEK_WRAP =
  "flex flex-col gap-0.5 pl-[1.125rem] text-xs text-brand-800/80 dark:text-brand-200/70";

/**
 * A window onto the checklist: the step just finished (for orientation), the
 * one in flight, and what comes next. When the plan is bigger than the window,
 * the counts line stands in for the hidden rows instead of pretending the list
 * is short — and doubles as the handle that unfolds them here, where the eye
 * already is. Only then: with nothing hidden the window IS the plan, so it
 * stays inert rather than promising an expansion that would change nothing.
 * Expanded rows wrap (you opened them to read them) and scroll past ten, so a
 * twenty-step plan can never push the transcript off the panel.
 */
function PlanPeek({ steps, current }: { steps: string[]; current: number }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const done = Math.min(current, steps.length);
  const from = Math.max(0, current - 1);
  const peek = steps.slice(from, from + PEEK_ROWS);
  const hidden = steps.length - peek.length;
  const offset = open ? 0 : from;

  const rows = (open ? steps : peek).map((step, j) => {
    const i = offset + j;
    return (
      <div
        key={i}
        className={
          i === current ? "flex items-start gap-1.5 font-medium" : "flex items-start gap-1.5"
        }
      >
        <PlanMark index={i} current={current} />
        <span className={open ? "min-w-0" : "truncate"}>{step}</span>
      </div>
    );
  });

  if (hidden === 0) return <div className={PEEK_WRAP}>{rows}</div>;

  return (
    <button
      type="button"
      aria-expanded={open}
      title={t("plan.peekToggle")}
      onClick={() => setOpen((v) => !v)}
      className={`${PEEK_WRAP} cursor-pointer text-left hover:text-brand-900 dark:hover:text-brand-100`}
    >
      <div className="flex max-h-40 flex-col gap-0.5 overflow-y-auto">{rows}</div>
      <div className="flex items-center gap-1 opacity-70">
        <ChevronRightIcon className={`shrink-0 transition-transform ${open ? "rotate-90" : ""}`} />
        {t("plan.peekMore", { done, pending: steps.length - done })}
      </div>
    </button>
  );
}

/**
 * An external client is working in the browser and this panel is not the one
 * doing it — a bridge run or a direct-driving session. The driven tab already
 * carries the mark (blinking favicon dot, on-page badge); this band is the
 * panel's view of the same run: who it is, and that the user can take the
 * browser back.
 */
function BridgeActiveBand({ active }: { active: BridgeActive }) {
  const { t } = useTranslation();
  const stop = useConversationStore((s) => s.stop);
  return (
    <div
      role="status"
      aria-live="polite"
      className="arrive flex items-center gap-2 border-t border-brand-200 bg-brand-50 px-3 py-2 dark:border-brand-900 dark:bg-brand-950/60"
    >
      {/* The one motion — a breathing dot. Nothing is streaming, so the copy is
          still; the dot carries the "alive" signal the live band gives its
          shimmering verb. */}
      <span className="inline-block h-2.5 w-2.5 shrink-0 animate-pulse rounded-full bg-amber-400 motion-reduce:animate-none" />
      <span className="min-w-0 flex-1 truncate text-sm font-medium text-neutral-800 dark:text-neutral-100">
        {active.mode === "direct"
          ? t("run.bridgeDriving", { client: active.client })
          : t("run.bridgeTask", { client: active.client })}
      </span>
      <Button
        size="sm"
        variant="ghost"
        className="shrink-0"
        onClick={stop}
        title={t("run.bridgeStopTitle")}
      >
        {t("chat.stop")}
      </Button>
    </div>
  );
}
