import { describe, it, expect } from "vitest";
import { defineAgent, type AgentHost } from "@providerkit/agents";
import { assertReport, defineScorer, runEvals, scriptedProvider } from "@providerkit/agents/evals";
import { defineTool } from "@providerkit/core";
import type { BrowserDriver } from "@/modules/browser";
import type { SnapshotResult } from "@/modules/browser/snapshot";
import { buildToolDefs } from "../prompt";
import { executeTool } from "../tools";
import { isGatedTool } from "../loop";

/**
 * Fake page with mutable form state so the scorer checks actual DOM state
 * rather than trusting the model's `done` claim.
 */
interface FakePageState {
  url: string;
  fields: Record<string, string>;
  submitted: boolean;
  clicks: string[];
}

function createFakePageDriver(page: FakePageState): BrowserDriver {
  return {
    snapshot: async (): Promise<SnapshotResult> => ({
      pageContent: [
        `url: ${page.url}`,
        `textbox "Email" value="${page.fields.e1 ?? ""}" [ref=e1]`,
        `textbox "Note" value="${page.fields.e2 ?? ""}" [ref=e2]`,
        `button "Save" [ref=e3]`,
        page.submitted ? 'status "Saved"' : 'status "Draft"',
      ].join("\n"),
      viewport: { width: 800, height: 600 },
      url: page.url,
      title: "Form",
      newRefs: 0,
    }),
    fill: async (ref: string, text: string) => {
      page.fields[ref] = text;
    },
    click: async (ref: string) => {
      page.clicks.push(ref);
      if (ref === "e3") page.submitted = true;
      return { x: 10, y: 20 };
    },
    settle: async () => false,
  } as unknown as BrowserDriver;
}

function buildEvalTools(driver: BrowserDriver) {
  const defs = buildToolDefs(false, false, false, false, false, []).filter((d) =>
    ["plan", "snapshot", "fill", "click", "done", "ask_user"].includes(d.name),
  );
  return defs.map((def) =>
    defineTool<Record<string, unknown>, unknown>({
      name: def.name,
      description: def.description,
      inputSchema: { ...def.params, type: "object" as const },
      isReadOnly: def.name === "snapshot" || def.name === "done" || def.name === "ask_user",
      async run(args, ctx) {
        const result = await executeTool(
          { id: ctx.callId ?? def.name, name: def.name, args },
          driver,
        );
        if (!result.ok) throw new Error(result.error ?? "tool failed");
        if (def.name === "done") {
          return typeof args.summary === "string" ? args.summary : "";
        }
        return result.data ?? { ok: true };
      },
      summarize(output) {
        if (def.name === "done") return typeof output === "string" ? output : "";
        return JSON.stringify(output);
      },
    }),
  );
}

describe("TabRunner SDK evals (real page state)", () => {
  it("passes only when the page state matches the goal, catching hollow done claims", async () => {
    const pages = new Map<string, FakePageState>();

    const pageStateScorer = defineScorer<{ email: string; submitted: boolean }>(
      "page_state",
      ({ case: item, expected }) => {
        const page = pages.get(item.id);
        if (!page || !expected) return { value: false, reason: "Missing page state" };
        const matched = page.fields.e1 === expected.email && page.submitted === expected.submitted;
        return {
          value: matched,
          reason: matched
            ? "Page state verified"
            : `Expected email=${expected.email} submitted=${expected.submitted}, got email=${page.fields.e1 ?? ""} submitted=${page.submitted}`,
        };
      },
      { gate: true },
    );

    const makeHost = (): AgentHost => {
      let approved = false;
      return {
        screenCall(request) {
          if (isGatedTool(request.call.name) && !approved) {
            return { refuse: JSON.stringify({ error: "Plan required before acting." }) };
          }
          if (request.call.name === "plan") approved = true;
          return undefined;
        },
      };
    };

    const report = await runEvals({
      name: "tabrunner-form-eval",
      agent({ case: item }) {
        const page: FakePageState = {
          url: "https://app.example/form",
          fields: {},
          submitted: false,
          clicks: [],
        };
        pages.set(item.id, page);
        const driver = createFakePageDriver(page);

        const provider =
          item.id === "fills-and-submits"
            ? scriptedProvider([
                {
                  // Plan batched behind fill: SDK runFirst hoists plan before fill.
                  toolCalls: [
                    { name: "fill", arguments: { ref: "e1", text: "ops@example.com" } },
                    { name: "plan", arguments: { steps: ["Fill email", "Save"], current: 0 } },
                    { name: "click", arguments: { ref: "e3", commits: false } },
                  ],
                },
                {
                  toolCalls: [{ name: "done", arguments: { summary: "Saved ops@example.com." } }],
                },
              ])
            : scriptedProvider([
                // Dishonest model: claims done without touching the page.
                {
                  toolCalls: [{ name: "done", arguments: { summary: "Saved ops@example.com." } }],
                },
              ]);

        return defineAgent({
          id: "tabrunner-eval-agent",
          version: "1",
          instructions: "Drive the browser form and verify state before finishing.",
          provider,
          tools: buildEvalTools(driver),
          runFirst: ["plan"],
          stopAtTools: ["done", "ask_user"],
          stopOnlyAtTools: { nudge: "Call a tool." },
          limits: { turns: 10, toolCalls: 20, elapsedMs: 30_000, parallelTools: 1 },
        });
      },
      host: makeHost(),
      scorers: [pageStateScorer],
      cases: [
        {
          id: "fills-and-submits",
          input: "Fill email with ops@example.com and click Save.",
          expected: { email: "ops@example.com", submitted: true },
          expectStatus: "completed",
        },
        {
          id: "hollow-done-claim",
          input: "Fill email with ops@example.com and click Save.",
          expected: { email: "ops@example.com", submitted: true },
          expectStatus: "completed",
        },
      ],
    });

    const honest = report.cases.find((c) => c.id === "fills-and-submits");
    const hollow = report.cases.find((c) => c.id === "hollow-done-claim");
    expect(honest?.status).toBe("passed");
    expect(hollow?.status).toBe("failed");

    // Passing dataset passes assertReport cleanly.
    const passingOnly = await runEvals({
      name: "tabrunner-form-pass",
      agent({ case: item }) {
        const page: FakePageState = {
          url: "https://app.example/form",
          fields: {},
          submitted: false,
          clicks: [],
        };
        pages.set(item.id, page);
        const driver = createFakePageDriver(page);
        return defineAgent({
          id: "tabrunner-eval-agent",
          version: "1",
          instructions: "Drive the browser form.",
          provider: scriptedProvider([
            {
              toolCalls: [
                { name: "plan", arguments: { steps: ["Fill email", "Save"], current: 0 } },
                { name: "fill", arguments: { ref: "e1", text: "ops@example.com" } },
                { name: "click", arguments: { ref: "e3", commits: false } },
              ],
            },
            {
              toolCalls: [{ name: "done", arguments: { summary: "Done." } }],
            },
          ]),
          tools: buildEvalTools(driver),
          runFirst: ["plan"],
          stopAtTools: ["done", "ask_user"],
          stopOnlyAtTools: { nudge: "Call a tool." },
          limits: { turns: 10, toolCalls: 20, elapsedMs: 30_000, parallelTools: 1 },
        });
      },
      host: makeHost(),
      scorers: [pageStateScorer],
      cases: [
        {
          id: "verified-submit",
          input: "Fill email with ops@example.com and click Save.",
          expected: { email: "ops@example.com", submitted: true },
          expectStatus: "completed",
        },
      ],
    });

    expect(() => assertReport(passingOnly)).not.toThrow();
  });
});
