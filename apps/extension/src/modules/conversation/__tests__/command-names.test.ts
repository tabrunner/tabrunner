import { describe, expect, it } from "vitest";
import {
  BUILTIN_COMMAND_ALIASES,
  RESERVED_SLASH_NAMES,
  SLASH_COMMAND_NAMES,
} from "../command-names";
import { COMMANDS } from "../ui/slash-commands";

describe("SLASH_COMMAND_NAMES parity", () => {
  // The leaf list exists because skills/store.ts must reject these names
  // without importing from ui/ — if it drifts from the registry, either a
  // skill can claim a live command's name or a real name gets rejected.
  it("reserves every executable token once and gives every command aliases", () => {
    expect(new Set(RESERVED_SLASH_NAMES).size).toBe(RESERVED_SLASH_NAMES.length);
    for (const [name, aliases] of Object.entries(BUILTIN_COMMAND_ALIASES)) {
      expect(aliases.length).toBeGreaterThan(0);
      expect(COMMANDS.find((command) => command.name === name)?.aliases).toEqual(aliases);
      expect(RESERVED_SLASH_NAMES).toContain(name);
      for (const alias of aliases) expect(RESERVED_SLASH_NAMES).toContain(alias);
    }
  });

  it("names exactly the built-in registry", () => {
    expect([...SLASH_COMMAND_NAMES].sort()).toEqual(COMMANDS.map((c) => c.name).sort());
  });
});
