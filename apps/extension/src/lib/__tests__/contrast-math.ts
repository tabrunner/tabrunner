/**
 * WCAG relative luminance and contrast, for the checks that assert a color
 * pairing rather than a behavior. Not a `.test.ts`, so vitest collects it as a
 * helper instead of a suite.
 */

/** WCAG AA for body text. Every pairing checked against this is prose or a
 *  short label at ≤14px, so none qualify for the 3:1 large-text allowance. */
export const AA = 4.5;

export function luminance(hex: string): number {
  const h = hex.slice(1);
  const full = h.length === 3 ? [...h].map((c) => c + c).join("") : h;
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = parseInt(full.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}
