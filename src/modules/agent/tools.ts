import type { BrowserDriver } from "@/modules/browser";
import type { ToolCall } from "@/modules/providers/types";
import type { Skill } from "@/modules/skills";
import { handleSaveSkill } from "@/modules/skills/save-skill-tool";
import type { RunRecorder } from "@/modules/walkthrough/recorder";
import { normalizeMcpResult } from "@/modules/mcp";
import { MCP_TOOL_PREFIX } from "@/modules/mcp";
import type { McpHandle } from "@/modules/mcp";
import { remember } from "@/modules/memory";
import { cancelSchedule, scheduleTask } from "@/modules/schedule/agent-tools";
import { i18n } from "@/i18n";
import { scopeHostOf } from "@/lib/host";
import { truncate } from "@/lib/logger";
import { readStepLog } from "./read-history";
import type { RunOwner } from "./active-runs";

/** Longer than this and the plan card stops being scannable in a side panel. */
const MAX_PLAN_STEPS = 20;
/** Result payloads are a drill-down, never a whole page inlined into the row. */
const MAX_DETAIL = 2000;

export interface ToolResult {
  ok: boolean;
  data?: unknown;
  error?: string;
  /** Images the tool produced, as `data:` URLs — fed to the model as image blocks. */
  images?: string[];
}

/**
 * The run's tab strip, created lazily: it appears when the run lands its first
 * action on a page — not when the message was sent, since the user may just be
 * passing through the tab they sent from. All best-effort: the strip is the
 * ambient signal, never something a run fails over.
 */
export interface RunGroup {
  /** The labeled group — undefined until the first action or group_tab mints it. */
  readonly groupId: number | undefined;
  /** File the currently-driven tab after a successful action. */
  touch(): Promise<void>;
  /** group_tab's target: the run's group, minted around this tab when the run has
   *  none — never around a tab already grouped elsewhere (not ours to rip). */
  file(tabId: number): Promise<number | undefined>;
}

export interface ToolContext {
  /** The run's conversation — read_history reads its stored transcript. Absent under direct control, which has none. */
  conversationId?: string;
  /** The run's tab strip — group_tab's target. Absent under direct control, which has none. */
  runGroup?: RunGroup;
  /** Which client started the run — bounds what `schedule_task` may write. */
  owner?: RunOwner;
  /** The schedule this run fired from — the only record it may re-time. */
  scheduleId?: string;
  /** Enabled skills snapshotted at run start — the skill tool's lookup table.
   *  Absent under direct control, which loads none. */
  skills?: Skill[];
  /** This run's walkthrough recorder — the `document` tool's target. Absent when
   *  walkthroughs are off, or under direct control, which has no run to document. */
  recorder?: RunRecorder;
  /** This run's MCP handle — resolves `mcp__` names to live sessions. Absent
   *  when no server is enabled, or under direct control, which offers none. */
  mcp?: McpHandle;
  /** The run's abort signal — remote calls honor it, so Stop lands promptly
   *  even mid-call instead of after the transport's own timeout. */
  signal?: AbortSignal;
}

