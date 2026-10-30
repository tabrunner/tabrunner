import { describe, expect, it, vi } from "vitest";
import { fireHook, hooksPending } from "../fire";
import { deleteHook, listHookRules, saveHook, setHookEnabled, stampDelivery } from "../store";
import { MAX_HOOKS, type HookRule } from "../types";

// Storage stand-in and the en catalog come from src/test-setup.ts.

function posts(): { url: string; headers: Record<string, string>; body: string }[] {
  const seen: { url: string; headers: Record<string, string>; body: string }[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    seen.push({
      url: String(input),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === "string" ? init.body : "",
    });
    return new Response(null, { status: 200 });
  });
  return seen;
}

describe("hook registry", () => {
  it("validates event and URL at save, caps the list", async () => {
    expect(
      (await saveHook({ event: "nope" as HookRule["event"], url: "https://x.example" })).ok,
    ).toBe(false);
    expect((await saveHook({ event: "run_finished", url: "http://remote.example" })).ok).toBe(
      false,
    );
    for (let i = 0; i < MAX_HOOKS; i++)
      await saveHook({ event: "run_finished", url: `https://h${i}.example` });
    const over = await saveHook({ event: "run_started", url: "https://over.example" });
    expect(over.ok).toBe(false);
    expect(await listHookRules()).toHaveLength(MAX_HOOKS);
  });

  it("toggles, deletes, and stamps delivery receipts", async () => {
    const saved = await saveHook({
      event: "error",
      url: "https://h.example",
      headers: { Authorization: "Bearer x" },
    });
    if (!saved.ok) throw new Error("expected save");
    expect(await setHookEnabled(saved.rule.id, false)).toBe(true);
    expect((await listHookRules())[0]!.enabled).toBe(false);

    await stampDelivery(saved.rule.id, { at: 1234, ok: true, status: 204 });
    expect((await listHookRules())[0]!.lastDelivery).toEqual({ at: 1234, ok: true, status: 204 });

    expect(await deleteHook(saved.rule.id)).toBe(true);
    expect(await listHookRules()).toHaveLength(0);
  });
});

describe("fireHook", () => {
  it("delivers to enabled matching rules with auth headers and a bounded payload", async () => {
    await saveHook({
      event: "run_finished",
      url: "https://match.example",
      headers: { Authorization: "Bearer tok" },
    });
    await saveHook({ event: "run_finished", url: "https://off.example", enabled: false });
    await saveHook({ event: "error", url: "https://other-event.example" });
    const seen = posts();

    fireHook("run_finished", { conversationId: "c1", task: "x".repeat(5000), outcome: "done" });
    await hooksPending();

    expect(seen.map((p) => new URL(p.url).host)).toEqual(["match.example"]);
    expect(seen[0]!.headers.Authorization).toBe("Bearer tok");
    const body = JSON.parse(seen[0]!.body) as Record<string, unknown>;
    expect(body.event).toBe("run_finished");
    expect(body.outcome).toBe("done");
    expect(String(body.task).length).toBeLessThanOrEqual(2000);
  });

  it("stamps failures without throwing, and hooksPending drains", async () => {
    await saveHook({ event: "ask_user", url: "https://dead.example" });
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("refused"));

    fireHook("ask_user", { conversationId: "c1", task: "t", question: "?" });
    await hooksPending();
    const rule = (await listHookRules())[0]!;
    expect(rule.lastDelivery?.ok).toBe(false);
  });
});
