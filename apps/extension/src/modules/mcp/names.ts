/**
 * Exposed tool names, pure. The exposed name is the ONLY thing the model sees
 * and the ONLY key it is called back with — so nothing ever parses an exposed
 * name apart; resolution goes through the map built alongside these names.
 */

import { MAX_MCP_NAME_CHARS } from "./types";

/** Reduce a name to a safe token: `[a-zA-Z0-9_-]`, collapsed, trailing/leading
 *  separators gone. Capping is the CALLER's concern — tool stems must survive
 *  uncapped so the truncation suffix below can still tell near-twins apart. */
export function sanitizeToken(raw: string, maxLen = Number.MAX_SAFE_INTEGER): string {
  return raw
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .replace(/_{2,}/g, "_")
    .replace(/^[-_]+|[-_]+$/g, "")
    .slice(0, maxLen);
}

/** Deterministic 4-char base36 FNV-1a — disambiguator for truncated names. */
export function hashToken(raw: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < raw.length; i++) {
    hash ^= raw.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36).padStart(4, "0").slice(-4);
}

/**
 * `mcp__<server>__<tool>` — the claude-code convention. Over-length names are
 * truncated and suffixed with `-` + a hash of the FULL unsanitized name, so
 * two long tools that truncate identically still get distinct exposed names.
 * A name that sanitizes to nothing keeps a stable hashed slot instead of
 * disappearing from the catalog.
 */
export function exposedToolName(serverName: string, toolName: string): string {
  const stem = sanitizeToken(toolName) || `t${hashToken(`${serverName}/${toolName}`)}`;
  const full = `${exposedPrefix(serverName)}${stem}`;
  if (full.length <= MAX_MCP_NAME_CHARS) return full;
  const suffix = `-${hashToken(`${serverName}/${toolName}`)}`;
  return full.slice(0, MAX_MCP_NAME_CHARS - suffix.length) + suffix;
}

/** The `mcp__<server>__` prefix one server's tools share — also its identity
 *  for duplicate detection (two servers sanitizing identically cannot both exist). */
export function exposedPrefix(serverName: string): string {
  return `mcp__${sanitizeToken(serverName, 32) || "server"}__`;
}
