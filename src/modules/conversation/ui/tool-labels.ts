import { truncateTo } from "@/lib/format";

/**
 * Tool → i18n key for the human label ("Reading page"). Shared by the live
 * step rows, the persisted trace, and the RunStatus verb so one tool never
 * reads three different ways.
 */
const TOOL_VERB_KEYS = {
  navigate: "run.tool.navigate",
  go_back: "run.tool.go_back",
  open_tab: "run.tool.open_tab",
  close_tab: "run.tool.close_tab",
  list_tabs: "run.tool.list_tabs",
  switch_tab: "run.tool.switch_tab",
  group_tab: "run.tool.group_tab",
  snapshot: "run.tool.snapshot",
  read_page_text: "run.tool.read_page_text",
  find: "run.tool.find",
  click: "run.tool.click",
  type: "run.tool.type",
  fill: "run.tool.fill",
  evaluate: "run.tool.evaluate",
  press_key: "run.tool.press_key",
  scroll_down: "run.tool.scroll",
  scroll_up: "run.tool.scroll",
  screenshot: "run.tool.screenshot",
  read_history: "run.tool.read_history",
  read_network_requests: "run.tool.read_network_requests",
  read_console_messages: "run.tool.read_console_messages",
  remember: "run.tool.remember",
  skill: "run.tool.skill",
  save_skill: "run.tool.save_skill",
  ask_user: "run.tool.ask_user",
  done: "run.tool.done",
  retry: "run.tool.retry",
  warn: "run.tool.warn",
  interrupted: "run.tool.interrupted",
  document: "run.tool.document",
} as const;

/** Literal union, not `string` — the i18n catalog is typed and rejects widened keys. */
export type ToolVerbKey = (typeof TOOL_VERB_KEYS)[keyof typeof TOOL_VERB_KEYS];

export function toolVerbKey(tool: string | undefined): ToolVerbKey | undefined {
  if (!tool) return undefined;
  return TOOL_VERB_KEYS[tool as keyof typeof TOOL_VERB_KEYS];
}

function text(value: unknown, max = 48): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  return truncateTo(value, max);
}

/** Host only — the full URL is in the drill-down, and it never fits on one line. */
function host(value: unknown): string | undefined {
  const raw = text(value, 200);
  if (!raw) return undefined;
  try {
    return new URL(raw).host.replace(/^www\./, "");
  } catch {
    return text(raw);
  }
}

/**
 * Tools that declare an `intent` (agent/prompt.ts) — the ones whose arguments a
 * human cannot read. The phrase replaces the opaque locator only; a value the
 * call also carries is already readable and stays beside it.
 */
const INTENT_TOOLS = new Set([
  "navigate",
  "go_back",
  "open_tab",
  "click",
  "type",
  "fill",
  "evaluate",
]);

/**
 * The distinguishing argument of a tool call, short enough for one row:
 * "Navigating · news.ycombinator.com" beats three identical "Navigating" lines.
 */
export function toolHint(
  tool: string | undefined,
  args: Record<string, unknown> | undefined,
): string | undefined {
  if (!tool || !args) return undefined;
  const intent = INTENT_TOOLS.has(tool) ? text(args.intent) : undefined;
  switch (tool) {
    case "navigate":
    case "open_tab": {
      // The host is the row's only trace of where the browser went — the result
      // summary just says "Navigated successfully". On a browser agent that fact
      // outranks the model's phrase, so it leads and the phrase follows.
      const where = host(args.url);
      return where && intent ? `${where}: ${intent}` : (intent ?? where);
    }
    case "go_back":
      // Where the tab returns to is unknowable at call time — the intent is it.
      return intent;
    case "find":
      return text(args.query);
    case "click":
      return intent ?? text(args.ref);
    case "type": {
      // Same shape as fill now that typing names its field: where, then what.
      const value = text(args.text);
      return intent && value ? `${intent}: ${value}` : (intent ?? value);
    }
    case "fill": {
      // Where and what both matter — "the ZIP code: 93619-…" says what went
      // where. Only the locator is opaque, so only the locator is replaced.
      const where = intent ?? text(args.ref, 12);
      const value = text(args.text);
      return where && value ? `${where}: ${value}` : (where ?? value);
    }
    case "evaluate":
      // Without an intent the code is the action — the row must show what ran,
      // not just that it ran.
      return intent ?? text(args.expression);
    case "read_network_requests":
      return text(args.url_filter);
    case "read_history":
      return text(args.query);
    case "skill":
      // The name IS the action — "Loading skill · invoice-download".
      return text(args.name);
    case "press_key": {
      // A chord reads as the chord: "Mod+a", not just "a".
      const mods = Array.isArray(args.modifiers)
        ? args.modifiers.filter((m): m is string => typeof m === "string" && m.trim() !== "")
        : [];
      const key = text(args.key);
      return key ? [...mods, key].join("+") : undefined;
    }
    case "scroll_down":
    case "scroll_up":
      return typeof args.amount === "number" ? `${args.amount}px` : undefined;
    default:
      return undefined;
  }
}

/**
 * A hint that belongs only in the drawer: the argument that names the attempt
 * ("switch to tab 42") once the result already said it better ("Switched to
 * Gmail"). The visible row trades attempt for outcome; the drawer keeps both.
 */
export function displacedHint(
  tool: string | undefined,
  args: Record<string, unknown> | undefined,
): string | undefined {
  if (!tool || !args) return undefined;
  switch (tool) {
    case "switch_tab":
    case "group_tab":
    case "close_tab":
      // The call's only handle; the tab's title is the result's job.
      return typeof args.tab_id === "number" ? `#${args.tab_id}` : undefined;
    default:
      return undefined;
  }
}
