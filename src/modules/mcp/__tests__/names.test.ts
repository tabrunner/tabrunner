import { describe, expect, it } from "vitest";
import { exposedPrefix, exposedToolName, hashToken, sanitizeToken } from "../names";
import { MAX_MCP_NAME_CHARS } from "../types";

describe("sanitizeToken", () => {
  it("keeps name characters and collapses the rest", () => {
    expect(sanitizeToken("Aboard Tools! v2")).toBe("Aboard_Tools_v2");
  });

  it("trims edge separators and collapses runs (forged `__` must not fake structure)", () => {
    expect(sanitizeToken("--weird__name--")).toBe("weird_name");
  });

  it("caps only when the caller says so (server tokens cap; tool stems must not)", () => {
    expect(sanitizeToken("x".repeat(50), 32).length).toBe(32);
    expect(sanitizeToken("x".repeat(50)).length).toBe(50);
  });
});

describe("exposedToolName", () => {
  it("follows the mcp__server__tool convention", () => {
    expect(exposedToolName("aboard", "search_mail")).toBe("mcp__aboard__search_mail");
  });

  it("stays under the wire budget even with Anthropic's OAuth prefix in mind", () => {
    const long = exposedToolName(
      "a-very-long-server-name-indeed",
      "and-an-extremely-long-tool-name-here",
    );
    expect(long.length).toBeLessThanOrEqual(MAX_MCP_NAME_CHARS);
  });

  it("gives over-length names a deterministic hashed suffix", () => {
    const a = exposedToolName("s", "x".repeat(80));
    const b = exposedToolName("s", "x".repeat(80));
    expect(a).toBe(b);
    expect(a.endsWith(`-${hashToken("s/" + "x".repeat(80))}`)).toBe(true);
  });

  it("distinguishes two long tools that truncate identically", () => {
    const a = exposedToolName("s", `${"x".repeat(70)}a`);
    const b = exposedToolName("s", `${"x".repeat(70)}b`);
    expect(a).not.toBe(b);
  });
});

describe("exposedPrefix", () => {
  it("is the shared namespace used for duplicate-server detection", () => {
    expect(exposedPrefix("GitHub")).toBe("mcp__GitHub__");
    expect(exposedPrefix("!!")).toBe("mcp__server__");
  });
});
