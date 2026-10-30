import { forgeOpenCodeSessionId, isZenFreeModel, OPENCODE_PUBLIC_API_KEY } from "@providerkit/core";
import type { ProviderConfig, ResolvedProviderConfig, ToolDef } from "./types";
import { PRESETS } from "./presets";

/**
 * OpenCode Zen's free shelf (`big-pickle` and every `-free` model) answers
 * `403 FreeTierError` unless the call looks like it came from OpenCode's own
 * client. Three things give it away, and each one missing on its own is enough
 * for the 403 (checked against the live endpoint, 2026-10-21):
 *
 * - the OpenCode `User-Agent`. fetch cannot set it in Chromium, so origin.ts
 *   stamps it on the request instead;
 * - a `ses_` session id, which is what `zenSessionHeaders` builds;
 * - a tool named `read` in the request, which `offerZenRead` adds.
 *
 * The credential still rides along: a keyed or signed-in call uses the
 * account's own free quota.
 */

/**
 * The headers OpenCode's client sends on every call: the session under the four
 * names its backends read, and who is asking. The id is the conversation's, run
 * through core's forge so it has the `ses_<12 hex><14 base62>` shape the gate
 * checks. The same conversation always forges the same id.
 */
export async function zenSessionHeaders(sessionId: string): Promise<Record<string, string>> {
  const ses = await forgeOpenCodeSessionId(sessionId);
  return {
    "x-opencode-session": ses,
    "x-opencode-session-id": ses,
    "x-session-affinity": ses,
    "x-session-id": ses,
    "x-opencode-project": "global",
    "x-opencode-client": "cli",
  };
}

/** Zen uses its public credential when no account or key is connected. */
export function usesZenFreeAccess(
  config: Pick<ProviderConfig, "apiKey" | "auth"> & { id?: string },
): boolean {
  return (
    config.id === "opencode" &&
    !config.auth &&
    (!config.apiKey || config.apiKey === OPENCODE_PUBLIC_API_KEY)
  );
}

const READ_DECOY: ToolDef = {
  name: "read",
  description: "Not available in this conversation. Never call it.",
  params: { type: "object", properties: {} },
};

/**
 * The tools to send, with the `read` the free tier looks for. TabRunner has no
 * tool by that name, so a decoy goes along, described so the model leaves it
 * alone. Paid models and other providers get their tools untouched.
 *
 * ponytail: a call with no tools of its own (the titler, compaction) carries
 * the decoy without `tool_choice: "none"`, so a model could in principle call
 * it. The adapters have no tool-choice input yet; none of those callers act on a
 * tool call, so a stray one is dropped.
 */
export function offerZenRead(
  config: Pick<ResolvedProviderConfig, "id" | "model">,
  tools: ToolDef[],
): ToolDef[] {
  const free = PRESETS.some((p) => p.id === config.id && p.free);
  if (!free || !isZenFreeModel(config.model) || tools.some((t) => t.name === READ_DECOY.name)) {
    return tools;
  }
  return [...tools, READ_DECOY];
}
