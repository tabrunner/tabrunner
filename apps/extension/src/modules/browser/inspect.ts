import type { TabId } from "@/shared/types";
import { i18n } from "@/i18n";
import { truncate } from "@/lib/logger";

/**
 * The run's DevTools-style visibility into the driven tab: network requests and
 * console output, captured from the CDP domains cdp-driver enables at attach.
 * Read-only and deliberately shallow — requests carry no bodies (bodies are
 * where tokens and personal data live; evaluate can re-fetch a GET when a
 * payload really matters) and console text is truncated. The answer these give
 * the model is the debugging one: "the server 500'd" vs "the page never sent
 * it", and the JS error that names the broken piece.
 */

/** Ring size per tab — a busy page chatters; the recent tail is what diagnoses. */
const MAX_ENTRIES = 200;
/** Long URLs (data:, tracked links) are noise past this; errors past this repeat the stack. */
const MAX_TEXT = 300;

export interface RequestEntry {
  method: string;
  url: string;
  type?: string;
  status?: number;
  failed?: string;
}

export interface ConsoleEntry {
  level: string;
  text: string;
  url?: string;
  line?: number;
}

// Insertion-ordered by requestId, so the map itself is the ring: oldest key out first.
const requestsByTab = new Map<TabId, Map<string, RequestEntry>>();
const consoleByTab = new Map<TabId, ConsoleEntry[]>();

interface CdpRequestEvent {
  requestId: string;
  type?: string;
  request: { url: string; method: string };
}
interface CdpResponseEvent {
  requestId: string;
  response: { status: number };
}
interface CdpFailedEvent {
  requestId: string;
  errorText?: string;
  canceled?: boolean;
}
interface CdpConsoleEvent {
  type: string;
  args: { type: string; value?: unknown; description?: string }[];
  stackTrace?: { callFrames: { url: string; lineNumber: number }[] };
}
interface CdpExceptionEvent {
  exceptionDetails: {
    text: string;
    url?: string;
    lineNumber?: number;
    exception?: { description?: string };
  };
}

function requests(tabId: TabId): Map<string, RequestEntry> {
  let ring = requestsByTab.get(tabId);
  if (!ring) {
    ring = new Map();
    requestsByTab.set(tabId, ring);
  }
  return ring;
}

function pushConsole(tabId: TabId, entry: ConsoleEntry): void {
  let list = consoleByTab.get(tabId);
  if (!list) {
    list = [];
    consoleByTab.set(tabId, list);
  }
  list.push(entry);
  if (list.length > MAX_ENTRIES) list.shift();
}

let listening = false;

/**
 * Start capturing. Called by cdp-driver's first attach, never at module scope.
 *
 * Not a preference: WXT imports the background entrypoint at BUILD time to read
 * its options, under a fake browser whose `debugger.onEvent.addListener` throws
 * "not implemented" on sight. Whether this module is reached depends on how
 * that analysis bundle tree-shakes, so a module-scope listener is a build that
 * breaks on somebody else's unrelated import change — which is exactly how it
 * broke. Attach is the honest home anyway: the rings hold events for tabs this
 * session attached, and until one has, there is nothing to hear.
 */
export function startInspecting(): void {
  if (listening) return;
  listening = true;
  chrome.debugger.onEvent.addListener(onCdpEvent);
  chrome.tabs.onRemoved.addListener(forgetTab);
}

function onCdpEvent(source: chrome.debugger.Debuggee, method: string, params?: object): void {
  const tabId = source.tabId;
  if (tabId === undefined) return;

  if (method === "Network.requestWillBeSent") {
    const p = params as CdpRequestEvent;
    const ring = requests(tabId);
    ring.set(p.requestId, {
      method: p.request.method,
      url: truncate(p.request.url, MAX_TEXT),
      ...(p.type ? { type: p.type } : {}),
    });
    const oldest = ring.keys().next();
    if (ring.size > MAX_ENTRIES && !oldest.done) ring.delete(oldest.value);
    return;
  }
  if (method === "Network.responseReceived") {
    const p = params as CdpResponseEvent;
    const entry = requests(tabId).get(p.requestId);
    if (entry) entry.status = p.response.status;
    return;
  }
  if (method === "Network.loadingFailed") {
    const p = params as CdpFailedEvent;
    const entry = requests(tabId).get(p.requestId);
    if (entry && entry.status === undefined) {
      entry.failed = p.canceled ? "canceled" : truncate(p.errorText ?? "failed", 80);
    }
    return;
  }
  if (method === "Runtime.consoleAPICalled") {
    const p = params as CdpConsoleEvent;
    const frame = p.stackTrace?.callFrames[0];
    pushConsole(tabId, {
      level: p.type,
      text: truncate(
        p.args.map((a) => String(a.value ?? a.description ?? a.type)).join(" "),
        MAX_TEXT,
      ),
      ...(frame?.url ? { url: truncate(frame.url, 120), line: frame.lineNumber + 1 } : {}),
    });
    return;
  }
  if (method === "Runtime.exceptionThrown") {
    const p = params as CdpExceptionEvent;
    const d = p.exceptionDetails;
    pushConsole(tabId, {
      level: "error",
      text: truncate(d.exception?.description ?? d.text, MAX_TEXT),
      ...(d.url ? { url: truncate(d.url, 120), line: (d.lineNumber ?? -1) + 1 } : {}),
    });
  }
}

function forgetTab(tabId: TabId): void {
  requestsByTab.delete(tabId);
  consoleByTab.delete(tabId);
}

/** The model-facing limit: how far back the read reaches. */
const DEFAULT_LIMIT = 50;

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.min(Math.max(1, Math.trunc(limit)), MAX_ENTRIES);
}

/** Empty buffers need to say WHY — capture starts at attach, not at page load. */
function emptyNote(): string {
  return i18n.t("errors.captureEmpty");
}

export function listRequests(
  tabId: TabId,
  urlFilter?: string,
  limit?: number,
): { requests: RequestEntry[]; total: number; note?: string } {
  const all = [...(requestsByTab.get(tabId)?.values() ?? [])];
  const filtered = urlFilter ? all.filter((r) => r.url.includes(urlFilter)) : all;
  return {
    requests: filtered.slice(-clampLimit(limit)),
    total: filtered.length,
    ...(all.length === 0 ? { note: emptyNote() } : {}),
  };
}

export function listConsoleMessages(
  tabId: TabId,
  onlyErrors?: boolean,
  limit?: number,
): { messages: ConsoleEntry[]; total: number; note?: string } {
  const all = consoleByTab.get(tabId) ?? [];
  const filtered = onlyErrors ? all.filter((m) => m.level === "error") : all;
  return {
    messages: filtered.slice(-clampLimit(limit)),
    total: filtered.length,
    ...(all.length === 0 ? { note: emptyNote() } : {}),
  };
}
