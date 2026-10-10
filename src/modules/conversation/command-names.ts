/** Command tokens stay React-free: skill validation and the panel share one namespace. */
export const BUILTIN_COMMAND_ALIASES = {
  stop: ["cancel", "halt"],
  background: ["bg"],
  effort: ["reasoning", "think"],
  model: ["models", "llm"],
  provider: ["providers", "vendor"],
  rename: ["title"],
  usage: ["quota", "limits"],
  mcp: ["servers"],
  document: ["doc", "walkthrough"],
  skill: ["recipe"],
  compact: ["summarize", "summarise"],
  new: ["new-chat"],
  skills: ["recipes", "library"],
  help: ["commands", "shortcuts"],
  loop: ["repeat", "schedule"],
} satisfies Record<string, readonly string[]>;

export type BuiltinCommandName = keyof typeof BUILTIN_COMMAND_ALIASES;

export const SLASH_COMMAND_NAMES: readonly string[] = Object.keys(BUILTIN_COMMAND_ALIASES);

export const RESERVED_SLASH_NAMES: readonly string[] = Object.entries(
  BUILTIN_COMMAND_ALIASES,
).flatMap(([name, aliases]) => [name, ...aliases]);
