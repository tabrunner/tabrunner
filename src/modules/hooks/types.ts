/**
 * Lifecycle webhooks — the extension-viable form of claude-code-style hooks:
 * no shell to exec here, so a rule is "POST this event's JSON to that URL".
 * Delivery is fire-and-forget; a dead endpoint never touches the run.
 */

export type HookEvent = "run_started" | "run_finished" | "ask_user" | "error";

export const HOOK_EVENTS: readonly HookEvent[] = [
  "run_started",
  "run_finished",
  "ask_user",
  "error",
];

/** One configured delivery. Header VALUES are credentials — never logged. */
export interface HookRule {
  id: string;
  event: HookEvent;
  url: string;
  headers?: Record<string, string>;
  enabled: boolean;
  createdAt: number;
  /** The Settings row's receipt — how the last delivery went. */
  lastDelivery?: { at: number; ok: boolean; status?: number };
}

export const MAX_HOOKS = 20;
export const HOOK_TIMEOUT_MS = 10_000;
/** Per-string payload bound; the whole envelope stays far under this ×8. */
export const MAX_HOOK_STRING_CHARS = 2_000;
