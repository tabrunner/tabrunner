import { describe, it, expect } from "vitest";
import { useProvidersStore } from "../ui/store";
import { getActiveProviderId } from "../index";
import type { ProviderConfig } from "../types";

// The store's add writes through the setup file's in-memory storage mock
// (test-setup.ts); assert the persisted active id — that's what the background
// reads at run start. Store state itself syncs via watchers, which the harness
// can't fire.

const provider = (id: string): Omit<ProviderConfig, "id" | "createdAt"> & { id: string } => ({
  id,
  name: id,
  shape: "openai",
  baseUrl: `https://${id}.example/v1`,
  apiKey: "sk-test",
});

describe("providers store add", () => {
  it("activates the provider it just saved — the first one, and every one after", async () => {
    const state = useProvidersStore.getState();

    await state.add(provider("openai"));
    expect(await getActiveProviderId()).toBe("openai");

    // Adding another provider switches to it; the previous one is no longer active.
    await state.add(provider("anthropic"));
    expect(await getActiveProviderId()).toBe("anthropic");
  });
});
