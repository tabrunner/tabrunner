import { describe, expect, it } from "vitest";
import {
  SseFrameReader,
  classifyMessage,
  declineResponse,
  methodNotFoundResponse,
  notification,
  request,
} from "../jsonrpc";

describe("builders", () => {
  it("frames requests, notifications and declines as JSON strings", () => {
    expect(JSON.parse(request("tools/call", { name: "t" }, 7))).toEqual({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "t" },
    });
    expect(JSON.parse(request("ping", undefined, 8)).params).toBeUndefined();
    expect(JSON.parse(notification("notifications/initialized"))).toEqual({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });
    expect(JSON.parse(methodNotFoundResponse(3, "roots/list"))).toMatchObject({
      id: 3,
      error: { code: -32601 },
    });
    // The MCP elicitation decline is a RESULT, not an error — the server asked
    // a question and the honest answer is "no one is here".
    expect(JSON.parse(declineResponse(9))).toEqual({
      jsonrpc: "2.0",
      id: 9,
      result: { action: "decline" },
    });
  });
});

describe("classifyMessage", () => {
  it("sorts the four shapes apart", () => {
    expect(classifyMessage({ jsonrpc: "2.0", id: 1, result: {} })).toBe("response");
    expect(classifyMessage({ jsonrpc: "2.0", method: "x" })).toBe("notification");
    expect(classifyMessage({ jsonrpc: "2.0", id: 2, method: "elicitation/create" })).toBe(
      "request",
    );
    expect(classifyMessage({ hello: true })).toBe("invalid");
  });
});

describe("SseFrameReader", () => {
  it("parses complete frames and skips comments/event lines", () => {
    const reader = new SseFrameReader();
    const frames = reader.push('event: message\ndata: {"a":1}\n\n: keepalive\n\ndata: {"b":2}\n\n');
    expect(frames).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it("reassembles payloads split across chunks", () => {
    const reader = new SseFrameReader();
    expect(reader.push('data: {"json')).toEqual([]);
    expect(reader.push('rpc":"2.0","id":1,"resu')).toEqual([]);
    expect(reader.push('lt":5}\n\n')).toEqual([{ jsonrpc: "2.0", id: 1, result: 5 }]);
  });

  it("joins multi-line data fields before parsing (a pretty-printed payload)", () => {
    const reader = new SseFrameReader();
    expect(reader.push("data: {\n")).toEqual([]);
    expect(reader.push('data:   "id": 1,\n')).toEqual([]);
    expect(reader.push('data:   "result": true\n')).toEqual([]);
    expect(reader.push("data: }\n\n")).toEqual([{ id: 1, result: true }]);
  });

  it("drops unparseable frames instead of throwing", () => {
    const reader = new SseFrameReader();
    expect(reader.push('data: not-json\n\ndata: {"ok":true}\n\n')).toEqual([{ ok: true }]);
  });

  it("end() flushes a final unterminated frame", () => {
    const reader = new SseFrameReader();
    expect(reader.push('data: {"last":true}')).toEqual([]);
    expect(reader.end()).toEqual([{ last: true }]);
  });
});
