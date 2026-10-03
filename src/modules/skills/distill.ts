import type { Message } from "@/modules/conversation/types";
import { capTranscriptTail, renderTranscriptMessage } from "@/modules/conversation";
import type { ResolvedProviderConfig } from "@/modules/providers/types";
import { createProvider } from "@/modules/providers";
import { i18n } from "@/i18n";
import { parseSkillMd, type ParsedSkillMd } from "./skill-md";
import { MAX_CATALOG_DESC_CHARS } from "./types";

/**
 * Conversation → skill draft. The fourth transcript distillation next to
 * memory extraction, auto-titling and compaction, and shaped like them — one
 * text-only call on a fresh provider — with one deliberate difference: this
 * one THROWS. The other three are fire-and-forget housekeeping; this is a
 * user's explicit `/skill new`, and a failure owes them a message and a Retry,
 * not a silent shrug.
 */

/** The draft call must not outlive the panel's patience — same bound as extraction. */
const DISTILL_TIMEOUT_MS = 90_000;

const SKILL_DISTILL_SYSTEM = `Below is the transcript of a browser-automation conversation. Turn its reusable procedure into a skill, instructions a future agent run can follow to do this kind of task again without repeating this run's investigation.

Reply with a complete SKILL.md file and nothing else, in exactly this shape:

---
name: <kebab-case-name>
description: <one sentence, under ${MAX_CATALOG_DESC_CHARS} characters, saying what the skill does and when to use it>
sites: [<domain the steps happen on>]
---

<the instructions: concrete numbered steps naming the exact pages, links, buttons and fields the transcript used, including any quirk it hit and what fixed it>

Rules:
- The user's own messages are the steering signal. Pay special attention to every place the user corrected the agent. The correction is the lesson the skill exists to keep.
- Omit the sites line entirely when the steps are not tied to a specific site.
- Leave out one-off values, such as this run's dates, amounts, names and search terms. The next task supplies its own; the skill carries the how, not the what.
- Never include secrets, credentials, or personal data values.
- Keep simple skills simple: a task that took three steps gets three steps.
- Write the instruction body in the language the user wrote in.`;

/** The rendered transcript the call sees, tail-capped like compaction's. Exported for tests. */
export function buildSkillDistillBody(transcript: Message[]): string {
  return capTranscriptTail(transcript.map(renderTranscriptMessage).filter(Boolean).join("\n\n"));
}

/** Models fence markdown replies no matter what the prompt says — unwrap before parsing. */
export function parseSkillReply(reply: string): ParsedSkillMd {
  const fenced = /^```[a-z]*\r?\n([\s\S]*?)\r?\n?```\s*$/i.exec(reply.trim());
  return parseSkillMd(fenced?.[1] ?? reply.trim());
}

export async function distillSkillDraft(
  config: ResolvedProviderConfig,
  transcript: Message[],
  signal: AbortSignal,
): Promise<ParsedSkillMd> {
  const body = buildSkillDistillBody(transcript);
  if (!body.trim()) throw new Error(i18n.t("skills.draft.errorNothing"));

  // The draft turn needs no thinking tokens and sees no images.
  const provider = createProvider({ ...config, reasoningEffort: undefined, supportsImages: false });
  const timeout = AbortSignal.timeout(DISTILL_TIMEOUT_MS);
  const bounded = AbortSignal.any([signal, timeout]);

  let reply = "";
  try {
    for await (const delta of provider.stream(
      [
        { role: "system", content: SKILL_DISTILL_SYSTEM },
        { role: "user", content: body },
      ],
      [],
      bounded,
    )) {
      if (delta.type === "text") reply += delta.text;
    }
  } catch (e) {
    // A timeout of ours gets a readable message; the user's own close/cancel
    // and real provider errors pass through for the dialog to classify.
    if (timeout.aborted && !signal.aborted)
      throw new Error(i18n.t("skills.draft.errorTimeout"), { cause: e });
    throw e;
  }
  if (!reply.trim()) throw new Error(i18n.t("skills.draft.errorEmpty"));
  return parseSkillReply(reply);
}
