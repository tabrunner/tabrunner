import { defineItem } from "./storage";

/**
 * Show model reasoning expanded by default. Off by default — the reasoning
 * stream is for the curious, and a collapsed "Thought for 3m 48s" line is the
 * calmer transcript. Clicking a reasoning block toggles this for all of them.
 */
export const showReasoning = defineItem<boolean>("showReasoning", false);

/** Where a background run's fresh tab starts when the task names no URL —
 *  overridable in Settings. */
export const defaultStartUrl = defineItem<string>("defaultStartUrl", "https://www.google.com");

/** The floating run-status widget's hide preference — respected across runs;
 *  re-enabled from Settings. The toolbar badge is the injection-free floor
 *  beneath it, so hiding this never leaves a run invisible — it only drops the
 *  floating pill. */
export const widgetHidden = defineItem<boolean>("widgetHidden", false);

/** One-shot migration: clear a stored "hide" so the pill's new default — show
 *  while a run is up — reaches users who turned it off in the fork era.
 *  Checked before `widgetHidden.remove()` fires, then set so it never runs
 *  again; the MV3 worker restarts constantly, so without this the user's
 *  setting would be wiped on every boot. */
export const widgetResetV1 = defineItem<boolean>("widgetResetV1", false);

/** Rotating tips under the run band and in the composer footer — on unless the
 *  user turns them off in Settings. Checked at pick time, so off applies to the
 *  very next boundary. */
export const tipsEnabled = defineItem<boolean>("tipsEnabled", true);

/** How a submitted task runs relative to you: "foreground" (the default) keeps
 *  the panel open so you watch it work, and the run brings a tab it switches to
 *  forward; "background" closes the panel once you approve the plan and never
 *  moves your screen again. Nothing else differs — the run itself is identical,
 *  same tab, same tools, same plan gate. The stored key is new as of the
 *  rename: the old "runTarget" said "this page", which named the one thing that
 *  never changed. */
export type RunMode = "background" | "foreground";

/** The toggle's last choice, kept across runs and panel opens. A working mode
 *  is a habit, not a per-run decision: someone dispatching background tasks all
 *  afternoon should not re-flip it after every run (and after every error, which
 *  is when re-flipping is most annoying). Lives here rather than in the panel
 *  store so the choice survives the panel closing itself. */
export const runModePref = defineItem<RunMode>("runMode", "foreground");

/** Documented runs — the `document` tool is offered to the model only while this
 *  is on. On by default: the tool costs nothing until the user asks for a
 *  walkthrough in their own words, and off is the switch for anyone who never
 *  wants screenshots of their browser written to disk. */
export const walkthroughsEnabled = defineItem<boolean>("walkthroughsEnabled", true);
