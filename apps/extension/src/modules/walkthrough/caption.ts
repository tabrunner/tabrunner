import { i18n } from "@/i18n";
import { truncateTo } from "@/lib/format";
import { scopeHostOf } from "@/lib/host";
import { isSensitiveLabel } from "@/modules/browser/sanitize";
import type { DocStep, Frame } from "./types";

/**
 * Frames → the numbered, imperative steps a person actually follows.
 *
 * The whole reason this beats a Scribe-style recorder: TabRunner knows what
 * each action MEANT. The model supplies an `intent` ("the Compose button") on
 * every tool that takes a locator, so a caption can say "Click Compose" where a
 * DOM-diffing recorder can only say "click #btn-42". Nothing here infers.
 *
 * Pure and i18n-only — no storage, no DOM, no provider. The optional model
 * polish pass rewrites these captions later; it must never be what makes a doc
 * readable in the first place.
 */

/**
 * The tools a reader has to perform themselves. Everything else the agent does
 * — snapshot, find, read_*, screenshot, list_tabs, plan, remember — is machinery
 * for getting the job done, not a step in the job.
 *
 * `scroll_down`/`scroll_up` are deliberately out: a doc that says "scroll down
 * 400px" reads like a mouse log, and the next action's frame already shows the
 * scrolled page. `close_tab` is housekeeping. `evaluate` IS in, because
 * page-context JS can be the step that does the actual work — dropping it would
 * leave a walkthrough with a hole exactly where the interesting part was.
 */
export const DOCUMENTED_TOOLS = new Set([
  "navigate",
  "open_tab",
  "go_back",
  "switch_tab",
  "click",
  "fill",
  "type",
  "press_key",
  "evaluate",
]);

/**
 * Tools whose frame is the destination rather than the origin. "Go to
 * gmail.com" wants the inbox underneath it, not the page you left; every other
 * action wants the screen as it looked with the target still on it.
 */
const POST_ACTION_TOOLS = new Set(["navigate", "open_tab", "go_back", "switch_tab"]);

export function isPostAction(tool: string): boolean {
  return POST_ACTION_TOOLS.has(tool);
}

/**
 * The protocol's modifier names, as a person writes them. `Mod` and `Meta` are
 * the model's vocabulary (`SUPPORTED_MODIFIERS`), not a reader's — and "Press
 * Meta+Enter" in a shared document is the mouse-log register this module
 * exists to avoid. `Mod` keeps both halves because the doc outlives the machine
 * it was recorded on: the colleague opening it may not be on the same OS.
 */
const MODIFIER_LABELS: Record<string, string> = {
  mod: "Ctrl/Cmd",
  meta: "Cmd",
  cmd: "Cmd",
  command: "Cmd",
  control: "Ctrl",
  ctrl: "Ctrl",
  alt: "Alt",
  option: "Alt",
  shift: "Shift",
};

/** Longer than this and a step title stops being scannable. */
const MAX_TARGET = 60;
/** A value a reader copies — long enough for a URL, short of a pasted essay. */
const MAX_VALUE = 200;

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function where(args: Record<string, unknown>): string {
  const url = text(args.url);
  if (!url) return text(args.intent) ?? "";
  // "Go to google.com", never "Go to www.google.com" — the doc is read by a
  // person, and the www is noise the rest of the app already drops.
  return scopeHostOf(url) ?? truncateTo(url, MAX_TARGET);
}

/**
 * Does this step's value belong in the doc, or is it the user's own secret?
 * The field label the model wrote is the tell — "the password field" masks,
 * "the search box" does not. Erring toward masking costs a reader one line of
 * "use your own"; erring the other way puts a credential in a shared document.
 */
function secretField(args: Record<string, unknown>): boolean {
  const label = [text(args.intent), text(args.ref)].filter(Boolean).join(" ");
  return label ? isSensitiveLabel(label) : false;
}

/** The imperative line and the copyable value for one documented action. */
function captionFor(frame: Frame): { caption: string; value?: string } {
  const { tool, args } = frame;
  const intent = text(args.intent);
  const t = i18n.t;

  if (frame.gap) return { caption: t("walkthrough.step.gap") };

  switch (tool) {
    case "":
      // The bookend frames: the page the reader starts on, and what it looks
      // like when the job is done.
      return { caption: t(frame.seq === 0 ? "walkthrough.step.start" : "walkthrough.step.result") };

    case "navigate":
      return { caption: t("walkthrough.step.navigate", { where: where(args) }) };

    case "open_tab":
      return { caption: t("walkthrough.step.openTab", { where: where(args) }) };

    case "go_back":
      return { caption: t("walkthrough.step.goBack") };

    case "switch_tab":
      return {
        caption: t("walkthrough.step.switchTab", {
          title: truncateTo(frame.title || intent || "", MAX_TARGET),
        }),
      };

    case "click":
      return intent
        ? { caption: t("walkthrough.step.click", { what: truncateTo(intent, MAX_TARGET) }) }
        : { caption: t("walkthrough.step.clickBare") };

    case "fill": {
      const field = intent ?? text(args.ref);
      const value = text(args.text);
      if (secretField(args)) {
        return {
          caption: field
            ? t("walkthrough.step.fillSecret", { field: truncateTo(field, MAX_TARGET) })
            : t("walkthrough.step.fillSecretBare"),
        };
      }
      if (!field) return { caption: t("walkthrough.step.fillBare"), value };
      return {
        caption: t("walkthrough.step.fill", { field: truncateTo(field, MAX_TARGET) }),
        ...(value ? { value: truncateTo(value, MAX_VALUE) } : {}),
      };
    }

    case "type": {
      const value = text(args.text);
      if (secretField(args) || !value) return { caption: t("walkthrough.step.typeSecret") };
      return { caption: t("walkthrough.step.type"), value: truncateTo(value, MAX_VALUE) };
    }

    case "press_key": {
      const mods = Array.isArray(args.modifiers)
        ? args.modifiers
            .filter((m): m is string => typeof m === "string" && m.trim() !== "")
            .map((m) => MODIFIER_LABELS[m.trim().toLowerCase()] ?? m.trim())
        : [];
      const key = text(args.key) ?? "";
      return { caption: t("walkthrough.step.pressKey", { keys: [...mods, key].join("+") }) };
    }

    case "evaluate":
      return {
        caption: intent
          ? t("walkthrough.step.evaluateIntent", { intent: truncateTo(intent, MAX_TARGET) })
          : t("walkthrough.step.evaluate"),
      };

    default:
      // A documented tool with no template is a bug, but a doc that renders the
      // tool's name beats a doc with a blank step.
      return { caption: tool };
  }
}

/**
 * The doc's steps, in order.
 *
 * Two rules do the editorial work. **Failed attempts are dropped**: the frame
 * is captured before the action, so a click that missed left one behind — and
 * dropping it is exactly what collapses "clicked, failed, retried, worked" into
 * the one step a reader should perform. **Gaps survive**: a frame we could not
 * capture becomes a visible placeholder, because a walkthrough that quietly
 * omits a step it took is worse than one that admits it has a hole.
 *
 * The bookend frames (`tool: ""`) are always kept — they never had an action to
 * succeed at.
 */
export function buildSteps(frames: Frame[]): DocStep[] {
  const kept = frames.filter((f) => f.tool === "" || f.gap || f.ok !== false);
  return kept.map((frame, i) => ({ number: i + 1, frame, ...captionFor(frame) }));
}
