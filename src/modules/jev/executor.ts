import { ProviderError } from "@providerkit/core";
import type { ErrorKind } from "@providerkit/core";
import { isRestrictedUrl } from "@/modules/browser/restricted-url";
import type { SnapshotElement } from "@/modules/browser/snapshot-script";
import { createLogger } from "@/lib/logger";
import { readChoice } from "./client";
import type { ChoiceQuestion } from "./client";
import { COMMIT_THRESHOLD, commitCheck } from "./guard";
import type { JevReply } from "./hosts";
import { TOKEN_BUDGET, buildRequest, describeElement, readDecision } from "./request";
import type { Decision, DelegateTask, HistoryEntry, Op, PageView, Target } from "./request";

const log = createLogger("jev");

/**
 * The delegated stretch: Jev reads the page, picks one action, the executor
 * checks it and runs it, and round again — no planner call per page. Every way
 * out is a stop the planner hears about with its reason; none of them loops.
 */

/** A page read, plus whether the page opened a tab since the last one. */
export type Observed = PageView & { openedTab?: boolean };

/** The page, as the executor drives it. Production wraps the run's driver;
 *  tests and the bench bring their own. */
export interface ExecutorPage {
  observe(): Promise<Observed>;
  act(action: PageAction): Promise<void>;
  /** Wait out what the action set off: a load, a re-render, a suggestion list. */
  settle(action: PageAction): Promise<void>;
}

/** One step on the page. TYPE carries the text, SELECT the option's label. */
export type PageAction =
  | { op: "CLICK"; ref: string }
  | { op: "TYPE" | "SELECT"; ref: string; text: string }
  | { op: "ENTER" | "SCROLL_DOWN" | "SCROLL_UP" | "WAIT" };

/** The decision as a page step — null when an element op arrived without its
 *  element, which the request builder never offers. */
function toAction(op: Op, t: Target | undefined): PageAction | null {
  if (op === "CLICK") return t ? { op, ref: t.element.ref } : null;
  if (op === "TYPE" || op === "SELECT") {
    return t?.text !== undefined ? { op, ref: t.element.ref, text: t.text } : null;
  }
  return { op };
}

export type Ask = (
  state: unknown,
  questions: Record<string, ChoiceQuestion>,
  signal?: AbortSignal,
) => Promise<JevReply>;

export type StopReason =
  | "done"
  | "hand_back"
  | "irreversible"
  | "no_progress"
  | "repeat"
  | "unstable"
  | "unsure"
  | "stuck"
  | "max_actions"
  | "max_calls"
  | "timeout"
  | "new_tab"
  | "left_site"
  | "restricted"
  | "aborted"
  | "jev_error";

export interface DelegateStep {
  action: string;
  changed: boolean;
}

export interface DelegateReport {
  status: "done" | "handed_back" | "stopped";
  reason: StopReason;
  /** The element a hand-back stopped at, the options Jev weighed, or the error. */
  detail?: string;
  /** Set on `jev_error` when the host answered with a classified failure. */
  kind?: ErrorKind;
  steps: DelegateStep[];
  calls: number;
  inputTokens: number;
  cost: number;
  ms: number;
  url: string;
}

export const DEFAULT_ACTIONS = 20;
export const MAX_ACTIONS = 30;
const MAX_MS = 120_000;
/** jev-browser's line for both checks, measured on Wikipedia and DuckDuckGo. */
const DONE_AT = 0.85;
/** Jev choosing DONE is one vote; its own done check past even odds is the
 *  second. ponytail: tuned on `bun run bench:jev`, not derived. */
const DONE_AGREED_AT = 0.5;
const STUCK_AT = 0.85;
/** Below this joint confidence twice running, Jev is guessing. */
const UNSURE_AT = 0.2;
const NO_CHANGE_STOP = 3;
const STALE_STOP = 4;

/** A step is the same step when it is the same operation on the same thing. */
const keyOf = (op: Op, t?: Target) => `${op}|${t?.element.ref ?? ""}|${t?.text ?? ""}`;

