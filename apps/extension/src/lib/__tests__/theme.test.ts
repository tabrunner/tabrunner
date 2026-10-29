import { describe, it, expect } from "vitest";

// Storage stand-in comes from src/test-setup.ts (vitest setupFiles).

import { resolveDark } from "../theme";

describe("resolveDark", () => {
  it("explicit light/dark override the OS", () => {
    expect(resolveDark("light", true)).toBe(false);
    expect(resolveDark("dark", false)).toBe(true);
  });

  it("system follows the OS", () => {
    expect(resolveDark("system", true)).toBe(true);
    expect(resolveDark("system", false)).toBe(false);
  });
});
