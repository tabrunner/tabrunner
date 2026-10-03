#!/usr/bin/env bun
/**
 * TabRunner MCP bridge.
 *
 * Speaks MCP over stdio to one AI client, and WebSocket to the TabRunner
 * extension, which is always the dialling side — an MV3 service worker cannot
 * listen on a socket, so the extension can never be an MCP server itself.
 *
 * The daemon is a pipe with a memory: it holds the run status so `get_status`
 * can long-poll (a browser task runs for minutes, and burning a model turn per
 * poll is the whole cost of getting this wrong) and so a dropped link never
 * loses a finished run's answer.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { BridgeError, BridgeLink, NOT_CONNECTED, QUICK_TIMEOUT_MS } from "./link";
import type { BridgeProviderInfo, BridgeStatus, CaptureResult } from "./protocol";
// One source of truth for the version, exactly as the extension does it.
import pkg from "../package.json" with { type: "json" };

const PORT = Number(process.env.TABRUNNER_BRIDGE_PORT ?? 17_836);
/**
 * One id for every channel — the store listing's, which the manifest `key`
 * also pins the website's unpacked zip and every dev load to. Anything else is
 * someone's own build, which health names instead of trusting silently.
 */
const EXPECTED_EXTENSION_ID =
  process.env.TABRUNNER_BRIDGE_EXPECTED_EXTENSION_ID ?? "ilnohobdcigbmlikjbkdpbkhciephdle";

/** Under a client's own timeout, so a wait ends as an answer, not a failure. */
const DEFAULT_WAIT_SECONDS = 30;
const MAX_WAIT_SECONDS = 55;
/** Enough to follow the work; the transcript in the panel keeps everything. */
const MAX_STEPS_SHOWN = 12;

const link = new BridgeLink(PORT);
link.listen();

// ── Output shaping ──────────────────────────────────────────────────

type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
const text = (body: string) => ({ content: [{ type: "text" as const, text: body }] });
const failure = (body: string) => ({
  content: [{ type: "text" as const, text: body }],
  isError: true as const,
});

/** Every tool answers the same way when the extension isn't there. */
async function withLink<T>(
  run: () => Promise<T>,
): Promise<T | { content: Content[]; isError: true }> {
  try {
    return await run();
  } catch (e) {
    if (e instanceof BridgeError) return failure(e.message);
    throw e;
  }
}

