import type { Event } from "@/shared/protocol";
import type { Message } from "./types";
import type { ReasoningEffort } from "@/modules/providers/types";
import { appendMessageTo, recordRunSummary, replaceMessageTo } from "./conversations";
import { buildProgressNote } from "./progress-note";
import type { ProgressStep } from "./progress-note";
import { createLogger } from "@/lib/logger";
import { formatDuration, formatMoney, formatTokens } from "@/lib/format";
import { i18n } from "@/i18n";

const log = createLogger("transcript");

function makeMsg(role: Message["role"], content: string, extra?: Partial<Message>): Message {
  return { id: crypto.randomUUID(), role, content, timestamp: Date.now(), ...extra };
}

/** Case/whitespace/trailing-punctuation-blind equality — enough to spot a
 * summary repeating streamed prose verbatim. Deliberately conservative: a
 * dedup that swallows a genuinely different summary re-creates the silence. */
function sameText(a: string, b: string): boolean {
  const norm = (s: string) =>
    s
      .trim()
      .replace(/[.!?…,:;]+$/, "")
      .replace(/\s+/g, " ")
      .toLowerCase();
  return norm(a) === norm(b);
}

/**
 * The done summary is the run's closing word — the user must never be left
 * without one. Dropping it whenever ANY prose streamed (the old gate) made
 * runs end silent the moment the model spent a one-liner mid-way; only a
 * verbatim repeat of prose already shown adds nothing.
 */
export function closingSummary(
  sawProse: boolean,
  lastProse: string | undefined,
  summary: string | undefined,
): string | null {
  const text = summary?.trim();
  if (!text) return null;
  if (sawProse && lastProse !== undefined && sameText(lastProse, text)) return null;
  return text;
}

/**
 * Background-safe transcript writer — the persistence half of the panel store's
 * `handleEvent`, usable anywhere the run's events land (the panel delegates its
 * storage here; the bridge drives it directly). One writer per run, bound to its
 * conversation id: it mirrors the event stream, closes reasoning/text segments
 * at the same points the display does, and appends/replaces transcript messages
 * through the serialized conversation storage. Keep this reducer in lockstep
 * with the store's display path — they are two views of one event stream.
 */
export class TranscriptWriter {
  private streamingText = "";
  private reasoningText = "";
  private reasoningStartedAt: number | null = null;
  private sawAssistantText = false;
  /** The newest assistant message persisted — the done summary's dedup target. */
  private lastAssistant: string | null = null;
  /** The plan card, remembered so updates rewrite it instead of stacking copies. */
  private planMsg: Message | null = null;
  /** The run's real steps, so an interrupted run can still leave a progress note. */
  private progressSteps: ProgressStep[] = [];
  /** Constructed at run launch — the summary's start line. */
  private readonly startedAt = Date.now();
  /** Cumulative tokens, from the run's usage events. `cost` rides along as a
   *  running total once a call prices — absent forever when none does. */
  private usage: { input: number; output: number; cost?: number } = { input: 0, output: 0 };
  /** The conversation's full usage, as this run's events report it: everything
   *  the thread had spent before the run, plus the run's own total. Stamped on
   *  the CONVERSATION, not on the run summary — the run is over, the usage it
   *  added is not (see ConversationMeta.contextTokens). A fold subtracts what
   *  it freed, so the number comes back down with the thread. */
  private contextTokens = 0;
  /** done after an error is the same end unwinding — stamp the summary once. */
  private summaryRecorded = false;
  /** The receipt rides the same rule: an error's unwind lands here as a done. */
  private receiptWritten = false;
  /** What answered — the run's resolved engine, from its one early event. */
  private engine: { model: string; effort?: ReasoningEffort } | null = null;

  constructor(private readonly conversationId: string) {}

  /** Append/replace fire-and-forget — the storage layer serializes writes itself. */
  private append(msg: Message): void {
    void appendMessageTo(this.conversationId, msg).catch((e) => {
      log.debug("transcript append failed:", e instanceof Error ? e.message : String(e));
    });
  }

