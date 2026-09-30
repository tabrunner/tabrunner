/** Cross-module shared types, and the guard that reads untyped JSON into one,
 *  that don't belong to any single domain. */

export type TabId = number;

/**
 * An untyped wire value narrowed to an object whose fields can be read. An
 * array is not one: every caller expects an object there, and a list in its
 * place is malformed.
 */
export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
