import { str, isRecord } from "./jsonrpc";
import { MAX_MCP_RESULT_CHARS, MAX_MCP_RESULT_IMAGES, type McpCallResult } from "./types";

/**
 * callTool result → the shape the agent loop feeds back as one tool_result.
 * Kept structurally identical to `ToolResult` (agent/tools) without importing
 * it — mcp must stay importable from anywhere agent imports IT, and the loop
 * already JSON-serializes whatever lands in `data`.
 *
 * Every path through here is budgeted — text and structured data by character
 * cap, images by count — because a result rides every remaining turn of the
 * run. A server returning megabytes gets a truncated result, not a bill.
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
  let images: string[] = [];

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
  if (images.length > MAX_MCP_RESULT_IMAGES) {
    const withheld = images.length - MAX_MCP_RESULT_IMAGES;
    images = images.slice(0, MAX_MCP_RESULT_IMAGES);
    texts.push(`[${withheld} more image${withheld === 1 ? "" : "s"} withheld]`);
  }

  // One join, branched twice: error results carry the same text as their
  // message rather than computing it again.
  const joined = texts.length > 0 ? cap(texts.join("\n\n")) : undefined;

  if (result.isError) {
    return { ok: false, error: joined ?? "The tool reported an error without detail." };
  }

  // Structured-only results go out as the (capped) string the loop would
  // serialize them into anyway — bounded at this one site instead of riding
  // the wire unbounded every turn.
  const data =
    joined ??
    (images.length === 0 && result.structuredContent !== undefined
      ? cap(JSON.stringify(result.structuredContent))
      : undefined);

  return {
    ok: true,
    ...(data !== undefined ? { data } : {}),
    ...(images.length ? { images } : {}),
  };
}

function cap(text: string): string {
  if (text.length <= MAX_MCP_RESULT_CHARS) return text;
  return `${text.slice(0, MAX_MCP_RESULT_CHARS)}\n\n[truncated at ${MAX_MCP_RESULT_CHARS} of ${text.length} characters]`;
}
