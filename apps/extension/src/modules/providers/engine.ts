import type { ConversationEngine, ProviderConfig } from "./types";

/**
 * Which provider a conversation runs on, and with what.
 *
 * One rule, four words: **pin, else the stored pick, else the first configured.**
 * Everything that answers "what will this run on" goes through here — the
 * composer chip, the slash pickers, the context gauge's denominator, the error
 * bubble's key dialog, and the run itself. They must agree, and a surface that
 * resolved it its own way would name an engine the run never used.
 *
 * The pin is a snapshot of the picker's choices, not of the resolution, so
 * `model`/`reasoningEffort` are REPLACED rather than merged — an absent one
 * means auto/default exactly as it does on a stored provider, and inheriting
 * the provider's own value there would make "auto" unpinnable.
 *
 * A pin whose provider is gone is not a pin: it degrades to the stored pick
 * rather than failing, the same way `removeProvider` refuses to leave the
 * active id dangling. The run then re-pins to what actually answered.
 */
export function engineProvider(
  providers: ProviderConfig[],
  activeId: string | null,
  pin?: ConversationEngine,
): ProviderConfig | undefined {
  const pinned = pin ? providers.find((p) => p.id === pin.providerId) : undefined;
  if (!pinned || !pin) return providers.find((p) => p.id === activeId) ?? providers[0];

  const next = { ...pinned };
  if (pin.model) next.model = pin.model;
  else delete next.model;
  if (pin.effort) next.reasoningEffort = pin.effort;
  else delete next.reasoningEffort;
  return next;
}

/** The pick a provider currently stands for — what a conversation pins. */
export function engineOf(provider: ProviderConfig): ConversationEngine {
  return {
    providerId: provider.id,
    ...(provider.model ? { model: provider.model } : {}),
    ...(provider.reasoningEffort ? { effort: provider.reasoningEffort } : {}),
  };
}

/** Guards the pin write — a run that changed nothing must not touch storage. */
export function sameEngine(a: ConversationEngine | undefined, b: ConversationEngine): boolean {
  return a?.providerId === b.providerId && a?.model === b.model && a?.effort === b.effort;
}