function elapsed(from: number | null, to: number | null): string {
  if (!from) return "";
  const seconds = Math.round(((to ?? Date.now()) - from) / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

function formatStatus(status: BridgeStatus): string {
  const lines: string[] = [];
  const took = elapsed(status.startedAt, status.finishedAt);

  switch (status.state) {
    case "idle":
      lines.push(
        status.queue.length > 0
          ? "state: idle. Nothing is running right now, but the queue below is waiting."
          : "state: idle. No task has been started in this chat yet. Start one with run.",
      );
      break;
    case "running":
      lines.push(`state: running · ${took} so far`);
      break;
    case "question":
      lines.push(`state: question. TabRunner stopped to ask you something (after ${took})`);
      break;
    case "done":
      lines.push(`state: done · ${took}`);
      break;
    case "error":
      lines.push(`state: error · ${took}`);
      break;
  }

  if (status.driving) {
    lines.push(`tab: ${status.driving.title || "(untitled)"} (window ${status.driving.windowId})`);
  }

  if (status.queue.length > 0) {
    lines.push(
      `queue: ${status.queue.length} waiting (tasks run one at a time; these start in order)`,
    );
    for (const q of status.queue) {
      const excerpt = q.task.length > 80 ? `${q.task.slice(0, 80)}…` : q.task;
      lines.push(
        `  ${q.position}. ${excerpt} (from ${q.owner === "panel" ? "the TabRunner panel" : "this client"})`,
      );
    }
  }

  if (status.plan) {
    const { steps, current } = status.plan;
    lines.push(`plan: ${Math.min(current, steps.length)}/${steps.length}`);
    steps.forEach((step, i) => {
      lines.push(`  ${i < current ? "✓" : i === current ? "▸" : "·"} ${step}`);
    });
  }

  if (status.steps.length > 0) {
    const shown = status.steps.slice(-MAX_STEPS_SHOWN);
    const dropped = status.steps.length - shown.length;
    lines.push(
      `steps: ${status.steps.length}${dropped > 0 ? ` (oldest ${dropped} not shown)` : ""}`,
    );
    for (const step of shown) {
      lines.push(
        `  ${step.ok === false ? "✗" : step.ok ? "✓" : "·"} ${step.tool}: ${step.summary}`,
      );
    }
  }

  if (status.state === "question" && status.question) {
    lines.push("", `question: ${status.question}`);
    // The options exist only when the answer really is one of a few — offer
    // them verbatim, since the run is waiting on those exact words, and let
    // the user say something else anyway.
    if (status.choices?.length) {
      for (const choice of status.choices) lines.push(`  - ${choice}`);
      lines.push(
        "next: relay this question AND its options to the user, then send their reply with answer, using their own words if none of the options fit. TabRunner asks before consequential actions (paying, sending on someone's behalf, deleting or submitting), so never answer those yourself.",
      );
    } else {
      lines.push(
        "next: relay this question to the user and send their reply with answer. TabRunner asks before consequential actions (paying, sending on someone's behalf, deleting or submitting), so never answer those yourself.",
      );
    }
  }
  if (status.state === "done") {
    lines.push("", `answer: ${status.summary ?? "(the task ended without a closing summary)"}`);
  }
  if (status.state === "error" && status.error) {
    lines.push("", `error: ${status.error}`);
  }
  if (status.state === "running") {
    lines.push(
      "",
      "next: call get_status again to wait for the next change, or steer to nudge the task.",
    );
  }

  return lines.join("\n");
}

// ── MCP server ──────────────────────────────────────────────────────

const server = new McpServer({ name: "tabrunner", version: pkg.version });

server.registerTool(
  "health",
  {
    title: "TabRunner health",
    description:
      "Check that the browser agent is reachable before driving it. Reports whether the TabRunner extension is connected to this bridge, which extension it is, whether it has a provider ready to think with, and what to do when any of that is missing. Call this first, and again after any connection error.",
  },
  async () => {
    const match = link.extension ? link.extension.id === EXPECTED_EXTENSION_ID : null;
    const provider = link.connected ? await providerInfo() : null;
    const lines = [
      `connected: ${link.connected}`,
      `port: ${PORT}`,
      `extension: ${link.extension ? `${link.extension.id} (v${link.extension.version})` : "none"}`,
      `expected extension: ${EXPECTED_EXTENSION_ID}`,
    ];
    if (provider) lines.push(`provider: ${describeProvider(provider)}`);

    if (link.problem) lines.push("", link.problem);
    else if (!link.connected) lines.push("", NOT_CONNECTED);
    else if (match === false) {
      lines.push(
        "",
        `A different extension is connected than the ones expected.\nCause: this is probably an unpacked build carrying no manifest key, which gets its own id.\nFix: if you trust it, set TABRUNNER_BRIDGE_EXPECTED_EXTENSION_ID=${link.extension?.id} for this daemon; otherwise load the Chrome Web Store build.`,
      );
    } else if (provider && !provider.ready) lines.push("", providerProblem(provider));
    else lines.push("", "Ready. Start a browser task with run.");
    return text(lines.join("\n"));
  },
);

/** Never let a provider lookup fail the health check — the link report still stands. */
async function providerInfo(): Promise<BridgeProviderInfo | null> {
  try {
    return await link.request<BridgeProviderInfo>("providerInfo", {}, QUICK_TIMEOUT_MS);
  } catch {
    return null;
  }
}

const describeProvider = (p: BridgeProviderInfo): string =>
  p.name === null
    ? "none configured"
    : `${p.name} · model ${p.model ?? "auto"}${p.ready ? "" : p.auth === "subscription" ? " · NOT SIGNED IN" : " · NO API KEY"}`;

/**
 * A reachable browser with no usable provider is the failure this tool exists
 * to pre-empt: run would take the task and die on the first model call. Direct
 * control needs no provider, so the fix says so rather than declaring the
 * browser unusable.
 */
const providerProblem = (p: BridgeProviderInfo): string =>
  p.name === null
    ? "TabRunner is connected, but no provider is configured. run has no model to use.\n" +
      "Cause: nothing has been added in TabRunner's settings yet.\n" +
      "Fix: the user adds a subscription sign-in or API key in TabRunner's settings. Direct control (browser_start and the browser_* verbs) works without one."
    : `TabRunner is connected, but ${p.name} has no working credential. run would fail on its first model call.\n` +
      `Cause: the ${p.auth === "subscription" ? "sign-in was never completed, expired, or was revoked" : "API key is missing"}.\n` +
      `Fix: the user ${p.auth === "subscription" ? "signs in again" : "pastes a key"} in TabRunner's settings, or picks another provider in the panel header. Direct control (browser_start and the browser_* verbs) works without one.`;

server.registerTool(
  "run",
  {
    title: "Run a browser task",
    description:
      "Give TabRunner a task to do in the user's real Chrome, with their existing logins and sessions to navigate, read pages, click, type, fill forms and extract data. Describe the goal in plain language, as you would to a person; TabRunner plans and executes the steps itself. Returns immediately: follow the task with get_status. By default the task opens its own background tab (optionally at url), leaving the user's current page alone; pass background: false only when the task is explicitly about what the user is looking at.",
    inputSchema: {
      task: z.string().describe("What to do, in plain language. Include any URL to start from."),
      url: z
        .string()
        .optional()
        .describe("Where the background tab starts. Defaults to the user's configured start page."),
      background: z
        .boolean()
        .optional()
        .describe(
          "Run in a fresh background tab (default true). false drives the tab the user is on.",
        ),
      images: z
        .array(
          z.object({
            data: z.string().describe("Base64 image bytes, without a data: prefix."),
            mimeType: z.string().describe("e.g. image/png or image/jpeg"),
          }),
        )
        .optional()
        .describe(
          "Images to attach to the task, such as a screenshot to match or a form to copy from.",
        ),
    },
  },
  async ({ task, url, background, images }) =>
    withLink(async () => {
      const result = await link.request<{
        runId: string;
        conversationId: string;
        queued?: number;
      }>("run", {
        task,
        agent: clientName(),
        ...(url ? { url } : {}),
        ...(background === undefined ? {} : { background }),
        ...(images?.length
          ? { images: images.map((i) => `data:${i.mimeType};base64,${i.data}`) }
          : {}),
      });
      // Tasks run one at a time — a second one waits in line, and the queue
      // event the extension pushed ahead of this answer already lists it.
      if (result.queued !== undefined) {
        return text(
          `Queued at position ${result.queued}. Another task is running, and tasks run one at a time. run ${result.runId}\nCall get_status to watch it start. It blocks until something happens, so polling costs one turn per real change.`,
        );
      }
      link.startRun(result.runId, result.conversationId);
      return text(
        `Started. run ${result.runId}\nCall get_status to follow it. It blocks until something happens, so polling costs one turn per real change.`,
      );
    }),
);

server.registerTool(
  "get_status",
  {
    title: "Follow the task",
    description:
      "Where the current task stands: the plan and the steps taken; when it ends, the answer, the question it stopped on or the error. By default this WAITS for the next change instead of returning immediately, so following a ten-minute task costs one call per real event. Keep calling it until state is done, error, or question.",
    inputSchema: {
      wait: z
        .boolean()
        .optional()
        .describe("Block until the task changes state (default true). false returns immediately."),
      waitSeconds: z
        .number()
        .optional()
        .describe(
          `How long to block, up to ${MAX_WAIT_SECONDS}s (default ${DEFAULT_WAIT_SECONDS}s).`,
        ),
    },
  },
  async ({ wait, waitSeconds }) => {
    const shouldWait = wait ?? true;
    // Park while there is something to wait FOR: a run in flight, or one of
    // this client's runs queued — its `started` event wakes the wait.
    const queuedOurs = link.status.queue.some((q) => q.owner === "bridge");
    if (shouldWait && (link.status.state === "running" || queuedOurs)) {
      const seconds = Math.min(Math.max(waitSeconds ?? DEFAULT_WAIT_SECONDS, 1), MAX_WAIT_SECONDS);
      await link.waitForChange(link.revision, seconds * 1000);
    }
    const body = formatStatus(link.status);
    // A disconnect mid-run is not the run dying — the extension keeps working
    // and re-syncs on reconnect. Say that, so nobody restarts a live task.
    return text(
      link.connected
        ? body
        : `${body}\n\n(the extension is not connected right now: ${NOT_CONNECTED})`,
    );
  },
);

server.registerTool(
  "answer",
  {
    title: "Answer TabRunner's question",
    description:
      "Reply to the question a task stopped on (state: question) and let it continue. TabRunner stops to ask before consequential actions (paying, sending on the user's behalf, deleting or submitting), so relay the question to the user and send THEIR decision, never your own.",
    inputSchema: { text: z.string().describe("The user's answer, in their words.") },
  },
  async ({ text: answerText }) =>
    withLink(async () => {
      // An answer starts a fresh run over the same thread — same claim as run.
      const result = await link.request<{
        runId: string;
        conversationId: string;
        queued?: number;
      }>("answer", {
        text: answerText,
      });
      if (result.queued !== undefined) {
        return text(
          `Answered. The continuation is queued at position ${result.queued} behind the task in flight. Follow it with get_status.`,
        );
      }
      link.startRun(result.runId, result.conversationId);
      return text("Answered. The task continues. Follow it with get_status.");
    }),
);

server.registerTool(
  "steer",
  {
    title: "Steer the running task",
    description:
      "Send a note into a task that is already running, such as a correction, an extra constraint or a change of approach. It lands between tool calls, so the task absorbs it without restarting. Use this instead of stop+run when the goal is still the same.",
    inputSchema: { text: z.string().describe("The note for the running agent.") },
  },
  async ({ text: note }) =>
    withLink(async () => {
      await link.request("steer", { text: note });
      return text("Sent. It arrives between the next tool calls.");
    }),
);

server.registerTool(
  "stop",
  {
    title: "Stop the task",
    description:
      "Stop the current task. Stopping is normal control flow, not an error, and it leaves the browser exactly as it is. Nothing is undone.",
  },
  async () =>
    withLink(async () => {
      const result = await link.request<{ stopped: boolean; panelBusy: boolean }>("stop");
      if (result.stopped) return text("Stopped.");
      // Never let a no-op stop read as "the browser is free now".
      return text(
        result.panelBusy
          ? "Nothing of yours was stopped. The current task was started from TabRunner's own panel, and only the panel can stop it. Ask the user to stop it there, or wait."
          : "Nothing to stop. No task was running.",
      );
    }),
);

server.registerTool(
  "screenshot",
  {
    title: "See the browser",
    description:
      "A picture of what the browser is showing right now. Use it to check a result with your own eyes, or to see what a page looks like before describing a task. Works whether or not a task is running.",
  },
  async () =>
    withLink(async () => {
      const shot = await link.request<CaptureResult>("screenshot");
      const [, mimeType = "image/jpeg", data = ""] =
        /^data:([^;]+);base64,(.*)$/.exec(shot.dataUrl) ?? [];
      const caption = `${shot.title || "(untitled)"}: ${shot.url}${
        shot.driven ? "" : "\n(this is the visible tab; the task is driving a different one)"
      }`;
      return {
        content: [
          { type: "image" as const, data, mimeType },
          { type: "text" as const, text: caption },
        ],
      };
    }),
);

server.registerTool(
  "new_conversation",
  {
    title: "Start a fresh chat",
    description:
      "Forget the current chat and start clean. TabRunner keeps one chat for this bridge. Each task continues the previous ones, so it remembers the pages it visited and what it found. Reset only when the new task has nothing to do with the old one.",
  },
  async () =>
    withLink(async () => {
      await link.request("newConversation");
      link.reset();
      return text("New chat. The next task starts with no history.");
    }),
);

server.registerTool(
  "compact",
  {
    title: "Compact the chat",
    description:
      "Summarize this chat's history so far, so every task replays a summary instead of the whole transcript. The raw messages stay in the user's panel; only what the model re-reads changes, and nothing is deleted. Reach for it when a long chat's tasks get slow or one dies on a context-length error. Cannot run while a task is in flight.",
  },
  async () =>
    withLink(async () => {
      const result = await link.request<{
        messages?: number;
        before?: number;
        after?: number;
        nothing?: boolean;
      }>("compact");
      if (result.nothing)
        return text("Nothing to compact. This chat is still short enough to replay in full.");
      return text(
        `Compacted ${result.messages} messages. The chat now replays ~${result.after} tokens instead of ~${result.before}.`,
      );
    }),
);

// ── Direct control ──────────────────────────────────────────────────
//
// The other half of the bridge: for a client that would rather drive than
// delegate. Discrete browser_* tools because that is the shape models already
// know cold — but they all cross the wire as one `browserAct` method, so the
// extension keeps a single browser implementation and nothing can drift.
//
// The catch worth stating in every description: driving directly means
// TabRunner's own model is not in the loop, and neither is its policy of
// stopping to ask before consequential actions. That rule is the client's to
// keep here.

/** What the client calls itself, from MCP initialize — history shows this. */
function clientName(): string {
  const info = server.server.getClientVersion();
  // Empty when unknown — the extension localizes the fallback label for the
  // transcript chip (history.unknownAgent); the daemon is English-only and
  // has no business naming the client itself.
  return info?.name ? `${info.name}` : "";
}

async function act(tool: string, toolArgs: Record<string, unknown> = {}) {
  return withLink(async () => {
    const result = await link.request<{ ok?: boolean; data?: unknown; error?: string }>(
      "browserAct",
      { tool, args: toolArgs },
    );
    return text(renderToolResult(tool, result));
  });
}

/** The page as the model needs to read it, plus whatever the action returned. */
function renderToolResult(
  tool: string,
  result: { ok?: boolean; data?: unknown; error?: string },
): string {
  const data = (result.data ?? {}) as {
    pageContent?: string;
    tabs?: unknown[];
    url?: string;
    result?: unknown;
    requests?: unknown[];
    messages?: unknown[];
    note?: string;
  };
  const parts: string[] = [`${tool}: ${result.ok === false ? "failed" : "ok"}`];
  if (result.error) parts.push(`error: ${result.error}`);
  if (data.url) parts.push(`url: ${data.url}`);
  if (data.tabs) parts.push(JSON.stringify(data.tabs, null, 2));
  // evaluate's payload — already sanitized and bounded extension-side.
  if (data.result !== undefined) parts.push("result:", JSON.stringify(data.result, null, 2));
  if (data.requests) parts.push("requests:", JSON.stringify(data.requests, null, 2));
  if (data.messages) parts.push("messages:", JSON.stringify(data.messages, null, 2));
  if (data.note) parts.push(`note: ${data.note}`);
  if (data.pageContent) {
    parts.push(
      "",
      "page (refs are valid only for THIS snapshot; act on them before the page changes):",
      data.pageContent,
    );
  }
  return parts.join("\n");
}

server.registerTool(
  "browser_start",
  {
    title: "Start driving the browser yourself",
    description:
      "Open a direct-control session and get the first page snapshot. Use this instead of run when you want to drive step by step rather than hand TabRunner the whole task. run is still the better choice for anything long or open-ended, because TabRunner's own model plans it. State the goal: it names the chat the user will see in TabRunner's history, and every action you take is recorded under it. IMPORTANT: driving directly bypasses TabRunner's own model and its rule of stopping to ask before consequential actions, so paying, sending on the user's behalf, deleting, or submitting is yours to put to the user first.",
    inputSchema: {
      goal: z
        .string()
        .describe("What you're setting out to do, in the user's terms. Titles the chat."),
    },
  },
  async ({ goal }) =>
    withLink(async () => {
      const result = await link.request<{ data?: unknown }>("browserStart", {
        goal,
        agent: clientName(),
      });
      return text(
        `Driving directly. The user sees this as "${goal}" in TabRunner's history, with every action under it.\n\n${renderToolResult("snapshot", result)}`,
      );
    }),
);

server.registerTool(
  "browser_snapshot",
  {
    title: "Read the page",
    description:
      "The current page as an accessibility tree with a ref on every interactive element. This is how you see, and where every ref you click comes from. Refs belong to the snapshot that produced them: after anything changes the page, re-read before acting.",
  },
  async () => act("snapshot"),
);

server.registerTool(
  "browser_network_requests",
  {
    title: "List network requests",
    description:
      "The requests the driven tab has made since the session attached, with method, URL, status and failures. Tells 'the server answered with an error' apart from 'the page never sent it'. Response bodies are not captured; re-fetch a GET with browser_evaluate when the payload matters.",
    inputSchema: {
      url_filter: z.string().optional().describe("Only URLs containing this substring."),
      limit: z.number().optional().describe("How many to return (default 50, max 200)."),
    },
  },
  async ({ url_filter, limit }) =>
    act("read_network_requests", {
      ...(url_filter ? { url_filter } : {}),
      ...(limit === undefined ? {} : { limit }),
    }),
);

server.registerTool(
  "browser_console_messages",
  {
    title: "Read console output",
    description:
      "The driven tab's console messages and uncaught exceptions since the session attached. When a page misbehaves for no visible reason, the JavaScript error usually names the broken piece.",
    inputSchema: {
      only_errors: z.boolean().optional().describe("Only errors and exceptions (default false)."),
      limit: z.number().optional().describe("How many to return (default 50, max 200)."),
    },
  },
  async ({ only_errors, limit }) =>
    act("read_console_messages", {
      ...(only_errors ? { only_errors } : {}),
      ...(limit === undefined ? {} : { limit }),
    }),
);

server.registerTool(
  "browser_navigate",
  {
    title: "Go to a URL",
    description: "Navigate the driven tab and return the new page's snapshot.",
    inputSchema: { url: z.string().describe("Absolute URL, including the scheme.") },
  },
  async ({ url }) => act("navigate", { url }),
);

server.registerTool(
  "browser_click",
  {
    title: "Click an element",
    description:
      "Click by ref with a real trusted event, not a synthetic dispatch a site can ignore. Returns the resulting page. Take the ref from the most recent snapshot.",
    inputSchema: { ref: z.string().describe('A ref from the latest snapshot, e.g. "e12".') },
  },
  async ({ ref }) => act("click", { ref }),
);

server.registerTool(
  "browser_type",
  {
    title: "Type text",
    description:
      "Type into whatever is focused. Click the field first. Real keystrokes, so a site's own handlers fire. Returns the resulting page.",
    inputSchema: { text: z.string().describe("The text to type.") },
  },
  async ({ text: body }) => act("type", { text: body }),
);

server.registerTool(
  "browser_fill",
  {
    title: "Set a field's value",
    description:
      "Set the value of a field by ref. Supports text inputs, textareas, selects (by option label or value) and contenteditable. The value is set the way the page's own code notices, so it lands where typed keystrokes don't (pages that swallow key events, focus that won't stick). Pass an empty string to clear a field. Returns the resulting page.",
    inputSchema: {
      ref: z.string().describe('A ref from the latest snapshot, e.g. "e12".'),
      text: z.string().describe("The value to set. An empty string clears the field."),
    },
  },
  async ({ ref, text: body }) => act("fill", { ref, text: body }),
);

server.registerTool(
  "browser_evaluate",
  {
    title: "Run JavaScript in the page",
    description:
      "Run JavaScript in the driven tab's page context and get the result back. Promises are awaited; return only JSON-serializable values, not DOM nodes. For what the other tools cannot do: reading an attribute the tree omits, piercing shadow DOM, calling the page's own functions, fetching an endpoint the page itself uses. Results are bounded and credential-shaped values are stripped. A direct session has no plan gate. The code runs exactly as written, so the consequential-action rule (paying, sending on the user's behalf, deleting, submitting, by fetch or any other means) is yours to put to the user first. Returns the resulting page.",
    inputSchema: {
      expression: z
        .string()
        .describe("The JavaScript to run. Top-level await works; the last value is returned."),
    },
  },
  async ({ expression }) => act("evaluate", { expression }),
);

server.registerTool(
  "browser_press_key",
  {
    title: "Press a key",
    description:
      'A single key press: "Enter" to submit, "Escape" to dismiss, "Tab" to move on. Returns the resulting page.',
    inputSchema: { key: z.string().describe('e.g. "Enter", "Escape", "Tab", "ArrowDown".') },
  },
  async ({ key }) => act("press_key", { key }),
);

server.registerTool(
  "browser_scroll",
  {
    title: "Scroll the page",
    description:
      "Scroll the driven tab and return what is now in view. Content below the fold is not in a snapshot until you scroll to it.",
    inputSchema: {
      direction: z.enum(["down", "up"]).describe("Which way to scroll."),
      amount: z.number().optional().describe("Pixels; defaults to about one screenful."),
    },
  },
  async ({ direction, amount }) =>
    act(direction === "up" ? "scroll_up" : "scroll_down", amount === undefined ? {} : { amount }),
);

server.registerTool(
  "browser_tabs",
  {
    title: "List open tabs",
    description: "Every open tab with its id, title and URL. Find the one you need, then switch.",
  },
  async () => act("list_tabs"),
);

server.registerTool(
  "browser_switch_tab",
  {
    title: "Switch tabs",
    description:
      "Point every later action at another tab and bring it to the front. Trusted input needs the tab on screen, so this focuses it.",
    inputSchema: { tab_id: z.number().describe("A tab id from browser_tabs.") },
  },
  async ({ tab_id }) => act("switch_tab", { tab_id }),
);

server.registerTool(
  "browser_end",
  {
    title: "Stop driving",
    description:
      "Close the direct-control session, drop the on-page 'being controlled' badge, and hand the browser back. Call it when you're done. It also frees TabRunner's panel to run tasks again. A session left open expires on its own after a few idle minutes.",
  },
  async () =>
    withLink(async () => {
      await link.request("browserEnd");
      return text("Done driving. The browser is the user's again.");
    }),
);

await server.connect(new StdioServerTransport());
console.error(`[tabrunner] MCP bridge ready — WebSocket on 127.0.0.1:${PORT}`);