function label(op: Op, t: Target | undefined, typed: SnapshotElement | undefined): string {
  if (!t) return op === "ENTER" && typed ? `ENTER in ${describeElement(typed)}` : op;
  const el = describeElement(t.element);
  if (op === "TYPE") return `TYPE "${t.text}" into ${el}`;
  if (op === "SELECT") return `SELECT "${t.text}" in ${el}`;
  return `CLICK ${el}`;
}

/** Jev's top operations with their odds — the detail of an unsure stop. */
const ranking = (d: Decision) => d.ranked.map((r) => `${r.op} ${r.p.toFixed(2)}`).join(", ");

/** Where the page is and what its controls hold. */
const structureOf = (v: PageView) =>
  JSON.stringify([v.url, v.elements.map((e) => [e.ref, e.name, e.value, e.checked, e.expanded])]);

/** Everything a person would notice changing. */
const printOf = (v: PageView) => JSON.stringify([structureOf(v), v.title, v.text]);

/** Is a decision made on `before` still about the same thing in `now`? Only
 *  the URL and the target count — a ticking clock elsewhere must not void it. */
function stillValid(before: PageView, now: PageView, target: Target | undefined): boolean {
  if (before.url !== now.url) return false;
  if (!target) return true;
  const was = target.element;
  const is = now.elements.find((e) => e.ref === was.ref);
  return !!is && is.name === was.name && is.kind === was.kind && is.value === was.value;
}

/**
 * The site a URL belongs to: the host's last two labels, three under a
 * two-letter country code whose second level is generic (`shop.co.uk`).
 * ponytail: a heuristic, not the public suffix list — a site on an unusual
 * suffix may read as a neighbor's. The upgrade is a PSL lookup.
 */
