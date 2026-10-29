import { defineItem } from "@/lib/storage";
import { engineProvider } from "./engine";
import type { ConversationEngine, ProviderConfig } from "./types";

const providersItem = defineItem<ProviderConfig[]>("providers", []);
const activeIdItem = defineItem<string | null>("active-provider", null);

export async function getProviders(): Promise<ProviderConfig[]> {
  return (await providersItem.get()).map(migrateProviderRow);
}

export async function getProvider(id: string): Promise<ProviderConfig | undefined> {
  const list = await providersItem.get();
  const found = list.find((p) => p.id === id);
  return found ? migrateProviderRow(found) : undefined;
}

/**
 * Forward-only row migrations, applied on read — stored rows converge the
 * next time anything saves them. One rule right now: Gemini moved from the
 * OpenAI-compatible shim to the native endpoint (thought signatures only
 * survive there), so a stored shim row is re-pointed instead of left
 * spinning on textless turns. Custom rows are never touched — only the
 * preset's own id plus its old base trigger this.
 */
function migrateProviderRow(p: ProviderConfig): ProviderConfig {
  if (p.id === "gemini" && p.baseUrl.endsWith("/v1beta/openai")) {
    return { ...p, shape: "gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta" };
  }
  return p;
}

export async function saveProvider(provider: ProviderConfig): Promise<void> {
  const list = await providersItem.get();
  const idx = list.findIndex((p) => p.id === provider.id);
  if (idx >= 0) {
    list[idx] = provider;
  } else {
    list.push(provider);
  }
  await providersItem.set(list);
}

export async function removeProvider(id: string): Promise<void> {
  const list = await providersItem.get();
  const remaining = list.filter((p) => p.id !== id);
  await providersItem.set(remaining);
  // Never leave activeId dangling — fall back to the next provider, or none.
  if ((await activeIdItem.get()) === id) {
    await activeIdItem.set(remaining[0]?.id ?? null);
  }
}

export async function getActiveProviderId(): Promise<string | null> {
  return activeIdItem.get();
}

export async function getActiveProvider(): Promise<ProviderConfig | undefined> {
  const id = await activeIdItem.get();
  if (!id) return undefined;
  return getProvider(id);
}

/**
 * The provider a conversation runs on — its pin, else the stored pick. The one
 * resolution every run goes through; see `engine.ts` for the rule itself.
 */
export async function getProviderFor(
  pin: ConversationEngine | undefined,
): Promise<ProviderConfig | undefined> {
  const [providers, activeId] = await Promise.all([getProviders(), activeIdItem.get()]);
  return engineProvider(providers, activeId, pin);
}

export async function setActiveProvider(id: string): Promise<void> {
  await activeIdItem.set(id);
}

export function watchProviders(cb: (providers: ProviderConfig[]) => void) {
  return providersItem.watch(cb);
}

export function watchActiveProvider(cb: (id: string | null) => void) {
  return activeIdItem.watch(cb);
}
