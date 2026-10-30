import { afterEach, describe, expect, it, vi } from "vitest";
import { acquireRun, getRunById, listActiveRuns, releaseRun } from "../active-runs";
import { startAgentRun } from "../start-run";
import * as providers from "@/modules/providers";
import type { ResolvedProviderConfig } from "@/modules/providers/types";
import * as browser from "@/modules/browser";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

afterEach(async () => {
  for (const run of listActiveRuns()) {
    await browser.releaseBrowserOwner(run.id);
    releaseRun(run);
  }
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("run setup cleanup", () => {
  it("does not report a provider error when stopped during setup", async () => {
    const wait = deferred();
    vi.spyOn(providers, "getProviderFor").mockImplementation(async () => {
      await wait.promise;
      return undefined;
    });
    const events = vi.fn();
    const task = startAgentRun({
      runId: "stopped-setup",
      ownerId: "client-a",
      owner: "bridge",
      conversationId: "chat-a",
      task: "Read the local page",
      emit: events,
    });
    getRunById("stopped-setup")!.controller.abort();
    wait.resolve();
    await task;
    expect(events).toHaveBeenCalledExactlyOnceWith({ type: "done", stopped: true });
    expect(getRunById("stopped-setup")).toBeNull();
  });

  it("removes an aborted startup tab before releasing ownership, without touching another client", async () => {
    const config: ResolvedProviderConfig = {
      id: "local",
      name: "Local test provider",
      shape: "openai",
      baseUrl: "http://127.0.0.1:1",
      apiKey: "test",
      model: "test-model",
      createdAt: 0,
    };
    vi.spyOn(providers, "getProviderFor").mockResolvedValue(config);
    vi.spyOn(providers, "ensureProviderCredential").mockResolvedValue(config);
    vi.spyOn(providers, "resolveProviderModel").mockResolvedValue(config);
    const load = deferred();
    const removal = deferred();
    const waitForLoad = vi.spyOn(browser, "waitForLoad").mockReturnValue(load.promise);
    const cleanup = vi.spyOn(browser, "releaseBrowserOwner");
    const remove = vi.fn(async () => removal.promise);
    vi.stubGlobal("chrome", {
      ...chrome,
      tabs: {
        ...chrome.tabs,
        create: vi.fn().mockResolvedValue({ id: 51, windowId: 1, status: "loading" }),
        remove,
      },
    });
    const other = acquireRun("other-chat", "bridge", "other-client", "other-run");
    expect(other.ok).toBe(true);
    browser.claimTab("other-run", 52);
    const events = vi.fn();
    const task = startAgentRun({
      runId: "stopped-tab-load",
      ownerId: "client-a",
      owner: "bridge",
      conversationId: "chat-a",
      task: "Read the local page",
      emit: events,
    });
    await vi.waitFor(() => expect(waitForLoad).toHaveBeenCalledWith(51));
    const run = getRunById("stopped-tab-load")!;
    run.controller.abort();
    load.resolve();
    await vi.waitFor(() => expect(remove).toHaveBeenCalledExactlyOnceWith(51));
    expect(browser.tabOwner(51)).toBe(run.id);
    expect(getRunById(run.id)).toBe(run);
    expect(cleanup).not.toHaveBeenCalledWith(run.id);
    expect(browser.tabOwner(52)).toBe("other-run");

    removal.resolve();
    await task;
    expect(events).toHaveBeenCalledWith({ type: "done", stopped: true });
    expect(events.mock.calls.some(([event]) => event.type === "error")).toBe(false);
    expect(getRunById(run.id)).toBeNull();
    expect(browser.tabOwner(51)).toBeUndefined();
    expect(getRunById("other-run")).not.toBeNull();
    expect(browser.tabOwner(52)).toBe("other-run");
    expect(remove).toHaveBeenCalledExactlyOnceWith(51);
  });

  it("keeps ownership until external reads drain, without blocking another client", async () => {
    vi.spyOn(providers, "getProviderFor").mockResolvedValue(undefined);
    const cleanup = vi.spyOn(browser, "releaseBrowserOwner");
    const events = vi.fn();
    const first = startAgentRun({
      runId: "run-a",
      ownerId: "client-a",
      owner: "bridge",
      conversationId: "chat-a",
      task: "Read the local page",
      emit: events,
    });
    const read = deferred();
    const run = getRunById("run-a");
    expect(run).not.toBeNull();
    run!.pendingReads.add(read.promise);
    await vi.waitFor(() => expect(run!.readsClosed).toBe(true));
    expect(getRunById("run-a")).toBe(run);
    expect(cleanup).not.toHaveBeenCalledWith("run-a");

    await startAgentRun({
      runId: "run-b",
      ownerId: "client-b",
      owner: "bridge",
      conversationId: "chat-b",
      task: "Read another local page",
      emit: vi.fn(),
    });
    expect(cleanup).toHaveBeenCalledWith("run-b");
    expect(getRunById("run-a")).toBe(run);
    read.resolve();
    await first;
    expect(cleanup).toHaveBeenCalledWith("run-a");
    expect(getRunById("run-a")).toBeNull();
  });

  it("releases only its own claim when setup throws", async () => {
    const wait = deferred();
    vi.spyOn(providers, "getProviderFor").mockImplementation(async () => {
      await wait.promise;
      throw new Error("The configured provider was removed. Pick another provider and retry.");
    });
    const events = vi.fn();
    const first = startAgentRun({
      runId: "setup-a",
      ownerId: "client-a",
      owner: "bridge",
      conversationId: "chat-a",
      task: "Read the local page",
      emit: events,
    });
    const second = startAgentRun({
      runId: "setup-b",
      ownerId: "client-b",
      owner: "bridge",
      conversationId: "chat-b",
      task: "Read another local page",
      emit: vi.fn(),
    });
    const runA = getRunById("setup-a");
    const runB = getRunById("setup-b");
    expect(runA).not.toBeNull();
    expect(runB).not.toBeNull();
    runA!.controller.abort();
    expect(getRunById("setup-a")).toBe(runA);
    expect(getRunById("setup-b")).toBe(runB);
    wait.resolve();
    await Promise.all([first, second]);
    expect(events).toHaveBeenCalledWith({ type: "done", stopped: true });
    expect(listActiveRuns()).toEqual([]);
  });
});
