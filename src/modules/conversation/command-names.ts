/**
 * The built-in slash-command names, as data. A leaf module on purpose: a skill
 * cannot claim one of these names, and skills/store.ts needs that rule without
 * importing from ui/ — this file stays React-free so the service worker can
 * load it. Kept in lockstep with COMMANDS by a parity test.
 */
export const SLASH_COMMAND_NAMES: readonly string[] = [
  "stop",
  "background",
  "effort",
  "model",
  "provider",
  "rename",
  "usage",
  "mcp",
  "document",
  "skill",
  "compact",
  "new",
  "skills",
  "help",
];
