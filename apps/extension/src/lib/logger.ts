/**
 * Scoped console loggers — plain `console.*` under the hood, so output lands in the
 * service-worker console (chrome://extensions → Inspect views) and the panel devtools,
 * and ports to any browser unchanged.
 *
 * Rules: lifecycle events at `info` (Chrome hides `debug` unless Verbose is on),
 * stream chatter at `debug`. Never log API keys or page content.
 */
export interface Logger {
  debug: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

/** Create a logger whose lines are prefixed `[tabrunner:<scope>]`. */
export function createLogger(scope: string): Logger {
  const prefix = `[tabrunner:${scope}]`;
  return {
    debug: (...args) => console.debug(prefix, ...args),
    info: (...args) => console.info(prefix, ...args),
    warn: (...args) => console.warn(prefix, ...args),
    error: (...args) => console.error(prefix, ...args),
  };
}

/** Bound a string for log lines — provider error bodies can be huge. */
export function truncate(text: string, max = 500): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
