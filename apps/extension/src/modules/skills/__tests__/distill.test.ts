import { describe, it, expect, vi, afterEach } from "vitest";
import { buildSkillDistillBody, distillSkillDraft, parseSkillReply } from "../distill";
import type { Message } from "@/modules/conversation/types";
import type { ResolvedProviderConfig } from "@/modules/providers/types";

// Storage stand-in and i18n come from src/test-setup.ts (vitest setupFiles).

function msg(role: Message["role"], content: string): Message {
  return { id: crypto.randomUUID(), role, content, timestamp: 0 };
}

/** OpenAI-shape config — the draft turn's provider is rebuilt from this by createProvider. */
function makeConfig(): ResolvedProviderConfig {
  return {
    id: "test",
    name: "Test",
    shape: "openai",
    baseUrl: "https://api.example.com/v1",
    apiKey: "sk-test",
    model: "test-model",
    createdAt: 0,
  };
}

function sseText(lines: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const line of lines) controller.enqueue(encoder.encode(line + "\n\n"));
      controller.close();
    },
  });
}

function mockStreamReply(text: string) {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(
      sseText([
        `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}`,
        "data: [DONE]",
      ]),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    ),
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("buildSkillDistillBody", () => {
  it("renders the transcript the panel's way and drops reasoning", () => {
    const body = buildSkillDistillBody([
      msg("user", "pay my rent"),
      msg("reasoning", "thinking about the page"),
      msg("assistant", "Paid."),
    ]);
    expect(body).toContain("USER: pay my rent");
    expect(body).toContain("AGENT: Paid.");
    expect(body).not.toContain("thinking about the page");
  });

  it("caps on the tail — the corrections live there", () => {
    const body = buildSkillDistillBody([
      msg("user", "OLD ".repeat(20_000)),
      msg("user", "the correction"),
    ]);
    expect(body.length).toBeLessThan(61_000);
    expect(body.startsWith("[earlier turns omitted]")).toBe(true);
    expect(body).toContain("the correction");
  });
});

describe("parseSkillReply", () => {
  it("unwraps a fenced reply before parsing", () => {
    const parsed = parseSkillReply(
      "```markdown\n---\nname: pay-rent\ndescription: pays rent\n---\n\nSteps.\n```",
    );
    expect(parsed.name).toBe("pay-rent");
    expect(parsed.body).toBe("Steps.");
  });
});

describe("distillSkillDraft", () => {
  it("streams the reply and parses it as a SKILL.md", async () => {
    mockStreamReply(
      "---\nname: pay-rent\ndescription: pays rent on the portal\nsites: [acme.com]\n---\n\n1. Open the portal.",
    );
    const draft = await distillSkillDraft(
      makeConfig(),
      [msg("user", "pay rent"), msg("assistant", "Paid.")],
      new AbortController().signal,
    );
    expect(draft.name).toBe("pay-rent");
    expect(draft.sites).toEqual(["acme.com"]);
    expect(draft.body).toBe("1. Open the portal.");
  });

  it("throws on an empty reply, and on an empty conversation without calling out", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await expect(
      distillSkillDraft(makeConfig(), [], new AbortController().signal),
    ).rejects.toThrow();
    expect(fetchSpy).not.toHaveBeenCalled();

    mockStreamReply("");
    await expect(
      distillSkillDraft(makeConfig(), [msg("user", "hi")], new AbortController().signal),
    ).rejects.toThrow();
  });
});
