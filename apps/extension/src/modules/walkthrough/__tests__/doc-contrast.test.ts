import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AA, contrast } from "@/lib/__tests__/contrast-math";

/**
 * The exported document is read on a screen in either theme and printed onto
 * paper, so its two colored marks have to clear AA in all three. Both failed:
 * the step badge ran white on emerald (3.8:1 light, 1.9:1 dark — the numerals
 * were effectively invisible on a dark screen), and the footer link used the
 * same mid-emerald as ink on white (3.8:1). This is the artifact strangers see,
 * which is exactly why nobody on the team noticed.
 *
 * Sibling of src/lib/__tests__/contrast.test.ts, which guards the same rule
 * across the panel's own components.
 */

// Vitest runs from the project root, so source paths are cwd-relative.
const DOC_HTML = readFileSync("src/modules/walkthrough/doc-html.ts", "utf8");

describe("the exported walkthrough reads on screen and on paper", () => {
  // One mode-invariant pair, so it holds in light, dark and print alike.
  const badge = DOC_HTML.match(
    /\.num\s*\{[\s\S]*?background:\s*(#[0-9a-fA-F]{3,6});\s*color:\s*(#[0-9a-fA-F]{3,6});/,
  );

  it("the step badge pairs a saturated fill with dark ink", () => {
    expect(badge).not.toBeNull();
    expect(contrast(badge![1]!, badge![2]!)).toBeGreaterThanOrEqual(AA);
  });

  // Light, dark and print each redeclare the palette; --brand is link ink.
  const palettes = DOC_HTML.split(":root {")
    .slice(1)
    .map((chunk) => ({
      bg: chunk.match(/--bg:\s*(#[0-9a-fA-F]{3,6});/)?.[1],
      brand: chunk.match(/--brand:\s*(#[0-9a-fA-F]{3,6});/)?.[1],
    }))
    .filter((p): p is { bg: string; brand: string } => Boolean(p.bg && p.brand));

  it("declares a palette per mode", () => expect(palettes).toHaveLength(3));

  for (const [i, { bg, brand }] of palettes.entries()) {
    it(`footer link reads on palette ${i + 1} — ${brand} on ${bg}`, () => {
      expect(contrast(bg, brand)).toBeGreaterThanOrEqual(AA);
    });
  }
});
