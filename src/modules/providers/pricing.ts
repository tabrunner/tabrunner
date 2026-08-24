/**
 * List prices for the models the presets can reach, USD per million tokens —
 * the table cost is estimated from, because no first-party API returns a cost
 * (only token counts; OpenRouter-style gateways price the call themselves and
 * that figure rides through `UsageTick.cost` instead of through here).
 *
 * ponytail: hand-maintained and dated 2026-08 — prices drift and this table
 * will too. The failure mode is chosen, not accidental: a model that matches
 * nothing yields `undefined`, and the UI shows no money rather than a wrong
 * number. The upgrade path is a refresh of this one file.
 *
 * Cache rates are per model, spelled out rather than derived from multipliers —
 * Anthropic reads at 0.1× and writes at 1.25× input, while the OpenAI-shape
 * auto-cachers (and DeepSeek, GLM, Qwen, Kimi) bill a write at the input rate
 * with only the read discounted, and gpt-5-family reads at 0.1× where gpt-4o
 * reads at 0.5×. One explicit number per cell beats a rule per family.
 */

export interface ModelPrice {
  /** Fresh (uncached) input, USD per Mtok. */
  input: number;
  output: number;
  /** Input served from cache, USD per Mtok. */
  cacheRead: number;
  /** Input written to cache, USD per Mtok. */
  cacheWrite: number;
}

interface Entry {
  pattern: RegExp;
  price: ModelPrice;
}

/** A model id plus the one snapshot suffix vendors ship: a compact date
 *  (Anthropic, xAI) or an ISO one (OpenAI). Same model, pinned build. */
const snap = (prefix: string) =>
  new RegExp(`^${prefix}(-\\d{8}|-\\d{4}-\\d{2}-\\d{2})?$`);

/**
 * Most specific first. Each pattern prices exactly the versions its rates were
 * verified for — a sibling version (gpt-5.6-sol, grok-4.6, claude-opus-6) must
 * show NO money until someone adds its rates, never a near-name's price.
 */
const TABLE: Entry[] = [
  // Anthropic — cache write 1.25×, read 0.1× (platform.claude.com/docs/en/about-claude/pricing)
  {
    pattern: snap("claude-fable-5"),
    price: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
  },
  {
    pattern: snap("claude-opus-5"),
    price: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  },
  {
    pattern: snap("claude-sonnet-5"),
    price: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  },
  {
    pattern: snap("claude-haiku-4-5"),
    price: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  },

  // OpenAI — cached input per the model's own discount (developers.openai.com/api/docs/pricing)
  { pattern: snap("gpt-5\\.5"), price: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 5 } },
  {
    pattern: snap("gpt-5\\.4-mini"),
    price: { input: 0.75, output: 4.5, cacheRead: 0.075, cacheWrite: 0.75 },
  },
  { pattern: snap("gpt-5\\.4"), price: { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 2.5 } },
  {
    pattern: snap("gpt-5\\.3-codex"),
    price: { input: 1.75, output: 14, cacheRead: 0.175, cacheWrite: 1.75 },
  },
  {
    pattern: snap("gpt-5\\.1-codex-max"),
    price: { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 1.25 },
  },
  {
    pattern: snap("gpt-5-mini"),
    price: { input: 0.25, output: 2, cacheRead: 0.025, cacheWrite: 0.25 },
  },
  {
    // gpt-5 and its codex twin — the codex line has priced identically so far
    // (gpt-5.1-codex-max ships at these rates too, but keeps its own entry).
    pattern: snap("(gpt-5|gpt-5-codex)"),
    price: { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 1.25 },
  },
  {
    pattern: snap("gpt-4o-mini"),
    price: { input: 0.15, output: 0.6, cacheRead: 0.075, cacheWrite: 0.15 },
  },
  { pattern: snap("gpt-4o"), price: { input: 2.5, output: 10, cacheRead: 1.25, cacheWrite: 2.5 } },

  // xAI — grok-4 and grok-4-fast resolve to grok-4.3 on the current API, and
  // 4.0–4.3 price as one family; 4.5+ has its own (docs.x.ai/developers/pricing)
  {
    pattern: snap("(grok-4-fast|grok-4\\.[0-3]|grok-4)"),
    price: { input: 1.25, output: 2.5, cacheRead: 0.2, cacheWrite: 1.25 },
  },

  // Google — the ≤200k-prompt tier of gemini-2.5-pro; longer prompts bill more
  // and this table stays length-blind (agents spend most turns under it).
  {
    pattern: /^gemini-2\.5-pro([-.].*)?$/,
    price: { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 1.25 },
  },
  {
    pattern: /^gemini-2\.5-flash([-.].*)?$/,
    price: { input: 0.3, output: 2.5, cacheRead: 0.03, cacheWrite: 0.3 },
  },

  // DeepSeek — peak rates (off-peak is half); v4-flash is what the retired
  // deepseek-chat/reasoner aliases resolved to (api-docs.deepseek.com)
  {
    pattern: snap("deepseek-v4-flash"),
    price: { input: 0.44, output: 1.32, cacheRead: 0.014, cacheWrite: 0.44 },
  },
  {
    pattern: snap("deepseek-v4-pro"),
    price: { input: 1.32, output: 3.96, cacheRead: 0.044, cacheWrite: 1.32 },
  },

  // Z.ai, Moonshot, Qwen — cached input at their published read rates
  { pattern: snap("glm-5\\.2"), price: { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 1.4 } },
  { pattern: /^k3(-|$)/, price: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3 } },
  {
    pattern: snap("qwen3\\.8-max"),
    price: { input: 2, output: 6, cacheRead: 0.2, cacheWrite: 2 },
  },
];

/** The list price for a model id, or undefined when the table doesn't know it. */
export function priceOf(model: string): ModelPrice | undefined {
  return TABLE.find((e) => e.pattern.test(model))?.price;
}

/** The token counts a call spent — see UsageTick for why input is the full figure. */
export interface CostedUsage {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

/**
 * What a call cost at list price, USD; undefined when the model is unknown —
 * "no estimate" is the honest answer, never a guessed tier.
 *
 * The cache slices are clamped into the input (a gateway that reports more
 * cached than prompt tokens would otherwise bill negative fresh input).
 */
export function tokenCost(model: string, usage: CostedUsage): number | undefined {
  const price = priceOf(model);
  if (!price) return undefined;
  const read = Math.min(usage.cacheRead ?? 0, usage.input);
  const write = Math.min(usage.cacheWrite ?? 0, Math.max(0, usage.input - read));
  const fresh = Math.max(0, usage.input - read - write);
  return (
    (fresh * price.input +
      usage.output * price.output +
      read * price.cacheRead +
      write * price.cacheWrite) /
    1_000_000
  );
}