  private replace(msg: Message): void {
    void replaceMessageTo(this.conversationId, msg).catch((e) => {
      log.debug("transcript replace failed:", e instanceof Error ? e.message : String(e));
    });
  }

  /**
   * The run's closing numbers, stamped on the conversation's index row — the
   * "Done · 2m · 40k" band a reopened panel shows reads it, the panel's own
   * run state having died with the close. The next user message retires it.
   */
  private recordSummary(ok = true, stopped = false): void {
    if (this.summaryRecorded) return;
    this.summaryRecorded = true;
    void recordRunSummary(
      this.conversationId,
      {
        startedAt: this.startedAt,
        endedAt: Date.now(),
        input: this.usage.input,
        output: this.usage.output,
        ...(this.usage.cost !== undefined ? { cost: this.usage.cost } : {}),
        ...(this.engine ? { model: this.engine.model } : {}),
        ...(this.engine?.effort ? { effort: this.engine.effort } : {}),
        ok,
        ...(stopped ? { stopped } : {}),
      },
      this.contextTokens,
    ).catch((e) => {
      log.debug("run summary write failed:", e instanceof Error ? e.message : String(e));
    });
  }

  /**
   * The run's receipt, as a quiet note where its last word landed. The band
   * above the composer says these numbers only until the next message retires
   * it; scrolled back a week later, this line is the only record a run's
   * length and spend has — the same reason the stop seam exists. Skipped when
   * nothing was measured: a run that died on provider setup spent nothing
   * worth a line.
   */
  private writeReceipt(): void {
    if (this.receiptWritten) return;
    const { input, output, cost } = this.usage;
    if (input + output <= 0) return;
    this.receiptWritten = true;
    const parts = [
      formatDuration(Date.now() - this.startedAt),
      i18n.t("run.receiptIn", { tokens: formatTokens(input) }),
      i18n.t("run.receiptOut", { tokens: formatTokens(output) }),
    ];
    if (cost !== undefined) parts.push(formatMoney(cost));
    this.append(makeMsg("step", parts.join(" · ")));
  }

  /**
   * The closing word a run that never wrote one still owes the NEXT run — not
   * the user, who watched the steps happen and reads the stop marker instead.
   * It is written for replayed history (and phrased for the model, down to the
   * read_history instruction), so it is stored `internal`: the transcript keeps
   * it, the chat never draws it.
   *
   * The steps are consumed on the way out: a closed tab emits its error and
   * then aborts the loop, so a summary-less `done` follows immediately — and
   * must not repeat the note the error already left.
   */
  private writeProgressNote(errorMessage?: string): void {
    const note = buildProgressNote(this.progressSteps, errorMessage);
    if (!note) return;
    this.progressSteps = [];
    this.append(makeMsg("assistant", note, { internal: true }));
  }

  /** Reasoning and text close at the same points the display closes them —
   *  at each other, and at every tool call. */
  private flushReasoning(): void {
    const text = this.reasoningText.trim();
    if (text) {
      this.append(
        makeMsg(
          "reasoning",
          text,
          this.reasoningStartedAt ? { elapsed: Date.now() - this.reasoningStartedAt } : undefined,
        ),
      );
    }
    this.reasoningText = "";
    this.reasoningStartedAt = null;
  }

  private flushStreaming(): void {
    const text = this.streamingText.trim();
    if (text) {
      this.sawAssistantText = true;
      this.lastAssistant = text;
      this.append(makeMsg("assistant", text));
    }
    this.streamingText = "";
  }

