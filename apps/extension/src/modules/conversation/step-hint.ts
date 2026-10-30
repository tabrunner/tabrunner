import { truncateTo } from "@/lib/format";

/**
 * The distinguishing argument of a tool call, short enough for one line —
 * "navigate · reddit.com" beats a dozen identical "navigate" rows. Background-safe
 * sibling of the panel's `toolHint` (conversation/ui/tool-labels.ts): the runtime
 * boundary keeps ui/ code out of the writer and the agent tools, so the two hint
 * functions live on their own sides of it.
 *
 * switch_tab/group_tab/close_tab are the one intentional divergence: the panel
 * drops the id once the result names the tab, while the transcript note keeps it —
 * `#42 — Switched to Gmail` pins the attempt even after the tab is gone.
 */
export function stepHint(
  tool: string | undefined,
  args: Record<string, unknown> | undefined,
): string | undefined {
  if (!tool || !args) return undefined;
  const text = (value: unknown): string | undefined =>
    typeof value === "string" && value.trim() ? truncateTo(value, 48) : undefined;
  // Tools that declare an `intent` (agent/prompt.ts) — see the panel twin for
  // why the phrase replaces the locator but never a readable value.
  const intent = ["navigate", "go_back", "open_tab", "click", "type", "fill", "evaluate"].includes(
    tool,
  )
    ? text(args.intent)
    : undefined;
  switch (tool) {
    case "navigate":
    case "open_tab": {
      const url = text(args.url);
      if (!url) return intent;
      let where = url;
      try {
        where = new URL(url).host.replace(/^www\./, "");
      } catch {
        // Not a parseable URL — the raw value is the best trace there is.
      }
      return intent ? `${where}: ${intent}` : where;
    }
    case "go_back":
      // Where the tab returns to is unknowable at call time — the intent is it.
      return intent;
    case "find":
      return text(args.query);
    case "click":
      return intent ?? text(args.ref);
    case "type": {
      const value = text(args.text);
      return intent && value ? `${intent}: ${value}` : (intent ?? value);
    }
    case "fill": {
      const where = intent ?? (typeof args.ref === "string" ? truncateTo(args.ref, 12) : undefined);
      const value = text(args.text);
      return where && value ? `${where}: ${value}` : (where ?? value);
    }
    case "evaluate":
      // The code is the action — the trace must show what ran, not just that it ran.
      return intent ?? text(args.expression);
    case "read_network_requests":
      return text(args.url_filter);
    case "read_history":
      return text(args.query);
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
    case "switch_tab":
    case "group_tab":
    case "close_tab":
      return typeof args.tab_id === "number" ? `#${args.tab_id}` : undefined;
    default:
      return undefined;
  }
}
