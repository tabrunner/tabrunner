import { i18n, DEFAULT_LOCALE, SUPPORTED_LOCALES } from "@/i18n";

/**
 * Saying WHEN a rate limit lifts, in the reader's language.
 *
 * The parsing that works out *which* window bound and when it resets moved to
 * @providerkit/core — it is vendor knowledge (Anthropic's unified 5h/7d header
 * pair, ChatGPT's body-carried `resets_at`) that four other codebases needed
 * too. What stays here is the half that cannot be shared: turning that instant
 * into a phrase, which needs the extension's own locale and i18n instance.
 */

/**
 * "in 4 hours (6:47 PM)" / "em 3 dias (12 de ago., 14:30)" — relative time in
 * the UI locale, with the absolute time appended once the wait is long enough
 * that "when exactly" matters. Relative leads because locale-correct at/on/às
 * glue is a translation trap; the parenthesized absolute needs no glue.
 */
export function formatResetRelative(resetAtMs: number, now: number): string {
  const relative = formatRelative(Math.max(0, resetAtMs - now));
  if (resetAtMs - now < 90 * 60_000) return relative;
  return `${relative} (${formatAbsolute(resetAtMs, now)})`;
}

function formatAbsolute(resetAtMs: number, now: number): string {
  const locale = SUPPORTED_LOCALES.find((l) => l === i18n.language) ?? DEFAULT_LOCALE;
  const sameDay = new Date(resetAtMs).toDateString() === new Date(now).toDateString();
  const options: Intl.DateTimeFormatOptions = sameDay
    ? { hour: "numeric", minute: "2-digit" }
    : { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" };
  return new Intl.DateTimeFormat(locale, options).format(resetAtMs);
}

/** "2 minutes ago" / "há 2 minutos" — the past counterpart of formatResetRelative. */
export function formatAgo(atMs: number, now: number): string {
  return formatRelative(-Math.max(0, now - atMs));
}

function formatRelative(diffMs: number): string {
  const minutes = Math.abs(diffMs) / 60_000;
  const sign = Math.sign(diffMs) || 1;
  const [value, unit]: [number, Intl.RelativeTimeFormatUnit] =
    minutes < 90
      ? [Math.max(1, Math.round(minutes)), "minute"]
      : minutes < 36 * 60
        ? [Math.round(minutes / 60), "hour"]
        : [Math.round(minutes / (60 * 24)), "day"];
  const locale = SUPPORTED_LOCALES.find((l) => l === i18n.language) ?? DEFAULT_LOCALE;
  return new Intl.RelativeTimeFormat(locale, { numeric: "always" }).format(sign * value, unit);
}
