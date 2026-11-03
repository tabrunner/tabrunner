import type { BrowserDriver } from "@/modules/browser";
import { MCP_TOOL_PREFIX } from "@/modules/mcp";
import { i18n } from "@/i18n";
import { createLogger, truncate } from "@/lib/logger";
import type { ToolCall } from "@/modules/providers/types";
import { labelCommits } from "./commit-label";

const log = createLogger("confirm-step");

const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

/**
 * Whether this call must wait for the user's yes, and the line the card shows
 * for it. Called before the action runs, so it can only look: one page read for
 * a click, none for anything else, and never a model call.
 *
 * Three independent reasons, any one is enough:
 * - the model said the action `commits` (its own word, the main signal);
 * - the control reads as a commit in the user's language (`labelCommits`) or
 *   submits a form that takes a card;
 * - the tool is one whose effect we cannot see from here: a remote MCP tool
 *   (self-reported annotations) or `schedule_task` (unattended future work).
 *
 * The label check can only add a card, never remove one the model asked for.
 */
export async function confirmAction(call: ToolCall, driver: BrowserDriver): Promise<string | null> {
  const { name, args } = call;
  const said = args.commits === true;
  const intent = text(args.intent);

  if (name.startsWith(MCP_TOOL_PREFIX)) {
    const [server = "", ...tool] = name.slice(MCP_TOOL_PREFIX.length).split("__");
    return i18n.t("plan.confirmMcp", { tool: tool.join("__") || name, server });
  }
  if (name === "schedule_task") return i18n.t("plan.confirmSchedule", { task: text(args.task) });
  if (name === "evaluate") {
    return said ? i18n.t("plan.confirmEvaluate") + (intent ? `: ${intent}` : "") : null;
  }
  if (name !== "click" && name !== "press_key") return null;

  // Only Enter (alone or with a modifier) submits; Tab and Escape never do, so
  // the page read is skipped for them unless the model said otherwise.
  const enter = name === "press_key" && /^enter$/i.test(text(args.key));
  if (name === "press_key" && !enter && !said) return null;

  let target: Awaited<ReturnType<BrowserDriver["describeTarget"]>> = null;
  try {
    target = await driver.describeTarget(name === "click" ? text(args.ref) : null);
  } catch (e) {
    // A page that cannot be read (restricted, mid-navigation) leaves the model's
    // flag as the only signal. The action itself will fail the same way.
    log.debug("target not readable:", truncate(String(e), 120));
  }
  const targetCommits = target !== null && (labelCommits(target.name) || target.paysByCard);
  // Enter in a plain field is not a commit by its label: the focused field is
  // named "Message", not "Send". Only the card-form signal counts there.
  const readsAsCommit = name === "click" ? targetCommits : enter && target?.paysByCard === true;
  if (!said && !readsAsCommit) return null;

  return name === "click"
    ? i18n.t("plan.confirmClick", { target: target?.name || intent || text(args.ref) })
    : i18n.t("plan.confirmKey", { key: text(args.key) });
}
