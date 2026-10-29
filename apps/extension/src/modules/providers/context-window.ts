import { defineItem } from "@/lib/storage";
import type { ModelInfo, ProviderConfig } from "./types";
import { knownModels } from "./models";

/**
 * How big is the model's context window? Nobody can tell us reliably — the
 * extension is provider-agnostic, a custom `baseUrl` can serve any model under
 * any id, and a hardcoded table goes stale on every model launch. So we do not
 * guess from a table. We learn:
 *
 * 1. **A rejection teaches the ceiling.** When a turn is refused for length we
 *    know the window is smaller than the input we just sent — record that and
 *    the model has a real number from then on, for every later run.
 * 2. **Take it when the endpoint offers it.** OpenRouter, LM Studio and Ollama
 *    all report `context_length` in their model listing; Anthropic and OpenAI
 *    don't.
 * 3. **Otherwise assume 200k.** Not a wish — it's the floor of the current
 *    field (Claude, GPT-5, Gemini and Llama are all at or above it), and it is
 *    only ever used to decide when to compact early. Guessing high is the safe
 *    direction: the reactive path in (1) catches the models that are smaller
 *    and corrects this number for good.
 *
 * The learned map is the only persisted state, keyed by provider + model so two
 * endpoints serving the same model id never teach each other a wrong ceiling.
 */
export const DEFAULT_CONTEXT_WINDOW = 200_000;

/**
 * Room left for the answer, the tools, and one more page snapshot after the
 * check passes. Absolute rather than a percentage of the window, which is the
 * one thing a percentage gets wrong at both ends: 20% of 32k is too little to
 * finish a turn, and 20% of 1M is 200k tokens of headroom nobody needs. On the
 * 200k default this trips at ~84% used, which is the "around 80%" you'd expect.
 */
export const CONTEXT_RESERVE = 32_000;

/** Learned ceilings — `provider:model` → the largest input we know is too big. */
export const learnedContextLimits = defineItem<Record<string, number>>("contextLimits", {});

/** Which model a config actually runs, matching the picker's own "auto" resolution. */
export function resolvedModel(provider: ProviderConfig): string {
  return provider.model ?? knownModels(provider)[0]?.id ?? "auto";
}

function limitKey(provider: ProviderConfig): string {
  return `${provider.id}:${resolvedModel(provider)}`;
}

/** The listing's own number, when the endpoint ships one. */
function listedWindow(provider: ProviderConfig): number | undefined {
  const model = resolvedModel(provider);
  const listed: ModelInfo | undefined = knownModels(provider).find((m) => m.id === model);
  return listed?.contextLength;
}

/**
 * The window we actually KNOW, or undefined when the answer would be the
 * default guess. The difference matters to anything the user reads: planning
 * against 200k is a safe internal assumption, but *telling* someone their
 * conversation is "42% full" against a number nobody verified is a made-up
 * statistic. Callers that display something ask this one and stay quiet — or
 * show the raw count — when it answers undefined.
 */
export function knownContextWindow(
  provider: ProviderConfig,
  learned: Record<string, number>,
): number | undefined {
  // A learned ceiling outranks everything: it is the only number that came from
  // this endpoint actually refusing this model's input.
  const observed = learned[limitKey(provider)];
  if (observed !== undefined && observed > 0) return observed;
  return listedWindow(provider);
}

/**
 * The window to plan against, best guess. Synchronous on purpose — the run loop
 * checks it every turn and the panel's gauge reads it during render, so the
 * learned map is handed in rather than awaited (see `readLearnedLimits`).
 */
export function contextWindowFor(
  provider: ProviderConfig,
  learned: Record<string, number>,
): number {
  return knownContextWindow(provider, learned) ?? DEFAULT_CONTEXT_WINDOW;
}

/** The learned map, for callers that can await (the run loop reads it once per run). */
export function readLearnedLimits(): Promise<Record<string, number>> {
  return learnedContextLimits.get();
}

/**
 * A turn was refused for length at `observedInput` tokens — so the real window
 * is below it. Records the SMALLEST such observation: a later refusal at a
 * higher count says nothing new, and taking the max would keep raising a
 * ceiling we already proved is too high.
 *
 * When the provider refused without telling us the size (no usage on a failed
 * request), the caller passes its own estimate — a low guess only makes us
 * compact earlier than strictly needed, never later.
 */
export async function learnContextLimit(
  provider: ProviderConfig,
  observedInput: number,
): Promise<void> {
  if (!Number.isFinite(observedInput) || observedInput <= 0) return;
  const map = await learnedContextLimits.get();
  const key = limitKey(provider);
  const previous = map[key];
  if (previous !== undefined && previous <= observedInput) return;
  await learnedContextLimits.set({ ...map, [key]: observedInput });
}

/** Is this turn close enough to the ceiling that the next one may not fit? */
export function needsCompaction(inputTokens: number, window: number): boolean {
  return inputTokens > 0 && inputTokens >= window - CONTEXT_RESERVE;
}