/** Execute a single tool call against the browser driver. */
export async function executeTool(
  call: ToolCall,
  driver: BrowserDriver,
  ctx: ToolContext = {},
): Promise<ToolResult> {
  try {
    switch (call.name) {
      case "navigate":
        await driver.navigate(call.args.url as string);
        return { ok: true, data: { url: call.args.url } };

      case "list_tabs": {
        const tabs = await driver.listTabs();
        return { ok: true, data: { tabs } };
      }

      case "switch_tab": {
        const tab = await driver.switchTab(call.args.tab_id as number);
        return { ok: true, data: tab };
      }

      case "group_tab": {
        if (!ctx.runGroup) return { ok: false, error: i18n.t("errors.noRunGroup") };
        // When the strip exists, the driver's window check gives the model a
        // clear error — joining across windows would otherwise silently mint a
        // second strip over there.
        const groupId =
          ctx.runGroup.groupId ?? (await ctx.runGroup.file(call.args.tab_id as number));
        if (groupId === undefined) return { ok: false, error: i18n.t("errors.noRunGroup") };
        const tab = await driver.groupTab(call.args.tab_id as number, groupId);
        return { ok: true, data: tab };
      }

      case "snapshot": {
        const result = await driver.snapshot();
        return { ok: true, data: result };
      }

      case "read_page_text":
        return {
          ok: true,
          data: await driver.readPageText(
            call.args.from as number | undefined,
            call.args.limit as number | undefined,
          ),
        };

      case "find": {
        const query = String(call.args.query ?? "").trim();
        // An empty query matches every line — the whole snapshot, billed as a
        // search. Bounce it rather than answer it.
        if (!query) return { ok: false, error: i18n.t("errors.findEmpty") };
        return { ok: true, data: await driver.find(query, call.args.limit as number | undefined) };
      }

      case "go_back":
        await driver.goBack();
        return { ok: true };

      case "open_tab": {
        const tab = await driver.openTab(call.args.url as string);
        return { ok: true, data: tab };
      }

      case "close_tab": {
        const tab = await driver.closeTab(call.args.tab_id as number);
        return { ok: true, data: tab };
      }

      case "click": {
        const { x, y } = await driver.click(call.args.ref as string);
        return { ok: true, data: { x, y } };
      }

      case "type":
        await driver.type(call.args.text as string);
        return { ok: true };

      case "fill":
        await driver.fill(call.args.ref as string, call.args.text as string);
        return { ok: true };

      case "evaluate": {
        const value = await driver.evaluate(call.args.expression as string);
        return { ok: true, data: { result: value ?? null } };
      }

      case "read_network_requests":
        return {
          ok: true,
          data: await driver.readNetworkRequests(
            call.args.url_filter as string | undefined,
            call.args.limit as number | undefined,
          ),
        };

      case "read_console_messages":
        return {
          ok: true,
          data: await driver.readConsoleMessages(
            call.args.only_errors as boolean | undefined,
            call.args.limit as number | undefined,
          ),
        };

      case "press_key":
        // Coerced once, here: a model that sends a bare string for `modifiers`
        // would otherwise have it iterated character by character downstream.
        await driver.key(
          call.args.key as string,
          Array.isArray(call.args.modifiers)
            ? call.args.modifiers.filter((m): m is string => typeof m === "string")
            : undefined,
        );
        return { ok: true };

      case "scroll_down":
        await driver.scrollDown(call.args.amount as number | undefined);
        return { ok: true };

      case "scroll_up":
        await driver.scrollUp(call.args.amount as number | undefined);
        return { ok: true };

      case "screenshot": {
        const image = await driver.screenshot();
        // The text half tells a text-only model what happened; the image half is
        // what a vision model actually reads. Both are needed — a provider that
        // silently drops images still gets a coherent transcript.
        return { ok: true, data: { captured: true }, images: [image] };
      }

      case "document": {
        if (!ctx.recorder) return { ok: false, error: i18n.t("errors.documentUnavailable") };
        const title = typeof call.args.title === "string" ? call.args.title : undefined;
        // Idempotent: a model that calls it twice gets the same yes, not an
        // error — re-arming mid-run would restart the numbering under the user.
        const already = ctx.recorder.armed;
        await ctx.recorder.arm(title);
        return { ok: true, data: { documenting: true, resumed: already } };
      }

      case "plan": {
        // ponytail: a flat list plus a cursor, not per-step statuses — weaker
        // models get nested enums wrong far more often than they get an index
        // wrong. The ceiling is that no step can be marked skipped or failed.
        const steps = (Array.isArray(call.args.steps) ? call.args.steps : [])
          .filter((s): s is string => typeof s === "string" && s.trim() !== "")
          .slice(0, MAX_PLAN_STEPS);
        if (steps.length === 0) return { ok: false, error: i18n.t("errors.planEmpty") };
        // Models routinely send a 1-based or already-past-the-end index; clamping
        // beats rejecting, since the plan is a display aid and never control flow.
        const raw = Number(call.args.current);
        const current = Number.isFinite(raw)
          ? Math.min(Math.max(0, Math.trunc(raw)), steps.length)
          : 0;
        return { ok: true, data: { steps, current } };
      }

      case "remember": {
        // Reachable only when memory is on — buildToolDefs withholds the tool
        // otherwise, so there is no second enabled check to drift out of sync.
        const rawSite = typeof call.args.site === "string" ? call.args.site : undefined;
        const stored = await remember(String(call.args.fact ?? ""), rawSite);
        if (!stored) return { ok: false, error: i18n.t("errors.memoryEmpty") };
        return {
          ok: true,
          data: { fact: stored.text, ...(stored.site ? { site: stored.site } : {}) },
        };
      }

      case "skill": {
        // Reachable only when enabled skills exist — buildToolDefs withholds the
        // tool otherwise, so there is no second check to drift out of sync.
        const name = String(call.args.name ?? "")
          .trim()
          .toLowerCase();
        const found = ctx.skills?.find((s) => s.name === name);
        if (!found) {
          return {
            ok: false,
            error: i18n.t("errors.skillNotFound", {
              name,
              list: (ctx.skills ?? []).map((s) => s.name).join(", "),
            }),
          };
        }
        return { ok: true, data: { name: found.name, instructions: found.body } };
      }

      case "save_skill": {
        // Consent lives in the prompt's ask-first rule, not here: the case is
        // deliberately dumb plumbing over the SAME pipeline UI import uses
        // (resolve → fetch → parse → saveSkill), so nothing about a model save
        // bypasses what a human one passes through.
        const outcome = await handleSaveSkill(call.args);
        if (!outcome.ok) return { ok: false, error: outcome.error };
        return { ok: true, data: { saved: outcome.saved.name, summary: outcome.saved.description } };
      }

      case "schedule_task":
        // Gated on an approved plan (see GATED_TOOLS): committing the browser to
        // unattended future work needs the same yes an action on the page does.
        return scheduleTask(call.args, {
          ...(ctx.owner ? { owner: ctx.owner } : {}),
          ...(ctx.scheduleId ? { scheduleId: ctx.scheduleId } : {}),
          ...(ctx.conversationId ? { conversationId: ctx.conversationId } : {}),
        });

      case "cancel_schedule":
        return cancelSchedule(call.args);

      case "ask_user":
        // No driver interaction — the loop ends the run on this call and the
        // panel renders the question; the answer arrives as the next message.
        return { ok: true, data: { question: call.args.question, choices: call.args.choices } };

      case "read_history":
        // Direct control drives tools without a conversation — nothing to read.
        if (!ctx.conversationId) return { ok: false, error: i18n.t("errors.historyUnavailable") };
        return readStepLog(ctx.conversationId, call.args);

      case "done":
        return { ok: true, data: { summary: call.args.summary } };

      default: {
        // Remote tools resolve by exposed name — the ref map, never name-
        // parsing, is what ties a call back to its server and wire name.
        const hit = call.name.startsWith(MCP_TOOL_PREFIX) ? ctx.mcp?.resolve(call.name) : undefined;
        if (!hit) return { ok: false, error: i18n.t("errors.unknownTool", { name: call.name }) };
        const remote = await hit.session.callTool(hit.ref.toolName, call.args, ctx.signal);
        return normalizeMcpResult(remote);
      }
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, error: message };
  }
}

