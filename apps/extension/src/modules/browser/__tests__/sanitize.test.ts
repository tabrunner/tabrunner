import { describe, it, expect } from "vitest";
import { sanitizeForModel } from "../sanitize";

describe("sanitizeForModel", () => {
  it("passes plain JSON-shaped values through untouched", () => {
    const value = { name: "Fluke", count: 3, ok: true, items: [1, "two", null], nested: { a: 1 } };
    expect(sanitizeForModel(value)).toEqual(value);
  });

  it("maps null and undefined to null", () => {
    expect(sanitizeForModel(undefined)).toBeNull();
    expect(sanitizeForModel(null)).toBeNull();
  });

  it("blocks credential-looking object keys at any depth", () => {
    const result = sanitizeForModel({
      user: "gus",
      accessToken: "abc123",
      nested: { password: "hunter2", session_id: "xyz", note: "keep me" },
    }) as Record<string, unknown>;
    expect(result.user).toBe("gus");
    expect(result.accessToken).toBe("[blocked]");
    const nested = result.nested as Record<string, unknown>;
    expect(nested.password).toBe("[blocked]");
    expect(nested.session_id).toBe("[blocked]");
    expect(nested.note).toBe("keep me");
  });

  it("blocks credential-shaped strings and keeps ordinary prose", () => {
    expect(
      sanitizeForModel(
        "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
      ),
    ).toBe("[blocked]");
    expect(sanitizeForModel("Authorization: Bearer abcdef123456")).toBe("[blocked]");
    expect(sanitizeForModel("sessionid=abc123xyz; csrftoken=def456uvw")).toBe("[blocked]");
    expect(sanitizeForModel("a".repeat(64))).toBe("[blocked]"); // hex credential
    expect(sanitizeForModel("Search results for x = 1; y = 2 — nothing found")).toContain(
      "nothing found",
    );
  });

  it("truncates long strings", () => {
    const result = sanitizeForModel("lorem ipsum ".repeat(120)) as string;
    expect(result).toHaveLength(1000 + "…[truncated]".length);
    expect(result.endsWith("…[truncated]")).toBe(true);
  });

  it("caps arrays and says how much was dropped", () => {
    const result = sanitizeForModel(Array.from({ length: 150 }, (_, i) => i)) as unknown[];
    expect(result).toHaveLength(101);
    expect(result[100]).toBe("[truncated: 50 more items]");
  });

  it("stops at the depth cap", () => {
    const deep = { a: { b: { c: { d: { e: { f: "too deep" } } } } } };
    const result = JSON.stringify(sanitizeForModel(deep));
    expect(result).toContain("[truncated: max depth]");
    expect(result).not.toContain("too deep");
  });

  it("marks circular references instead of recursing forever", () => {
    const obj: Record<string, unknown> = { name: "loop" };
    obj.self = obj;
    const result = sanitizeForModel(obj) as Record<string, unknown>;
    expect(result.name).toBe("loop");
    expect(result.self).toBe("[circular]");
  });

  it("replaces functions and turns bigints into strings", () => {
    const result = sanitizeForModel({ fn: () => 1, big: BigInt(42) }) as Record<string, unknown>;
    expect(result.fn).toBe("[function]");
    expect(result.big).toBe("42");
  });

  it("hands back a truncated JSON string when the whole result is past the cap", () => {
    // Breadth, not one long string — the per-string cap would fire first.
    const wide = Array.from({ length: 100 }, (_, i) => ({ [`field ${i}`]: "value ".repeat(80) }));
    const result = sanitizeForModel(wide);
    expect(typeof result).toBe("string");
    expect((result as string).endsWith("chars. Return a smaller piece]")).toBe(true);
    expect((result as string).length).toBeLessThan(21_000);
  });
});
