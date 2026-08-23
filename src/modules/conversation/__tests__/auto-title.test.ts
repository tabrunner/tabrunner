import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { maybeAutoTitle } from "../title";
import {
  appendMessageFresh,
  appendMessageTo,
  listConversations,
  renameConversation,
} from "../conversations";
import type { Message } from "../types";
import type { ResolvedProviderConfig } from "@/modules/providers/types";

// Storage stand-in and i18n come from src/test-setup.ts (vitest setupFiles).

const config: ResolvedProviderConfig = {
  id: "test",
  name: "Test",
  shape: "openai",
  baseUrl: "https://api.example.com/v1",
  apiKey: "sk-test",
  model: "test-model",
  createdAt: 0,
};

let seq = 0;
const userMsg = (content: string): Message => ({
  id: `m${++seq}`,
  role: "user",
  content,
  timestamp: 1_000 + seq,
});

/** The titler's one streamed reply. */
function mockTitleReply(text: string) {
  const encoder = new TextEncoder();
  return vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(
      new ReadableStream({
        start(controller) {
          for (const line of [
            `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}`,
            "data: [DONE]",
          ]) {
            controller.enqueue(encoder.encode(line + "\n"));
          }
          controller.close();
        },
      }),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    ),
  );
}

const titleOf = async (id: string) => (await listConversations()).find((c) => c.id === id)?.title;

const LONG_TASK = "hey\ngo book me a table at Rossi's for four on Friday";

describe("maybeAutoTitle", () => {
  beforeEach(() => {
    seq = 0;
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("names the thread its opening task titled badly — transcript already holds that task", async () => {
    // The panel and the bridge both STORE the user message before the run
    // starts, so by the time a run asks, the transcript already has a user turn.
    // The stored title, not the transcript, is what says this task opened it.
    const id = await appendMessageFresh(userMsg(LONG_TASK));
    expect(await titleOf(id)).toBe("hey");

    const fetchSpy = mockTitleReply("Book a table at Rossi's");
    await maybeAutoTitle(id, LONG_TASK, config, new AbortController().signal);

    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(await titleOf(id)).toBe("Book a table at Rossi's");
  });

  it("leaves a title that already says the task alone, without a call", async () => {
    const id = await appendMessageFresh(userMsg("book a flight to Lisbon"));
    const fetchSpy = mockTitleReply("Lisbon flight booking");

    await maybeAutoTitle(id, "book a flight to Lisbon", config, new AbortController().signal);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await titleOf(id)).toBe("book a flight to Lisbon");
  });

  it("ignores a follow-up task — only the message that named the thread retitles it", async () => {
    const id = await appendMessageFresh(userMsg(LONG_TASK));
    await appendMessageTo(id, userMsg("actually\nmake it six people"));
    const fetchSpy = mockTitleReply("Party of six");

    await maybeAutoTitle(id, "actually\nmake it six people", config, new AbortController().signal);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await titleOf(id)).toBe("hey");
  });

  it("never overwrites a name the user gave it", async () => {
    const id = await appendMessageFresh(userMsg(LONG_TASK));
    await renameConversation(id, "Dinner");
    const fetchSpy = mockTitleReply("Book a table at Rossi's");

    await maybeAutoTitle(id, LONG_TASK, config, new AbortController().signal);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await titleOf(id)).toBe("Dinner");
  });

  it("leaves the derived title standing when the call fails", async () => {
    const id = await appendMessageFresh(userMsg(LONG_TASK));
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));

    await expect(
      maybeAutoTitle(id, LONG_TASK, config, new AbortController().signal),
    ).resolves.toBeUndefined();
    expect(await titleOf(id)).toBe("hey");
  });
});