/**
 * The host a page-moving tool landed on, read out of its own result data.
 * navigate reports the requested URL, open_tab and switch_tab return tab info
 * carrying the real one — the three movers mid-run skill activation follows.
 * ponytail: go_back carries no URL, evaluate-driven navigation reports
 * nothing — neither triggers discovery; the upgrade path is a post-action
 * tab probe here.
 */
export function landedHost(call: ToolCall, result: ToolResult): string | null {
  if (!result.ok) return null;
  if (call.name !== "navigate" && call.name !== "open_tab" && call.name !== "switch_tab") {
    return null;
  }
  const url = (result.data as { url?: string } | undefined)?.url;
  return scopeHostOf(url);
}

/** Result payload for the panel's expandable row — bounded, never a whole page. */
export function formatDetail(
  tool: string,
  result: ToolResult,
  args?: Record<string, unknown>,
): string | undefined {
  if (!result.ok) return result.error;
  if (tool === "evaluate") {
    // The code IS the action: the drawer audits what ran first, what came back second.
    const code = typeof args?.expression === "string" ? args.expression.trim() : "";
    const json = result.data === undefined ? "" : JSON.stringify(result.data, null, 2);
    const body = json && json !== "{}" ? json : "";
    const detail = [code, body].filter(Boolean).join("\n\n");
    return detail ? truncate(detail, MAX_DETAIL) : undefined;
  }
  if (tool === "snapshot") {
    const snapshot = result.data as { pageContent?: string } | undefined;
    return snapshot?.pageContent ? truncate(snapshot.pageContent, MAX_DETAIL) : undefined;
  }
  if (tool === "read_page_text") {
    // The prose IS the action's result — show it, not the JSON envelope.
    const page = result.data as { text?: string } | undefined;
    return page?.text ? truncate(page.text, MAX_DETAIL) : undefined;
  }
  if (tool === "find") {
    const found = result.data as { matches?: string[]; total?: number } | undefined;
    return found?.matches?.length ? truncate(found.matches.join("\n"), MAX_DETAIL) : undefined;
  }
  if (tool === "read_history") {
    // The log is already formatted text — showing it as escaped JSON would be unreadable.
    const window = result.data as { log?: string } | undefined;
    return window?.log ? truncate(window.log, MAX_DETAIL) : undefined;
  }
  if (tool === "skill") {
    // The instructions ARE the result — markdown, not an escaped JSON envelope.
    const skill = result.data as { instructions?: string } | undefined;
    return skill?.instructions ? truncate(skill.instructions, MAX_DETAIL) : undefined;
  }
  if (result.data === undefined) return undefined;
  const json = JSON.stringify(result.data, null, 2);
  return json && json !== "{}" ? truncate(json, MAX_DETAIL) : undefined;
}

