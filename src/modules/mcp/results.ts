import { MAX_MCP_RESULT_CHARS, type McpCallResult } from "./types";

/**
 * callTool result → the shape the agent loop feeds back as one tool_result.
 * Kept structurally identical to `ToolResult` (agent/tools) without importing
 * it — mcp must stay importable from anywhere agent imports IT, and the loop
 * already JSON-serializes whatever lands in `data`.
 *
 * ponytail: content blocks beyond text/image/resource degrade to placeholder
 * lines rather than a second representation. Upgrade path: map new block
 * types here as real consumers appear.
 */

export interface NormalizedMcpResult {
  ok: boolean;
  data?: unknown;
  error?: string;
  images?: string[];
}

export function normalizeMcpResult(result: McpCallResult): NormalizedMcpResult {
  const texts: string[] = [];
  const images: string[] = [];

  for (const block of result.content ?? []) {
    const type = str(block.type);
    if (type === "text") {
      const text = str(block.text);
      if (text) texts.push(text);
    } else if (type === "image" && typeof block.data === "string") {
      images.push(`data:${str(block.mimeType) || "image/png"};base64,${block.data}`);
    } else if (type === "resource") {
      const r = isRecord(block.resource) ? block.resource : {};
      if (typeof r.text === "string" && r.text) {
        texts.push(r.text);
      } else {
        texts.push(`[resource ${str(r.uri) || "unknown"} — binary content withheld]`);
      }
    } else if (type === "resource_link") {
      texts.push(`${str(block.name) || "resource"}: ${str(block.uri) || "(no uri)"}`);
    } else if (type === "audio") {
      texts.push("[audio clip withheld]");
    } else if (type) {
      texts.push(`[unsupported content type: ${type}]`);
    }
  }

  let data: unknown;
  if (texts.length > 0) data = cap(texts.join("\n\n"));
  else if (images.length === 0 && result.structuredContent !== undefined)
    data = result.structuredContent;

  if (result.isError) {
    return { ok: false, error: cap(texts.join("\n\n")) || "The tool reported an error without detail." };
  }
  return { ok: true, ...(data !== undefined ? { data } : {}), ...(images.length ? { images } : {}) };
}

function cap(text: string): string {
  if (text.length <= MAX_MCP_RESULT_CHARS) return text;
  return `${text.slice(0, MAX_MCP_RESULT_CHARS)}\n\n[truncated at ${MAX_MCP_RESULT_CHARS} of ${text.length} characters]`;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}
