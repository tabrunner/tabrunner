import type { ErrorKind } from "@providerkit/core";
import type { ArtifactPayload } from "@/shared/protocol";

export type MessageRole =
  | "user"
  | "assistant"
  | "reasoning"
  | "step"
  | "error"
  | "plan"
  | "summary"
  /** A finished walkthrough — the deliverable of a documented run, not chatter. */
  | "artifact";

export interface Message {
  id: string;
  role: MessageRole;
  content: string;
  /**
   * For error messages: the classified provider failure. The message already
   * leads with its own actionable line, so the bubble skips the generic hint.
   */
  kind?: ErrorKind;
  /**
   * For error messages: nothing anticipated this one — a raw exception, or a
   * provider failure the classifier couldn't read. Every other error in the
   * catalog was authored with its own cause and fix; these have neither, so
   * this is the flag that offers a bug report as the way forward.
   */
  unexpected?: boolean;
  /** For step messages: which tool ran */
  tool?: string;
  /** For step messages: the arguments the model passed — drives the row's hint and drill-down */
  args?: Record<string, unknown>;
  /** For step messages: the tool's result payload, truncated. Expandable, never inline. */
  detail?: string;
  /** For step messages: whether the tool call succeeded (absent = neutral note) */
  ok?: boolean;
  /** For step messages: the tool is executing right now (live rows are never persisted) */
  live?: boolean;
  /**
   * Kept in the transcript for the model, never drawn in the chat — the
   * deterministic progress note an interrupted run leaves behind is written
   * for the next run's replayed history, not for the user (who watched the
   * steps happen and gets the "Stopped" line instead).
   */
  internal?: boolean;
  /**
   * Data-URL images. On a user message these are the attachments they sent and
   * they persist; on a screenshot step they are stripped before storage —
   * see `stripTransient` in conversations.ts for why.
   */
  images?: string[];
  /**
   * For user messages: the tab they were sent from — a message is anchored to
   * the page it meant, and a conversation can span several tabs. Only the
   * message that starts a run is stamped; mid-run injections belong to the
   * run's own tab and carry none.
   */
  tab?: { title: string; url: string; favIconUrl?: string };
  /** For plan messages: the checklist, rewritten in place on every update */
  steps?: string[];
  /** For plan messages: 0-based index of the step in progress */
  current?: number;
  /** For reasoning messages: how long the model thought, in ms */
  elapsed?: number;
  /**
   * For artifact messages: the walkthrough this run produced. Only the handle
   * lives here — the frames are blobs in IndexedDB, so a transcript stays a
   * transcript no matter how many megabytes the recording ran to.
   */
  artifact?: ArtifactPayload;
  /**
   * For summary messages: what this compaction stands in for. The messages
   * above it stay in storage and stay scrollable — only the model's replay
   * starts here. The counts are the receipt the fold shows ("42 messages ·
   * 18k → 2k"), so a compaction is never something that just silently happened.
   */
  compacted?: { messages: number; before: number; after: number };
  timestamp: number;
}

export type AgentStatus = "idle" | "running" | "error";
