import { describe, it, expect } from "vitest";

/**
 * inspect.ts registers its CDP/tab listeners when the driver attaches, so the
 * chrome stub (which captures them) must be in place before startInspecting is
 * called — which is what stands in for the attach here.
 * Each test drives its own tab id — the rings are module-level and never reset.
 */
type DebuggerEvent = (source: { tabId?: number }, method: string, params?: unknown) => void;

let onDebuggerEvent!: DebuggerEvent;
let onTabRemoved!: (tabId: number) => void;

(globalThis as Record<string, unknown>).chrome = {
  debugger: {
    onEvent: {
      addListener: (fn: DebuggerEvent) => {
        onDebuggerEvent = fn;
      },
    },
    onDetach: { addListener: () => {} },
  },
  tabs: {
    onRemoved: {
      addListener: (fn: (tabId: number) => void) => {
        onTabRemoved = fn;
      },
    },
    onUpdated: { addListener: () => {} },
  },
};

const { listRequests, listConsoleMessages, startInspecting } = await import("../inspect");
startInspecting();

let nextTab = 1000;
/** A fresh tab id per test — module-level rings are never reset between tests. */
function tab(): number {
  return nextTab++;
}

function requestWillBeSent(tabId: number, requestId: string, url: string, method = "GET"): void {
  onDebuggerEvent({ tabId }, "Network.requestWillBeSent", {
    requestId,
    type: "XHR",
    request: { url, method },
  });
}

describe("inspect network ring", () => {
  it("joins the request with its response status", () => {
    const t = tab();
    requestWillBeSent(t, "r1", "https://a.example/api");
    onDebuggerEvent({ tabId: t }, "Network.responseReceived", {
      requestId: "r1",
      response: { status: 500 },
    });
    const { requests, total, note } = listRequests(t);
    expect(total).toBe(1);
    expect(note).toBeUndefined();
    expect(requests[0]).toMatchObject({ method: "GET", url: "https://a.example/api", status: 500 });
  });

  it("marks failures — canceled reads as canceled, and a finished request stays finished", () => {
    const t = tab();
    requestWillBeSent(t, "r1", "https://a.example/slow");
    onDebuggerEvent({ tabId: t }, "Network.loadingFailed", {
      requestId: "r1",
      errorText: "net::ERR_CONNECTION_RESET",
    });
    requestWillBeSent(t, "r2", "https://a.example/nav");
    onDebuggerEvent({ tabId: t }, "Network.loadingFailed", { requestId: "r2", canceled: true });
    requestWillBeSent(t, "r3", "https://a.example/raced");
    onDebuggerEvent({ tabId: t }, "Network.responseReceived", {
      requestId: "r3",
      response: { status: 200 },
    });
    onDebuggerEvent({ tabId: t }, "Network.loadingFailed", {
      requestId: "r3",
      errorText: "net::ERR_ABORTED",
    });
    const { requests } = listRequests(t);
    expect(requests[0]?.failed).toContain("ERR_CONNECTION_RESET");
    expect(requests[1]?.failed).toBe("canceled");
    expect(requests[2]).toMatchObject({ status: 200 });
    expect(requests[2]?.failed).toBeUndefined();
  });

  it("evicts the oldest request past 200 entries", () => {
    const t = tab();
    for (let i = 0; i < 205; i++) requestWillBeSent(t, `r${i}`, `https://a.example/${i}`);
    // Limit at the ring cap — the default 50 would window off the eviction edge.
    const { requests, total } = listRequests(t, undefined, 200);
    expect(total).toBe(200);
    expect(requests).toHaveLength(200);
    expect(requests[0]?.url).toBe("https://a.example/5");
    expect(requests.at(-1)?.url).toBe("https://a.example/204");
  });

  it("filters by url substring and clamps the limit to the most recent", () => {
    const t = tab();
    requestWillBeSent(t, "r1", "https://a.example/api/users");
    requestWillBeSent(t, "r2", "https://a.example/static/logo.png");
    requestWillBeSent(t, "r3", "https://a.example/api/orders");

    const filtered = listRequests(t, "api");
    expect(filtered.total).toBe(2);
    expect(filtered.requests.map((r) => r.url)).toEqual([
      "https://a.example/api/users",
      "https://a.example/api/orders",
    ]);
    // A filter that matches nothing is not "nothing captured" — no note, total 0.
    const dry = listRequests(t, "zzz");
    expect(dry.total).toBe(0);
    expect(dry.note).toBeUndefined();

    expect(listRequests(t, undefined, 2).requests.map((r) => r.url)).toEqual([
      "https://a.example/static/logo.png",
      "https://a.example/api/orders",
    ]);
    expect(listRequests(t, undefined, 999).requests).toHaveLength(3);
  });

  it("says why an empty ring is empty — capture starts at attach, not page load", () => {
    const { requests, total, note } = listRequests(tab());
    expect(requests).toEqual([]);
    expect(total).toBe(0);
    expect(note).toBeTruthy();
  });

  it("truncates long urls", () => {
    const t = tab();
    requestWillBeSent(t, "r1", `https://a.example/${"x".repeat(400)}`);
    expect(listRequests(t).requests[0]?.url.length).toBeLessThanOrEqual(301);
  });
});

describe("inspect console ring", () => {
  it("joins args, prefers descriptions for objects, and locates the calling frame", () => {
    const t = tab();
    onDebuggerEvent({ tabId: t }, "Runtime.consoleAPICalled", {
      type: "warn",
      args: [
        { type: "string", value: "save failed" },
        { type: "object", description: "Error: boom" },
      ],
      stackTrace: { callFrames: [{ url: "https://a.example/app.js", lineNumber: 41 }] },
    });
    const { messages } = listConsoleMessages(t);
    expect(messages[0]).toMatchObject({
      level: "warn",
      text: "save failed Error: boom",
      url: "https://a.example/app.js",
      line: 42, // CDP lines are 0-based
    });
  });

  it("records uncaught exceptions as errors, and onlyErrors filters to them", () => {
    const t = tab();
    onDebuggerEvent({ tabId: t }, "Runtime.consoleAPICalled", {
      type: "log",
      args: [{ type: "string", value: "hello" }],
    });
    onDebuggerEvent({ tabId: t }, "Runtime.exceptionThrown", {
      exceptionDetails: {
        text: "Uncaught",
        exception: { description: "TypeError: x is not a function" },
      },
    });
    expect(listConsoleMessages(t).total).toBe(2);
    const errors = listConsoleMessages(t, true);
    expect(errors.total).toBe(1);
    expect(errors.messages[0]).toMatchObject({
      level: "error",
      text: "TypeError: x is not a function",
    });
  });

  it("says why an empty console is empty", () => {
    expect(listConsoleMessages(tab()).note).toBeTruthy();
  });

  it("truncates long messages", () => {
    const t = tab();
    onDebuggerEvent({ tabId: t }, "Runtime.consoleAPICalled", {
      type: "log",
      args: [{ type: "string", value: "y".repeat(400) }],
    });
    expect(listConsoleMessages(t).messages[0]?.text.length).toBeLessThanOrEqual(301);
  });
});

describe("inspect tab cleanup", () => {
  it("a removed tab loses both rings", () => {
    const t = tab();
    requestWillBeSent(t, "r1", "https://a.example/api");
    onDebuggerEvent({ tabId: t }, "Runtime.consoleAPICalled", {
      type: "log",
      args: [{ type: "string", value: "hi" }],
    });
    onTabRemoved(t);
    expect(listRequests(t).note).toBeTruthy();
    expect(listConsoleMessages(t).note).toBeTruthy();
  });
});