  /** Process one run event, persisting whatever transcript entry it implies. Synchronous: state mutations never await. */
  apply(event: Event): void {
    switch (event.type) {
      case "engine":
        this.engine = { model: event.model, ...(event.effort ? { effort: event.effort } : {}) };
        break;

      case "token":
        this.flushReasoning();
        this.streamingText += event.text;
        break;

      case "reasoning":
        this.flushStreaming();
        this.reasoningText += event.text;
        // The first delta of a segment starts its clock.
        this.reasoningStartedAt ??= Date.now();
        break;

      case "step_start":
        // Live rows are display-only — nothing to persist; just close the open
        // segments, so prose said before the call stays above it.
        this.flushReasoning();
        this.flushStreaming();
        break;

      case "step": {
        this.flushReasoning();
        this.flushStreaming();
        this.append(
          makeMsg("step", event.summary, {
            tool: event.tool,
            ok: event.ok,
            args: event.args,
            detail: event.detail,
            images: event.images,
            live: false,
          }),
        );
        // retry/warn are run-internal chatter, not work a later run resumes from.
        if (event.tool && event.tool !== "retry" && event.tool !== "warn") {
          this.progressSteps.push({
            tool: event.tool,
            summary: event.summary,
            ok: event.ok,
            args: event.args,
          });
        }
        break;
      }

      case "artifact": {
        // The deliverable lands after the run's closing word, which is where a
        // reader looks for it. Content doubles as the fallback label for any
        // surface that renders messages as plain text.
        this.flushReasoning();
        this.flushStreaming();
        this.append(
          makeMsg("artifact", event.title, {
            artifact: {
              recordingId: event.recordingId,
              title: event.title,
              frames: event.frames,
              status: event.status,
              sites: event.sites,
            },
          }),
        );
        break;
      }

      case "plan": {
        this.flushReasoning();
        this.flushStreaming();
        const plan = { steps: event.steps, current: event.current };
        if (this.planMsg) {
          // Rewritten in place — a new copy on every completed step would bury the card.
          this.planMsg = { ...this.planMsg, ...plan };
          this.replace(this.planMsg);
        } else {
          this.planMsg = makeMsg("plan", "", plan);
          this.append(this.planMsg);
        }
        break;
      }

      case "injected":
        // The loop consumed a queued message — it becomes a real transcript entry.
        this.append(makeMsg("user", event.text));
        break;

      case "usage":
        // Running totals, not a delta — the event carries the run's whole
        // spend, so this sets rather than adds. `contextTokens` is the wider
        // number riding along: the conversation's full usage, never smaller
        // than this run's own total. `cost` is the same kind of absolute —
        // and absent stays absent, so an unpriced run never reads as a free
        // one.
        this.usage = {
          input: event.input,
          output: event.output,
          ...(event.cost !== undefined ? { cost: event.cost } : {}),
        };
        if (event.contextTokens > 0) this.contextTokens = event.contextTokens;
        break;

      case "driving":
        break;

      case "error":
        this.flushReasoning();
        this.flushStreaming();
        // The run died before writing its closing summary — leave a
        // deterministic one. The error message itself never replays into
        // history, so without the note the next run would start blind.
        this.writeProgressNote(event.message);
        this.append(
          makeMsg("error", event.message, {
            kind: event.kind,
            unexpected: event.unexpected,
          }),
        );
        this.writeReceipt();
        this.recordSummary(false);
        break;

      case "done": {
        this.flushReasoning();
        this.flushStreaming();
        // The stop, marked where it happened. The band above the composer says
        // "Stopped" only until the next message retires it; scrolled back a
        // week later, this quiet line is the only thing that tells a halted run
        // from one that simply ended without a word. `stopped` means "the
        // controller was aborted", and a dead tab aborts it too — the recorded
        // summary is what tells the two apart, so a failure keeps its error
        // bubble and never gets blamed on the user.
        if (event.stopped === true && !this.summaryRecorded) {
          this.append(makeMsg("step", i18n.t("chat.runStopped")));
        }
        const closing = closingSummary(
          this.sawAssistantText,
          this.lastAssistant ?? undefined,
          event.summary,
        );
        if (closing) {
          this.lastAssistant = closing;
          this.append(makeMsg("assistant", closing));
        } else if (!event.summary?.trim() && !event.question) {
          // A stop ends the run as silently as a crash: the loop unwinds with a
          // summary-less done (a question carries its own card; every other end
          // carries a summary). The same note, so "continue" — or a redirect
          // that reuses the work — doesn't start from nothing.
          this.writeProgressNote();
        }
        this.writeReceipt();
        this.recordSummary(true, event.stopped === true);
        break;
      }
    }
  }
}
