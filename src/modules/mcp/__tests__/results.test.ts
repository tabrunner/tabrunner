import { describe, expect, it } from "vitest";
import { normalizeMcpResult } from "../results";
import { MAX_MCP_RESULT_CHARS } from "../types";

function result(content: Array<Record<string, unknown>>, overrides: Partial<Parameters<typeof normalizeMcpResult>[0]> = {}) {
  return normalizeMcpResult({ isError: false, content, ...overrides });
}

describe("normalizeMcpResult", () => {
  it("joins text blocks", () => {
    expect(result([{ type: "text", text: "line one" }, { type: "text", text: "line two" }])).toEqual({
      ok: true,
      data: "line one\n\nline two",
    });
  });

  it("maps image blocks to data URLs and keeps text alongside them", () => {
    const out = result([
      { type: "text", text: "here" },
      { type: "image", data: "QUJD", mimeType: "image/jpeg" },
    ]);
    expect(out.ok).toBe(true);
    expect(out.data).toBe("here");
    expect(out.images).toEqual(["data:image/jpeg;base64,QUJD"]);
  });

  it("falls back to structuredContent only when there is no content at all", () => {
    expect(result([], { structuredContent: { rows: 3 } }).data).toEqual({ rows: 3 });
    expect(result([{ type: "text", text: "x" }], { structuredContent: { rows: 3 } }).data).toBe("x");
  });

  it("degrades resources, links and audio to placeholder lines", () => {
    const out = result([
      { type: "resource", resource: { uri: "file:///x.pdf", blob: "AAA" } },
      { type: "resource", resource: { uri: "file:///n.txt", text: "plain" } },
      { type: "resource_link", uri: "https://x", name: "doc" },
      { type: "audio", data: "AA" },
    ]);
    expect(out.data).toBe(
      [
        "[resource file:///x.pdf — binary content withheld]",
        "plain",
        "doc: https://x",
        "[audio clip withheld]",
      ].join("\n\n"),
    );
  });

  it("marks unknown block types instead of dropping them silently", () => {
    expect(result([{ type: "holo" }]).data).toContain("[unsupported content type: holo]");
  });

  it("isError flips ok and carries the text as the error", () => {
    expect(
      normalizeMcpResult({ isError: true, content: [{ type: "text", text: "quota exceeded" }] }),
    ).toEqual({ ok: false, error: "quota exceeded" });
    expect(normalizeMcpResult({ isError: true, content: [] }).error).toMatch(/without detail/);
  });

  it("truncates oversized text with a notice", () => {
    const out = result([{ type: "text", text: "z".repeat(MAX_MCP_RESULT_CHARS + 10) }]);
    const data = out.data as string;
    expect(data.startsWith("z".repeat(20))).toBe(true);
    expect(data.length).toBeLessThan(MAX_MCP_RESULT_CHARS + 100);
    expect(data).toContain("[truncated");
  });
});
