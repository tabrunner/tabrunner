import { createGate, type Gate } from "@providerkit/core";
import type { ChatProvider, Delta, ResolvedProviderConfig } from "./types";
import { createOpenAIProvider } from "./openai";
import { createAnthropicProvider } from "./anthropic";
import { createResponsesProvider } from "./responses";
import { createGeminiProvider } from "./gemini";

const MAX_CONCURRENT_PER_PROVIDER = 4;

/**
 * One gate per provider connection, shared across every `createProvider` build
 * (the main run, auto-titler, memory extraction, compaction and skill
 * distillation) so concurrent background calls queue instead of hitting 429s.
 */
const gates = new Map<string, Gate>();

function gateFor(config: ResolvedProviderConfig): Gate {
  const key = `${config.id}:${config.baseUrl}`;
  let gate = gates.get(key);
  if (!gate) {
    gate = createGate(MAX_CONCURRENT_PER_PROVIDER);
    gates.set(key, gate);
  }
  return gate;
}

function buildProvider(config: ResolvedProviderConfig): ChatProvider {
  switch (config.shape) {
    case "openai":
      return createOpenAIProvider(config);
    case "anthropic":
      return createAnthropicProvider(config);
    case "responses":
      return createResponsesProvider(config);
    case "gemini":
      return createGeminiProvider(config);
  }
}

/** Factory: picks adapter by shape and gates concurrent streams per provider. */
export function createProvider(config: ResolvedProviderConfig): ChatProvider {
  const inner = buildProvider(config);
  const gate = gateFor(config);
  return {
    stream(messages, tools, signal): AsyncIterable<Delta> {
      async function* gated(): AsyncGenerator<Delta> {
        const release = await gate.acquire(signal);
        try {
          signal.throwIfAborted();
          yield* inner.stream(messages, tools, signal);
        } finally {
          release();
        }
      }
      return gated();
    },
  };
}
