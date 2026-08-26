import { describe, expect, it } from "vitest";
import { SLASH_COMMAND_NAMES } from "../command-names";
import { COMMANDS } from "../ui/slash-commands";

describe("SLASH_COMMAND_NAMES parity", () => {
  // The leaf list exists because skills/store.ts must reject these names
  // without importing from ui/ — if it drifts from the registry, either a
  // skill can claim a live command's name or a real name gets rejected.
  it("names exactly the built-in registry", () => {
    expect([...SLASH_COMMAND_NAMES].sort()).toEqual(COMMANDS.map((c) => c.name).sort());
  });
});
