/**
 * Observe planner tool selection without opening a browser or running delegate.
 * Plan approval and page reads are simulated. No other tool is executed.
 *
 * Dry run (no requests): bun run scripts/probe-delegation.ts --model <model-id>
 * Live: OPENROUTER_API_KEY=... bun run scripts/probe-delegation.ts --model <model-id> --live
 * Add --no-delegate for the same task without the tool, or --read-only for an ineligible task.
 * --live sends the synthetic page and production instructions to OpenRouter, up to 3 requests.
 */
import { mock } from "bun:test";
import { parseArgs } from "node:util";
import en from "../src/i18n/locales/en.json";
import type { ChatMessage, ToolCall } from "../src/modules/providers/types";

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    model: { type: "string" },
    live: { type: "boolean", default: false },
    "no-delegate": { type: "boolean", default: false },
    "read-only": { type: "boolean", default: false },
  },
});
if (!values.model) throw new Error("Choose a planner model with --model <model-id>.");
const apiKey = process.env.OPENROUTER_API_KEY ?? "";
if (values.live && !apiKey) {
  throw new Error("No OpenRouter key found. Set OPENROUTER_API_KEY or omit --live for a dry run.");
}

// Production imports define storage items. Give them defaults, never real browser storage.
mock.module("wxt/utils/storage", () => ({
  storage: {
    defineItem: (_key: string, { fallback }: { fallback: unknown }) => ({
      getValue: async () => fallback,
      watch: () => () => {},
    }),
    getItems: async (keys: { key: string; options: { fallback: unknown } }[]) =>
      keys.map(({ key, options }) => ({ key, value: options.fallback })),
  },
}));

const { buildSystemPrompt, buildTaskMessage, buildToolDefs } =
  await import("../src/modules/agent/prompt");
const { createProvider } = await import("../src/modules/providers/factory");
const { resolveProviderModel } = await import("../src/modules/providers/models");
const { PRESETS } = await import("../src/modules/providers/presets");
const { i18n } = await import("../src/i18n");
const { createLogger } = await import("../src/lib/logger");
await i18n.init({ resources: { en: { translation: en } }, lng: "en" });
const log = createLogger("delegation-probe");
const preset = PRESETS.find((p) => p.id === "openrouter");
if (!preset) throw new Error("The OpenRouter preset is missing.");

const pageContent = `URL: https://shop.example/search
Title: Product search
heading "Product search"
textbox "Search" [ref=e1] value=""
textbox "Maximum price" [ref=e2] value=""
combobox "Sort" [ref=e3] value="Relevance" options="Relevance, Price: low to high"
button "Search" [ref=e4]
Our store closes at 18:00.
No search has been run yet.`;
const task = values["read-only"]
  ? "What time does this store close?"
  : "Find coffee grinders costing at most $100, sorted by lowest price. Show me the results; don't buy anything.";
const delegateOn = !values["no-delegate"];
const tools = buildToolDefs(false, false, false, false, delegateOn);
const messages: ChatMessage[] = [
  {
    role: "system",
    content: buildSystemPrompt(
      { instructions: "", memory: "", memoryOn: false },
      "English",
      false,
      [],
      [],
      delegateOn,
    ),
  },
  { role: "user", content: buildTaskMessage(task, pageContent, { mode: "adopted" }) },
];
const config = await resolveProviderModel({
  id: preset.id,
  name: preset.name,
  shape: preset.shape,
  baseUrl: preset.baseUrl,
  apiKey: values.live ? apiKey : "dry-run",
  model: values.model,
  createdAt: 0,
});
log.info({
  live: values.live,
  model: config.model,
  readOnly: values["read-only"],
  delegateOffered: tools.some((t) => t.name === "delegate"),
  delegationInstructions: messages[0]?.content.includes("# Jev"),
  tools: tools.length,
});
if (!values.live) {
  log.info("No requests sent. Add --live to observe planner selection with this synthetic page.");
  process.exit(0);
}

const provider = createProvider(config);
for (let turn = 1; turn <= 3; turn++) {
  const calls: ToolCall[] = [];
  let text = "";
  let reasoning = "";
  for await (const delta of provider.stream(messages, tools, AbortSignal.timeout(60_000))) {
    if (delta.type === "tool_use") calls.push(delta);
    if (delta.type === "text") text += delta.text;
    if (delta.type === "reasoning") reasoning += delta.text;
    if (delta.type === "usage") log.info("usage", delta);
  }
  log.info("requested tools", { turn, calls: calls.map(({ name, args }) => ({ name, args })) });
  const selected = calls.some((call) => call.name === "delegate");
  const maySimulate = calls.every((c) => ["plan", "snapshot", "read_page_text"].includes(c.name));
  if (selected || !maySimulate || calls.length === 0 || turn === 3) {
    log.info("result", { selected, turns: turn, executedBrowserActions: 0 });
    break;
  }
  messages.push({
    role: "assistant",
    content: text,
    toolCalls: calls,
    ...(reasoning ? { reasoning } : {}),
  });
  messages.push({
    role: "tool_results",
    content: "",
    toolResults: calls.map((call) => ({
      id: call.id,
      content: JSON.stringify(
        call.name === "plan"
          ? { steps: call.args.steps, current: call.args.current }
          : {
              pageContent,
              text: pageContent,
              url: "https://shop.example/search",
              title: "Product search",
            },
      ),
    })),
  });
}
