import { createWriteQueue, defineItem } from "@/lib/storage";
import { i18n } from "@/i18n";
import { validOutboundUrl } from "@/lib/url";
import { HOOK_EVENTS, MAX_HOOKS, type HookEvent, type HookRule } from "./types";

/**
 * The webhook registry — the schedule store's shape again: validation at save,
 * the cap enforced here so no caller carries its own version of the limit.
 * URL rule is shared with the MCP client: https anywhere, loopback http only.
 */

/** Public so the options page can read it reactively (useStoredItem). */
export const hookRulesItem = defineItem<HookRule[]>("hook-rules", []);

const serialized = createWriteQueue();

export function listHookRules(): Promise<HookRule[]> {
  return hookRulesItem.get();
}

export type SaveResult =
  | { ok: true; rule: HookRule }
  | { ok: false; error: string };

const ERRORS = {
  tooMany: "hooks.errors.tooMany",
  invalidUrl: "hooks.errors.invalidUrl",
  badEvent: "hooks.errors.badEvent",
} as const;

export interface HookInput {
  /** Absent = create. Present = replace that record, keeping createdAt. */
  id?: string;
  event: HookEvent;
  url: string;
  headers?: Record<string, string>;
  enabled?: boolean;
}

export function saveHook(input: HookInput): Promise<SaveResult> {
  return serialized(async (): Promise<SaveResult> => {
    if (!HOOK_EVENTS.includes(input.event)) return { ok: false, error: i18n.t(ERRORS.badEvent) };
    if (!validOutboundUrl(input.url.trim())) return { ok: false, error: i18n.t(ERRORS.invalidUrl) };

    const list = await hookRulesItem.get();
    const id = input.id ?? crypto.randomUUID();
    const existing = list.findIndex((r) => r.id === id);
    if (existing < 0 && list.length >= MAX_HOOKS)
      return { ok: false, error: i18n.t(ERRORS.tooMany, { max: MAX_HOOKS }) };

    const headers = Object.keys(input.headers ?? {}).length ? input.headers : undefined;
    // A saved rule starts fresh: lastDelivery describes the PREVIOUS record's
    // wire, and carrying it across an edit would report someone else's sends.
    const rule: HookRule = {
      id,
      event: input.event,
      url: input.url.trim(),
      ...(headers ? { headers } : {}),
      enabled: input.enabled ?? true,
      createdAt: existing < 0 ? Date.now() : list[existing]!.createdAt,
    };
    await hookRulesItem.set(existing < 0 ? [...list, rule] : list.with(existing, rule));
    return { ok: true, rule };
  });
}

export function deleteHook(id: string): Promise<boolean> {
  return serialized(async () => {
    const list = await hookRulesItem.get();
    const next = list.filter((r) => r.id !== id);
    if (next.length === list.length) return false;
    await hookRulesItem.set(next);
    return true;
  });
}

export function setHookEnabled(id: string, enabled: boolean): Promise<boolean> {
  return serialized(async () => {
    const list = await hookRulesItem.get();
    const i = list.findIndex((r) => r.id === id);
    if (i < 0) return false;
    await hookRulesItem.set(list.with(i, { ...list[i]!, enabled }));
    return true;
  });
}

/** Stamp how the last delivery went — written by fire.ts, shown by Settings. */
export async function stampDelivery(
  id: string,
  receipt: NonNullable<HookRule["lastDelivery"]>,
): Promise<void> {
  await serialized(async () => {
    const list = await hookRulesItem.get();
    const i = list.findIndex((r) => r.id === id);
    if (i < 0) return;
    await hookRulesItem.set(list.with(i, { ...list[i]!, lastDelivery: receipt }));
  });
}
