/** "12s" / "3m 48s" — sub-second precision never matters on a run clock. */
/**
 * A duration in words, shortest unit first: 45s, 7m 58s, 2h 7m 58s, 3d 4h.
 * No "127m" — an hour-plus figure spelled in minutes is a number, not a read.
 * Days cap it: a run that crosses days is far past "how long did that take".
 */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m ${s % 60}s`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/** Host for tabs that never set a title — an empty stamp reads as a bug. */
export function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

export function formatTokens(n: number): string {
  // Three significant digits is all any of these earn — a run's total, a
  // compaction receipt, the gauge's reading and the window it divides into.
  // The decimal survives only where it says something: "24.3k" is a different
  // number from "24.9k", while "200.0k" (and "1000.0k") is noise around a
  // round ceiling nobody measured to a hundred tokens.
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 100_000) return `${Math.round(n / 1000)}k`;
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

/**
 * A dollar estimate, always led by "$" — these are list-price estimates in
 * USD regardless of locale, and a localized currency symbol would dress a
 * guess in real money's clothes. Two decimals where they say something; a
 * sub-cent run keeps the thousandth while there is one, and below a tenth of
 * a cent prints "$0.00" — including a gateway's literal zero (a plan-covered
 * run), which "<$0.001" dressed up as a tiny positive charge.
 */
export function formatMoney(usd: number): string {
  if (usd >= 0.01) return `$${usd.toFixed(2)}`;
  if (usd >= 0.001) return `$${usd.toFixed(3)}`;
  return "$0.00";
}

/** Cap the TOTAL length including the ellipsis — for UI strings that must fit a row. */
export function truncateTo(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * How to name the ⌥ modifier in a hint. macOS prints the glyph — every menu
 * there does, and spelling it "Alt" on a Mac keyboard sends people looking for
 * a key that isn't labelled. `userAgentData` where Chrome offers it, the
 * deprecated `platform` where it doesn't.
 */
export function altKeyLabel(): string {
  const platform =
    (navigator as { userAgentData?: { platform?: string } }).userAgentData?.platform ??
    navigator.platform;
  return /mac/i.test(platform) ? "⌥" : "Alt";
}