export function siteOf(url: string): string {
  let host: string;
  try {
    host = new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
  const labels = host.split(".");
  const [sld, tld] = labels.slice(-2);
  const keep =
    tld?.length === 2 && /^(co|com|org|net|gov|edu|ac|or|ne|go)$/.test(sld ?? "") ? 3 : 2;
  return labels.slice(-keep).join(".");
}

export async function runDelegate(
  page: ExecutorPage,
  ask: Ask,
  task: DelegateTask,
  opts: { maxActions?: number; signal?: AbortSignal; now?: () => number } = {},
): Promise<DelegateReport> {
  const now = opts.now ?? Date.now;
  const started = now();
  const maxActions = Math.min(Math.max(1, opts.maxActions ?? DEFAULT_ACTIONS), MAX_ACTIONS);
  // Decisions, not calls: the commit check rides along with an action and is
  // bounded by maxActions already. The slack is for decisions thrown away
  // because the page moved under them.
  const maxDecisions = maxActions * 2;
  let decisions = 0;
  const steps: (DelegateStep & { key: string })[] = [];
  let calls = 0;
  let inputTokens = 0;
  let cost = 0;
  let view: Observed = await page.observe();
  const site = siteOf(view.url);

  const call = async (state: unknown, questions: Record<string, ChoiceQuestion>) => {
    calls++;
    const reply = await ask(state, questions, opts.signal);
    inputTokens += reply.inputTokens;
    cost += reply.cost;
    return reply;
  };
  const end = (reason: StopReason, detail?: string, kind?: ErrorKind): DelegateReport => ({
    status:
      reason === "done"
        ? "done"
        : reason === "hand_back" || reason === "irreversible"
          ? "handed_back"
          : "stopped",
    reason,
    ...(detail ? { detail } : {}),
    ...(kind ? { kind } : {}),
    steps: steps.map(({ action, changed }) => ({ action, changed })),
    calls,
    inputTokens,
    cost,
    ms: now() - started,
    url: view.url,
  });

  let unsure = 0;
  let stale = 0;
  let retried = false;
  let typed: SnapshotElement | undefined;

  try {
    for (;;) {
      if (opts.signal?.aborted) return end("aborted");
      if (now() - started > MAX_MS) return end("timeout");
      if (isRestrictedUrl(view.url)) return end("restricted", view.url);
      if (siteOf(view.url) !== site) return end("left_site", view.url);
      if (view.openedTab) return end("new_tab");
      if (decisions++ >= maxDecisions) return end("max_calls");

      const canEnter = steps.at(-1)?.key.startsWith("TYPE|") === true;
      const history: HistoryEntry[] = steps.map(({ action, changed }) => ({ action, changed }));
      let req = buildRequest(view, task, history, canEnter);
      let reply: JevReply;
      try {
        reply = await call(req.state, req.questions);
      } catch (e) {
        // The window overflowed after all — chars/3 guessed low. Once, smaller.
        if (!(e instanceof ProviderError && e.kind === "context")) throw e;
        req = buildRequest(view, task, history, canEnter, TOKEN_BUDGET / 2);
        reply = await call(req.state, req.questions);
      }
      const d = readDecision(req, reply.answers);
      if (!d) return end("jev_error", "unreadable answer");

      if (d.done >= DONE_AT || (d.op === "DONE" && d.done >= DONE_AGREED_AT)) {
        // Judged on the page as it was a round trip ago; only a page whose
        // controls still stand as they were gets to call it done. Text alone
        // may move on — a live clock must not keep a finished stretch going.
        const fresh = await page.observe();
        if (structureOf(fresh) === structureOf(view)) return end("done");
        view = fresh;
        continue;
      }
      if (d.stuck >= STUCK_AT && steps.length >= 2) return end("stuck");
      // Said done, but its own done check disagrees: the planner looks.
      if (d.op === "DONE") return end("unsure", ranking(d));
      if (d.op === "HAND_BACK") return end("hand_back");
      unsure = d.p < UNSURE_AT ? unsure + 1 : 0;
      if (unsure >= 2) {
        return end("unsure", ranking(d));
      }
      if (steps.length >= maxActions) return end("max_actions");

      const op = d.op;
      let target = d.target;
      // Steps taken since the page last moved: none of them did anything, so
      // picking one again can't either. jev-browser's trick — the runner-up
      // gets one turn before the stretch gives up.
      const dead = steps.slice(steps.findLastIndex((s) => s.changed) + 1);
      const again = dead.find((s) => s.key === keyOf(op, target));
      if (again) {
        const fallback = d.fallback;
        if (retried || !fallback || dead.some((s) => s.key === keyOf(op, fallback))) {
          return end("repeat", again.action);
        }
        target = fallback;
        retried = true;
      }

      const action = toAction(op, target);
      if (!action) return end("jev_error", "unreadable answer");

      const before = await page.observe();
      if (!stillValid(view, before, target)) {
        view = before;
        if (++stale >= STALE_STOP) return end("unstable");
        continue;
      }
      stale = 0;

      if (op === "CLICK" || op === "ENTER") {
        const check = commitCheck(
          before,
          task.goal,
          op === "CLICK" ? "click" : "press Enter in",
          op === "CLICK" ? target?.element : typed,
        );
        const answer = readChoice((await call(check.state, check.questions)).answers.commits, [
          "YES",
          "NO",
        ]);
        const commits = answer?.ranked.find((r) => r.id === "YES")?.p ?? 1;
        if (commits >= COMMIT_THRESHOLD) {
          return end("irreversible", label(op, target, typed));
        }
      }

      try {
        await page.act(action);
      } catch (e) {
        // The target went away between the look and the act — a stale step.
        log.debug("act failed", { op, error: e instanceof Error ? e.message : String(e) });
        view = await page.observe();
        if (++stale >= STALE_STOP) return end("unstable");
        continue;
      }
      await page.settle(action);
      const after = await page.observe();
      const changed = printOf(after) !== printOf(before);
      steps.push({ action: label(op, target, typed), changed, key: keyOf(op, target) });
      if (changed) retried = false;
      typed = op === "TYPE" ? target?.element : undefined;
      view = after;
      const recent = steps.slice(-NO_CHANGE_STOP);
      if (recent.length === NO_CHANGE_STOP && recent.every((s) => !s.changed)) {
        return end("no_progress");
      }
    }
  } catch (e) {
    if (opts.signal?.aborted) return end("aborted");
    if (e instanceof ProviderError) return end("jev_error", e.message, e.kind);
    return end("jev_error", e instanceof Error ? e.message : String(e));
  }
}
