import type { ChatProvider, ResolvedProviderConfig } from "./types";
import { createOpenAIProvider } from "./openai";
import { createAnthropicProvider } from "./anthropic";
import { createResponsesProvider } from "./responses";
import { createGeminiProvider } from "./gemini";

/** Factory — picks adapter by shape. Adding a new shape = one case here. */
export function createProvider(config: ResolvedProviderConfig): ChatProvider {
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