/** Host without the www — the one-line trace of where the browser went. */
function summaryHost(url: string | undefined): string {
  if (!url) return "";
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    // Not a parseable URL — the raw value is the best trace there is.
    return url;
  }
}

export function formatSuccessSummary(tool: string, data: unknown): string {
  if (tool === "snapshot" && data && typeof data === "object") {
    const snap = data as { pageContent?: string };
    const lines = snap.pageContent?.split("\n").length ?? 0;
    return i18n.t("errors.capturedElements", { count: lines });
  }
  // Click/fill/evaluate carry an intent the row already shows, so their summary
  // is a bare confirmation — the coordinates a click returns are for the driver,
  // not the transcript.
  if (tool === "click") {
    return i18n.t("errors.clicked");
  }
  if (tool === "press_key") {
    return i18n.t("errors.keyPressed");
  }
  if (tool === "fill") {
    return i18n.t("errors.fieldFilled");
  }
  if (tool === "evaluate") {
    return i18n.t("errors.evaluated");
  }
  if (tool === "read_network_requests" && data && typeof data === "object") {
    return i18n.t("errors.requestsRead", {
      count: (data as { total?: number }).total ?? 0,
    });
  }
  if (tool === "read_console_messages" && data && typeof data === "object") {
    return i18n.t("errors.messagesRead", {
      count: (data as { total?: number }).total ?? 0,
    });
  }
  if (tool === "navigate") {
    const { url } = (data ?? {}) as { url?: string };
    const where = summaryHost(url);
    return where ? i18n.t("errors.navigatedTo", { host: where }) : i18n.t("errors.navigatedBare");
  }
  if (tool === "read_page_text") {
    const page = data as { text?: string; total?: number } | undefined;
    const chars = page?.text?.length ?? 0;
    const total = page?.total ?? chars;
    return chars >= total
      ? i18n.t("errors.pageTextRead", { count: chars })
      : i18n.t("errors.pageTextReadPartial", { count: chars, total });
  }
  if (tool === "find") {
    const found = data as { matches?: string[]; total?: number } | undefined;
    const shown = found?.matches?.length ?? 0;
    const total = found?.total ?? 0;
    return shown < total
      ? i18n.t("errors.foundPartial", { count: shown, total })
      : i18n.t("errors.found", { count: total });
  }
  if (tool === "go_back") return i18n.t("errors.wentBack");
  if (tool === "open_tab") {
    const { url } = (data ?? {}) as { url?: string };
    const where = summaryHost(url);
    return where ? i18n.t("errors.openedTabAt", { host: where }) : i18n.t("errors.openedTab");
  }
  if (tool === "close_tab") {
    const { title } = (data ?? {}) as { title?: string };
    return title
      ? i18n.t("errors.closedTabNamed", { title: truncate(title, 60) })
      : i18n.t("errors.closedTab");
  }
  if (tool === "switch_tab" && data && typeof data === "object") {
    return i18n.t("errors.switchedTo", { title: (data as { title?: string }).title ?? "" });
  }
  if (tool === "group_tab" && data && typeof data === "object") {
    return i18n.t("errors.tabGrouped", { title: (data as { title?: string }).title ?? "" });
  }
  if (tool === "list_tabs" && data && typeof data === "object") {
    const tabs = (data as { tabs?: unknown[] }).tabs;
    return i18n.t("errors.tabsListed", { count: Array.isArray(tabs) ? tabs.length : 0 });
  }
  if (tool === "screenshot") {
    return i18n.t("errors.screenshotCaptured");
  }
  if (tool === "document") {
    return i18n.t("walkthrough.step.armed");
  }
  if (tool === "read_history" && data && typeof data === "object") {
    const window = data as { from: number; to: number };
    return i18n.t("errors.historyRead", { count: window.to - window.from });
  }
  if (tool === "skill" && data && typeof data === "object") {
    return i18n.t("errors.skillLoaded", { name: (data as { name?: string }).name ?? "" });
  }
  if (tool === "save_skill") {
    return i18n.t("errors.skillSaved", { name: (data as { saved?: string }).saved ?? "" });
  }
  if (tool === "remember" && data && typeof data === "object") {
    // The fact itself is the summary — "Saved to memory" tells the user nothing
    // about what TabRunner now knows, which is the only interesting part. The
    // bracket tag names the site it is scoped to, language-neutrally.
    const { fact, site } = data as { fact: string; site?: string };
    return site ? `[${site}] ${fact}` : fact;
  }
  if (tool === "ask_user" && data && typeof data === "object") {
    // The question is the summary — the card renders it as the headline.
    return (data as { question?: string }).question ?? "";
  }
  if (tool === "schedule_task" && data && typeof data === "object") {
    // The cadence and the next fire ARE the news — "scheduled a task" would
    // leave the user checking Settings to find out what they just agreed to.
    const s = data as { recurrence?: string; next_run?: string };
    return i18n.t("schedule.step.scheduled", {
      recurrence: s.recurrence ?? "",
      next: s.next_run ?? "",
    });
  }
  if (tool === "cancel_schedule" && data && typeof data === "object") {
    const s = data as { task?: string };
    return s.task
      ? i18n.t("schedule.step.cancelled", { task: truncate(s.task, 60) })
      : i18n.t("schedule.step.cancelledBare");
  }
  return i18n.t("errors.toolCompleted", { tool });
}
