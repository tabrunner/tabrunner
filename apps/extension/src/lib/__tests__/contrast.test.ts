import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AA, contrast } from "./contrast-math";

/**
 * The brand ramp's contrast invariant, guarding a mistake that shipped once and
 * was one edit from shipping again: a brand fill paired with ink that was never
 * re-decided for the mode. The chat's user bubble carried its light-mode ink
 * straight into dark — a highlighter slab reading at 6:1 with every neighbour
 * at 14:1. Not catchable by eye in a diff, and not a logic bug any other test
 * would trip over.
 *
 * The ramp is read out of theme.css and the pairings out of the components
 * themselves, so a retint fails this as loudly as a reclass. The rule it
 * encodes: emerald bright enough to read as the brand cannot carry white ink,
 * so a fill states its ink per mode or inherits the body's.
 */

// Vitest runs from the project root, so source paths are cwd-relative.
const read = (path: string) => readFileSync(`src/${path}`, "utf8");

/** `--color-brand-500: #10b981;` → ramp.brand[500]. */
const ramp: Record<string, Record<string, string>> = {};
for (const [, family, step, value] of read("lib/theme.css").matchAll(
  /--color-(brand|neutral)-(\d+):\s*(#[0-9a-fA-F]{3,6});/g,
)) {
  if (family && step && value) (ramp[family] ??= {})[step] = value;
}

/** Body's own pairing (src/lib/theme.css) — what a fill inherits when it
 *  declares no ink of its own for that mode. */
const INHERITED_INK = { light: "neutral-900", dark: "neutral-100" };

/**
 * ponytail: declared, but not a ramp step — an alpha fill, a red. Skipped
 * rather than guessed at, since resolving `bg-brand-950/60` needs the ground
 * beneath it. Every translucent fill in the codebase today darkens an already
 * dark ground, which only widens the ratio; if one ever lands on a LIGHT
 * ground, composite it against that ground here instead of skipping.
 */
const OUTSIDE_RAMP = "outside-ramp";

/**
 * One utility's value for a mode. The leading `(?:^|\s)` is what separates the
 * prefixes: `dark:bg-x` and `hover:bg-x` are both preceded by `:`, so a bare
 * match can't pick up a state variant.
 */
function utility(classes: string, kind: "bg" | "text", mode: "light" | "dark") {
  const declared = (prefix: string) => new RegExp(`(?:^|\\s)${prefix}${kind}-`).test(classes);
  const value = (prefix: string) => {
    const m = classes.match(
      new RegExp(`(?:^|\\s)${prefix}${kind}-(brand|neutral)-(\\d+)(?![/\\w])`),
    );
    return m ? `${m[1]}-${m[2]}` : OUTSIDE_RAMP;
  };
  // A `dark:` utility wins in dark; the bare one paints in BOTH modes, so an
  // undeclared dark fill is inherited, never absent. Resolving that inheritance
  // is what keeps a variant that skipped its dark pass in the run instead of
  // quietly dropping out of it — which is how the bubble shipped unnoticed.
  if (mode === "dark" && declared("dark:")) return value("dark:");
  return declared("") ? value("") : null;
}

function pairFor(classes: string, mode: "light" | "dark") {
  const fill = utility(classes, "bg", mode);
  const ink = utility(classes, "text", mode);
  if (fill === null || fill === OUTSIDE_RAMP || ink === OUTSIDE_RAMP) return null;
  return { fill, ink: ink ?? INHERITED_INK[mode] };
}

const hex = (token: string) => {
  const [family, step] = token.split("-") as [string, string];
  const value = ramp[family]?.[step];
  if (!value) throw new Error(`theme.css defines no ${token}`);
  return value;
};

/** Every `name: "…classes…"` entry of a component's VARIANTS map. */
function variants(rel: string): [string, string][] {
  const block = read(rel).match(/const VARIANTS[^{]*\{([\s\S]*?)\n\};/)?.[1];
  if (!block) throw new Error(`no VARIANTS map in ${rel}`);
  return [...block.matchAll(/(?:"([\w-]+)"|([\w-]+))\s*:\s*"((?:[^"\\]|\\.)*)"/g)].map((m) => [
    m[1] ?? m[2] ?? "",
    m[3] ?? "",
  ]);
}

describe("brand fills carry legible ink in both modes", () => {
  it("the ramp parsed", () => {
    expect(Object.keys(ramp.brand ?? {})).toHaveLength(11);
    expect(ramp.brand?.["500"]).toBe("#10b981");
  });

  for (const component of ["components/Bubble.tsx", "components/Button.tsx"]) {
    for (const [name, classes] of variants(component)) {
      for (const mode of ["light", "dark"] as const) {
        const pair = pairFor(classes, mode);
        if (!pair) continue;
        it(`${component.split("/").pop()} ${name} · ${mode} — ${pair.ink} on ${pair.fill}`, () => {
          expect(contrast(hex(pair.fill), hex(pair.ink))).toBeGreaterThanOrEqual(AA);
        });
      }
    }
  }
});

/**
 * Contrast alone would have passed the bubble that started this: brand-500 with
 * brand-950 ink clears AA in either mode. What it failed was hierarchy — on the
 * dark ground it was the brightest object in the panel, louder than the answer
 * it sat above. That is checkable without inventing a threshold: a surface
 * belonging to a dark room is nearer its ground than the light extreme.
 *
 * Bubbles only. A primary button is the action, so being the brightest thing on
 * screen is precisely its job, and it keeps one saturated fill in both modes.
 */
describe("dark-mode message surfaces belong to the dark end of the range", () => {
  const ground = hex("neutral-950");
  for (const [name, classes] of variants("components/Bubble.tsx")) {
    const pair = pairFor(classes, "dark");
    if (!pair) continue;
    it(`${name} — ${pair.fill} sits with the ground, not against it`, () => {
      const fill = hex(pair.fill);
      expect(contrast(fill, ground)).toBeLessThan(contrast(fill, "#ffffff"));
    });
  }
});
