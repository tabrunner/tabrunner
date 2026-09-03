import { i18n } from "@/i18n";
import { listMcpServers, mcpStatusItem } from "@/modules/mcp/store";
import { knownModels, pickLatestModel } from "@/modules/providers/models";
import { providerDisplayName } from "@/modules/providers/presets";
import { formatResetRelative } from "@/modules/providers/rate-limit";
import { EFFORT_LABEL_KEYS, isEffort, REASONING_EFFORTS } from "@/modules/providers/types";
import type { ConversationEngine } from "@/modules/providers/types";
import { fetchProviderUsage, supportsUsage } from "@/modules/providers/usage";
import type { UsageWindow } from "@/modules/providers/usage";
import { useProvidersStore } from "@/modules/providers/ui";
import type { Skill } from "@/modules/skills";
import { SLASH_COMMAND_NAMES } from "@/modules/conversation/command-names";
import { loadedSkills, openSkillDraft, openSkillsManage } from "@/modules/skills/ui";
import { truncateTo } from "@/lib/format";
import { openHelp } from "./help-open";
import { runsHere, useConversationStore } from "./store";
import { engineNow } from "./hooks";

/**
 * Slash commands — /stop, /background, /effort, /model, /provider, /new, /help.
 * A draft whose first character is "/" (and that stays on one line) is a
 * command, not a task: it runs LOCALLY against the panel's stores and is never
 * sent to the model, never written to the transcript (the transcript is the
 * model's memory — a settings echo would pose as a turn). Each result lands as
 * a display-only note row (a tool-less step message), gone on panel reopen —
 * /help excepted: its reference sheet (HelpDialog) is no use as a line that
 * scrolls away.
 *
 * A command is chrome, not conversation, so it never joins the run queue —
 * queueing /help behind a three-minute run helps nobody, and /model is exactly
 * what you reach for WHILE watching a run go wrong. What a command touches
 * decides its class, and there are three:
 *
 * - **Panel-local** (/help, /new, /rename, /usage) and **settings the next run
 *   snapshots** (/model, /effort, /provider, /background — these say so, via
 *   nextTaskSuffix): fire immediately, always.
 * - **Acts on the live run** (/stop): fires immediately — that is the point.
 * - **Costs a model call or writes the transcript** (/compact, and any command
 *   added later that produces a task): `deferWhileBusy`. It parks until the
 *   conversation is quiet instead of dead-ending on "try again later".
 *
 * A bare picker command (/effort, /model, /provider, /background) opens its
 * candidates in the menu with the current value checked and pre-highlighted —
 * arrows + Enter pick, like the header selects. The escape hatch for a task
 * that must start with "/": any newline, or a space right after the slash,
 * makes it prose again.
 */

export interface SlashCandidate {
  /** What the command receives when this candidate wins. */
  value: string;
  /** What the menu shows; matching tries it too, so a localized label completes. */
  label: string;
  /** A quiet second column (e.g. the model "auto" actually resolves to). */
  secondary?: string;
}

type CommandDescriptionKey =
  | "commands.stop.description"
  | "commands.background.description"
  | "commands.effort.description"
  | "commands.model.description"
  | "commands.provider.description"
  | "commands.rename.description"
  | "commands.usage.description"
  | "commands.mcp.description"
  | "commands.document.description"
  | "commands.skill.description"
  | "commands.compact.description"
  | "commands.new.description"
  | "commands.skills.description"
  | "commands.help.description";

export interface SlashCommand {
  name: string;
  /** Built-ins describe themselves through i18n — a closed union, so a missing
   *  key is a compile error. Skill-derived commands carry the user's own
   *  description instead (user content is never translated). */
  descriptionKey?: CommandDescriptionKey;
  description?: string;
  /** Takes an optional argument — running it bare reports the current value. */
  takesArg?: boolean;
  /** A closed arg set (effort levels, configured providers) — powers the picker menu. */
  candidates?: () => SlashCandidate[];
  /** The candidate value in effect right now — the menu checks it and lands
   *  the highlight on it, so Enter on an untouched picker is a harmless no-op. */
  current?: () => string | undefined;
  /** Needs a quiet conversation: it costs a model call, or writes the transcript
   *  a live run is still writing. `runSlash` parks it instead of firing it. */
  deferWhileBusy?: boolean;
  /** `thisChatOnly` is the ⌥ gesture the engine picker carries — the same
   *  modifier means the same thing at both ends of the same choice. */
  run: (arg: string | undefined, thisChatOnly?: boolean) => void;
}

export interface ParsedSlash {
  /** Name fragment being typed (lowercased) — the menu's filter. */
  fragment: string;
  /** Set only on an exact command-name match. */
  command?: SlashCommand;
  /** Text after "/name ", trimmed — undefined while the name is still being typed. */
  arg?: string;
}

export interface SlashItem {
  key: string;
  primary: string;
  secondary?: string;
  /** The value in effect — the menu checks it and lands the highlight on it. */
  current?: boolean;
}

/** What the menu shows for a draft: command matches while the name is being
 *  typed, the command's candidates once the name is exact. */
export type SlashMenuState =
  | { kind: "commands"; items: SlashItem[] }
  | { kind: "candidates"; command: SlashCommand; items: SlashItem[] };

/** The command's own say — a quiet line in the transcript, gone on reopen. */
function note(content: string): void {
  useConversationStore.getState().note(content);
}

/** What THIS conversation runs on — one shared rule, see `engineProvider`. */
function activeProvider() {
  return engineNow();
}

/** Point this conversation somewhere else — the picker's write, by keyboard. */
function setEngine(patch: Partial<ConversationEngine>, thisChatOnly: boolean): void {
  useConversationStore.getState().setEngine(patch, thisChatOnly);
}

/** Names the narrower scope, so ⌥ never applies silently. Pairs with
 *  nextTaskSuffix: one says WHEN it lands, this says WHERE. */
function scopeSuffix(thisChatOnly: boolean): string {
  return thisChatOnly ? ` ${i18n.t("commands.thisChatOnly")}` : "";
}

/** Settings edits land on the stored config that the next run snapshots — a
 *  bare "Model → X" while a run is live would read as if it applied mid-run. */
function nextTaskSuffix(): string {
  return runsHere(useConversationStore.getState()) ? ` ${i18n.t("commands.nextTask")}` : "";
}

/** The effort picker's full set, as typable tokens — never translated. */
const EFFORT_OPTIONS = ["default", ...REASONING_EFFORTS].join(", ");

/** One usage window as a line: "5-hour window: 42% used · resets in 1h 12m". */
function windowLine(label: string, window: UsageWindow): string {
  const used = i18n.t("usage.usedPercent", { percent: window.usedPercent });
  return window.resetsAtMs === undefined
    ? `${label}: ${used}`
    : `${label}: ${used} · ${i18n.t("usage.resets", { reset: formatResetRelative(window.resetsAtMs, Date.now()) })}`;
}

export const COMMANDS: readonly SlashCommand[] = [
  {
    name: "stop",
    descriptionKey: "commands.stop.description",
    // First in the list because it is the one command you type against the
    // clock — and the only one whose button can be unreachable: the composer's
    // ■ yields to ↑ Send the moment there is text, so a run you decide to kill
    // halfway through typing a steer has no mouse target until the line is
    // cleared. "/s" + Enter is that target.
    run: () => {
      const store = useConversationStore.getState();
      // Our own submission is still in line rather than working — dropping it
      // from the queue is what "stop" means while nothing of ours is running.
      if (store.queuedRun) {
        store.cancelQueuedRun();
        note(i18n.t("commands.stop.cancelledQueued"));
        return;
      }
      if (!runsHere(store)) {
        note(i18n.t(store.board.running ? "commands.stop.elsewhere" : "commands.stop.none"));
        return;
      }
      // No note — the run's own "Stopped" seam line is the acknowledgment, and
      // queued steers become the next task exactly as the ■ button does.
      store.stop();
    },
  },
  {
    name: "background",
    descriptionKey: "commands.background.description",
    takesArg: true,
    candidates: () => [
      { value: "off", label: i18n.t("run.foreground") },
      { value: "on", label: i18n.t("run.background") },
    ],
    current: () => (useConversationStore.getState().runMode === "background" ? "on" : "off"),
    run: (arg) => {
      const store = useConversationStore.getState();
      if (!arg) {
        note(
          i18n.t("commands.background.current", {
            mode: i18n.t(store.runMode === "foreground" ? "run.foreground" : "run.background"),
          }) + nextTaskSuffix(),
        );
        return;
      }
      if (arg !== "on" && arg !== "off") {
        note(i18n.t("commands.background.invalid", { value: arg }));
        return;
      }
      const next = arg === "on" ? "background" : "foreground";
      store.setRunMode(next);
      // The suffix is not decoration here: the flip applies to the next send,
      // so mid-run this would otherwise read as having just walked away from
      // the run the user is watching.
      note(
        i18n.t(
          next === "background"
            ? "commands.background.nowBackground"
            : "commands.background.nowForeground",
        ) + nextTaskSuffix(),
      );
    },
  },
  {
    name: "effort",
    descriptionKey: "commands.effort.description",
    takesArg: true,
    candidates: () => [
      { value: "default", label: i18n.t("modelPicker.effort.default") },
      ...REASONING_EFFORTS.map((value) => ({ value, label: i18n.t(EFFORT_LABEL_KEYS[value]) })),
    ],
    current: () => activeProvider()?.reasoningEffort ?? "default",
    run: (arg, thisChatOnly = false) => {
      const provider = activeProvider();
      // Unreachable — the panel onboards instead of showing a composer when
      // no provider exists — but a note-less crash is worse than a guard.
      if (!provider) return;
      const name = providerDisplayName(provider);
      if (!arg) {
        note(
          i18n.t("commands.effort.current", {
            effort: provider.reasoningEffort ?? "default",
            provider: name,
          }) + nextTaskSuffix(),
        );
        return;
      }
      const level = arg.toLowerCase();
      if (level !== "default" && !isEffort(level)) {
        note(i18n.t("commands.effort.invalid", { value: arg, options: EFFORT_OPTIONS }));
        return;
      }
      setEngine({ effort: level === "default" ? undefined : level }, thisChatOnly);
      note(
        i18n.t("commands.effort.set", { effort: level, provider: name }) +
          scopeSuffix(thisChatOnly) +
          nextTaskSuffix(),
      );
    },
  },
  {
    name: "model",
    descriptionKey: "commands.model.description",
    takesArg: true,
    // The same list the header picker shows — this session's live listing when
    // one landed, else the preset's — with "auto" naming what it resolves to.
    candidates: () => {
      const provider = activeProvider();
      if (!provider) return [];
      const listed = knownModels(provider);
      const autoTarget = pickLatestModel(listed) ?? listed[0];
      return [
        {
          value: "auto",
          label: i18n.t("modelPicker.auto"),
          ...(autoTarget ? { secondary: autoTarget.name ?? autoTarget.id } : {}),
        },
        ...listed.map((m) => ({ value: m.id, label: m.name ?? m.id })),
      ];
    },
    current: () => activeProvider()?.model ?? "auto",
    run: (arg, thisChatOnly = false) => {
      const provider = activeProvider();
      if (!provider) return;
      const name = providerDisplayName(provider);
      if (!arg) {
        note(
          i18n.t("commands.model.current", {
            model: provider.model ?? i18n.t("modelPicker.auto"),
            provider: name,
          }) + nextTaskSuffix(),
        );
        return;
      }
      if (arg.toLowerCase() === "auto") {
        setEngine({ model: undefined }, thisChatOnly);
        note(
          i18n.t("commands.model.auto", { provider: name }) +
            scopeSuffix(thisChatOnly) +
            nextTaskSuffix(),
        );
        return;
      }
      // Any string goes — the header picker already keeps a pinned id the
      // endpoint stops listing, so the slash command is equally permissive.
      setEngine({ model: arg }, thisChatOnly);
      note(
        i18n.t("commands.model.set", { model: arg, provider: name }) +
          scopeSuffix(thisChatOnly) +
          nextTaskSuffix(),
      );
    },
  },
  {
    name: "provider",
    descriptionKey: "commands.provider.description",
    takesArg: true,
    candidates: () =>
      useProvidersStore
        .getState()
        .providers.map((p) => ({ value: p.id, label: providerDisplayName(p) })),
    current: () => activeProvider()?.id,
    run: (arg, thisChatOnly = false) => {
      const { providers } = useProvidersStore.getState();
      const current = activeProvider();
      if (!current) return;
      if (!arg) {
        const others = providers
          .filter((p) => p.id !== current.id)
          .map((p) => providerDisplayName(p));
        note(
          others.length > 0
            ? i18n.t("commands.provider.current", {
                name: providerDisplayName(current),
                others: new Intl.ListFormat(i18n.language, { type: "conjunction" }).format(others),
              })
            : i18n.t("commands.provider.currentOnly", { name: providerDisplayName(current) }),
        );
        return;
      }
      const q = arg.toLowerCase();
      const pick = uniquePick(providers, q, (p) => [
        p.id.toLowerCase(),
        providerDisplayName(p).toLowerCase(),
      ]);
      if (!pick) {
        note(
          i18n.t("commands.provider.unknown", {
            value: arg,
            list: providers.map((p) => providerDisplayName(p)).join(", "),
          }),
        );
        return;
      }
      setEngine({ providerId: pick.id }, thisChatOnly);
      note(
        i18n.t("commands.provider.set", { name: providerDisplayName(pick) }) +
          scopeSuffix(thisChatOnly) +
          nextTaskSuffix(),
      );
    },
  },
  {
    name: "rename",
    descriptionKey: "commands.rename.description",
    // A free-form arg, never a candidate list: any title goes.
    takesArg: true,
    run: (arg) => {
      const store = useConversationStore.getState();
      const id = store.activeId;
      // A fresh chat is not in the index yet — nothing stored to name.
      if (!id) {
        note(i18n.t("commands.rename.none"));
        return;
      }
      if (!arg) {
        note(
          i18n.t("commands.rename.current", {
            title: store.conversations.find((c) => c.id === id)?.title ?? "",
          }),
        );
        return;
      }
      store.renameConversation(id, arg);
      note(i18n.t("commands.rename.set", { title: arg }));
    },
  },
  {
    name: "usage",
    descriptionKey: "commands.usage.description",
    run: () => {
      const provider = activeProvider();
      if (!provider) return;
      if (!supportsUsage(provider.id)) {
        note(i18n.t("commands.usage.unsupported", { provider: providerDisplayName(provider) }));
        return;
      }
      // A typed /usage is a deliberate ask and wants fresh numbers — the header
      // gauge's TTL cache exists for its remount churn, not for this.
      void fetchProviderUsage(provider).then(
        (usage) => {
          const name = providerDisplayName(provider) + (usage.plan ? ` (${usage.plan})` : "");
          const windows: string[] = [];
          if (usage.fiveHour) windows.push(windowLine(i18n.t("usage.window5h"), usage.fiveHour));
          if (usage.weekly) windows.push(windowLine(i18n.t("usage.windowWeekly"), usage.weekly));
          note([name, ...(windows.length > 0 ? windows : [i18n.t("usage.empty")])].join("\n"));
        },
        // fetchProviderUsage's message is already classified — auth failures
        // arrive worded as the sign-in fix.
        (e: unknown) => note(e instanceof Error ? e.message : String(e)),
      );
    },
  },
  {
    name: "mcp",
    descriptionKey: "commands.mcp.description",
    // The /usage shape for the other kind of helper: a read-only roll call of
    // the remote servers whose tools join this run's toolkit. The natural
    // first question when a task comes back "tool not found" — is the server
    // down, disabled, or never configured?
    run: () => {
      void (async () => {
        const servers = await listMcpServers();
        if (servers.length === 0) {
          note(i18n.t("commands.mcp.none"));
          return;
        }
        const statuses = await mcpStatusItem.get();
        const lines = servers.map((s) => {
          // Same dot language as the Settings rows: ✓ answered, ✗ failed,
          // · never checked. Detail is i18n'd at write time by whoever probed.
          const status = statuses[s.id];
          const mark = !status ? "·" : status.ok ? "✓" : "✗";
          const detail = status?.detail ?? i18n.t("mcpOut.statusNever");
          return `${mark} ${s.name} — ${detail}${s.enabled ? "" : ` ${i18n.t("commands.mcp.off")}`}`;
        });
        note([...lines, i18n.t("commands.mcp.manage")].join("\n"));
      })();
    },
  },
  {
    name: "document",
    descriptionKey: "commands.document.description",
    // The discovery surface for documented runs. The feature is armed by the
    // model when the user asks for it in prose, which works and is the thing we
    // want people to learn — but a phrase nobody has been told about is a
    // feature nobody finds. Typing "/doc" and pressing Enter completes to
    // "/document " (the takesArg path) and leaves the cursor where the task
    // goes, so the command is a template, not a second mechanism.
    //
    // ponytail: the model still decides whether to call the tool, so a model
    // that ignores the ask produces an undocumented run. The ceiling is one
    // wasted run; the upgrade path (roadmap) is a deterministic flag on the run
    // command that arms the recorder at start, which is only worth its state
    // once field evidence says models actually miss this.
    takesArg: true,
    // It produces a task, so it parks behind a live run like /skill does.
    deferWhileBusy: true,
    run: (arg) => {
      if (!arg) {
        // Reachable only past a dismissed menu — and the best place to teach
        // the phrase, since knowing it makes the command unnecessary.
        note(i18n.t("commands.document.hint"));
        return;
      }
      // Localized, for the reason /skill's template is: the model mirrors the
      // message's language, and an English wrapper would flip a pt-BR user's
      // whole run into English.
      useConversationStore.getState().sendTask(i18n.t("commands.document.task", { task: arg }));
    },
  },
  {
    name: "skill",
    descriptionKey: "commands.skill.description",
    takesArg: true,
    // Both forms leave the panel-local class — running a skill sends a task,
    // and "new" costs a model call — so runSlash parks them, the /compact rule.
    deferWhileBusy: true,
    candidates: () => [
      // First row = what Enter on a bare "/skill" does; the menu shows exactly
      // that, and the draft dialog it opens is reviewable and cancellable —
      // unlike the alternative default of starting some skill's run.
      { value: "new", label: i18n.t("commands.skill.newLabel") },
      ...loadedSkills()
        .filter((s) => s.enabled)
        .map((s) => ({ value: s.name, label: s.name, secondary: truncateTo(s.description, 60) })),
    ],
    run: (arg) => {
      const skills = loadedSkills();
      const enabledNames = skills.filter((s) => s.enabled).map((s) => s.name);
      if (!arg) {
        // Reachable only past a dismissed menu (Esc, then Enter) — the report form.
        note(
          enabledNames.length > 0
            ? i18n.t("commands.skill.list", { list: enabledNames.join(", ") })
            : i18n.t("commands.skill.none"),
        );
        return;
      }
      const [token = "", ...restParts] = arg.split(/\s+/);
      const rest = restParts.join(" ");
      const query = token.toLowerCase();
      if (query === "new") {
        const store = useConversationStore.getState();
        if (!store.activeId || store.messages.length === 0) {
          note(i18n.t("commands.skill.emptyConversation"));
          return;
        }
        openSkillDraft();
        return;
      }
      // Resolved here, not by resolveSlashArg — a name with trailing args
      // passes through raw, and this lookup runs against all skills so a
      // disabled one gets its own answer instead of "unknown".
      const pick = uniquePick(skills, query, (s) => [s.name]);
      if (!pick) {
        note(
          enabledNames.length > 0
            ? i18n.t("commands.skill.unknown", { name: token, list: enabledNames.join(", ") })
            : i18n.t("commands.skill.none"),
        );
        return;
      }
      if (!pick.enabled) {
        note(i18n.t("commands.skill.disabled", { name: pick.name }));
        return;
      }
      // Localized on purpose (see runSkillTask): the model mirrors the message's
      // language, and an English template would flip a pt-BR user's whole run
      // into English. One sender for /skill and every per-skill command.
      runSkillTask(pick.name, rest || undefined);
    },
  },
  {
    name: "compact",
    descriptionKey: "commands.compact.description",
    // The one command that is not local: summarizing takes a model call, and
    // the transcript it writes to is the worker's. The store's action posts it
    // and reports back through the compacted/compact_failed events.
    deferWhileBusy: true,
    run: () => {
      useConversationStore.getState().compact();
    },
  },
  {
    name: "new",
    descriptionKey: "commands.new.description",
    run: () => {
      // No note — the fresh chat's empty state is the acknowledgment.
      useConversationStore.getState().newConversation();
    },
  },
  {
    name: "skills",
    descriptionKey: "commands.skills.description",
    // The sheet rule (see /help): managing the library is browsing, not a
    // transcript line. Panel-local, so it fires even mid-run — flipping a
    // skill off while watching one is exactly when you reach for it.
    run: () => {
      openSkillsManage();
    },
  },
  {
    name: "help",
    descriptionKey: "commands.help.description",
    run: () => {
      // The sheet, not a note: a reference is only useful WHILE you work, and
      // a transcript line scrolls away and dies on panel reopen.
      openHelp();
    },
  },
];

/**
 * Every enabled skill is its own command — typing "/pay-rent invoicing" is
 * sugar for "/skill pay-rent invoicing", resolved to the same localized
 * citation task through this one sender. `thisChatOnly` has no meaning here:
 * a citation task is inherently this conversation's.
 */
function runSkillTask(name: string, rest?: string): void {
  useConversationStore
    .getState()
    .sendTask(
      rest
        ? i18n.t("commands.skill.taskWithArgs", { name, args: rest })
        : i18n.t("commands.skill.task", { name }),
    );
}

function skillCommand(s: Skill): SlashCommand {
  return {
    name: s.name,
    description: s.description,
    takesArg: true,
    deferWhileBusy: true,
    run: (arg) => runSkillTask(s.name, arg),
  };
}

/** Built-ins first, then one derived command per enabled skill that does not
 *  collide with a built-in's name (saveSkill rejects those going forward;
 *  pre-existing records keep working via /skill and lose only their menu slot). */
function allCommands(): readonly SlashCommand[] {
  const derived = loadedSkills()
    .filter((s) => s.enabled && !SLASH_COMMAND_NAMES.includes(s.name))
    .map(skillCommand);
  return [...COMMANDS, ...derived];
}

export function findCommand(name: string): SlashCommand | undefined {
  return allCommands().find((c) => c.name === name.toLowerCase());
}

/** The description text for any command — built-in (i18n'd) or skill-derived
 *  (the user's own words). One resolver so the menu and the help sheet agree. */
export function commandDescription(c: SlashCommand): string {
  return c.description ?? (c.descriptionKey ? i18n.t(c.descriptionKey) : "");
}

export function parseSlash(text: string): ParsedSlash | null {
  if (!text.startsWith("/") || text.includes("\n")) return null;
  const body = text.slice(1);
  if (/^\s/.test(body)) return null;
  const space = body.search(/\s/);
  const fragment = (space === -1 ? body : body.slice(0, space)).toLowerCase();
  const command = findCommand(fragment);
  return {
    fragment,
    ...(command ? { command } : {}),
    ...(space === -1 ? {} : { arg: body.slice(space + 1).trim() }),
  };
}

/**
 * What the menu shows for a draft: command matches while the name is being
 * typed; the command's candidates once the name is exact — a bare "/effort"
 * opens the picker straight away, no trailing space needed. An exact name with
 * no candidates (or none matching the typed arg) shows nothing — Enter runs it.
 */
export function slashItems(text: string): SlashMenuState | null {
  const parsed = parseSlash(text);
  if (!parsed) return null;
  if (parsed.command) {
    const command = parsed.command;
    const current = command.current?.();
    const q = (parsed.arg ?? "").toLowerCase();
    const items = (command.candidates?.() ?? [])
      .filter(
        (c) => !q || c.value.toLowerCase().startsWith(q) || c.label.toLowerCase().startsWith(q),
      )
      .map((c) => ({
        key: c.value,
        primary: c.label,
        ...(c.secondary ? { secondary: c.secondary } : {}),
        ...(c.value === current ? { current: true } : {}),
      }));
    return { kind: "candidates", command, items };
  }
  return {
    kind: "commands",
    items: allCommands()
      .filter((c) => c.name.startsWith(parsed.fragment))
      .map((c) => ({
        key: c.name,
        primary: `/${c.name}`,
        secondary: commandDescription(c),
      })),
  };
}

/**
 * Exact match, else unique prefix, against any of an item's keys — the one
 * resolution policy, shared by the dispatcher (resolveSlashArg) and the
 * commands that split or re-scope their arg themselves (/provider, /skill).
 */
function uniquePick<T>(items: T[], q: string, keys: (item: T) => string[]): T | undefined {
  const exact = items.find((item) => keys(item).includes(q));
  if (exact) return exact;
  const prefix = items.filter((item) => keys(item).some((k) => k.startsWith(q)));
  return prefix.length === 1 ? prefix[0] : undefined;
}

/**
 * The typed arg → what the command receives. Empty stays empty (the report
 * form); a candidate wins on an exact or unique-prefix match against either
 * its value or its label; anything else passes through raw so the command's
 * own validation can answer with the options.
 */
export function resolveSlashArg(
  command: SlashCommand,
  raw: string | undefined,
): string | undefined {
  if (raw === undefined || raw === "") return undefined;
  const candidates = command.candidates?.() ?? [];
  if (candidates.length === 0) return raw;
  const q = raw.toLowerCase();
  const pick = uniquePick(candidates, q, (c) => [c.value.toLowerCase(), c.label.toLowerCase()]);
  return pick?.value ?? raw;
}

/**
 * The one place a command is fired — Enter and the menu's click both come
 * through here, so the deferral gate cannot be bypassed by picking a row. A
 * parked command is not lost and not refused: the composer shows it as a card
 * waiting its turn, and the store fires it the moment the conversation is quiet.
 */
export function runSlash(
  command: SlashCommand,
  arg: string | undefined,
  thisChatOnly = false,
): void {
  const store = useConversationStore.getState();
  if (command.deferWhileBusy && runsHere(store)) {
    store.deferCommand(command.name, () => command.run(arg, thisChatOnly));
    return;
  }
  command.run(arg, thisChatOnly);
}

export type SlashOutcome = "not-slash" | "executed" | { complete: string };

/**
 * Enter on a slash draft. An exact command runs (its arg resolved); a unique
 * arg-taking fragment completes into the draft instead of executing, so
 * "/mo" Enter never fires a half-typed "/model gpt-5". Anything else is an
 * unknown command — answered with a note, never sent as a task.
 */
export function executeSlash(text: string, thisChatOnly = false): SlashOutcome {
  const parsed = parseSlash(text);
  if (!parsed) return "not-slash";
  if (parsed.command) {
    runSlash(parsed.command, resolveSlashArg(parsed.command, parsed.arg), thisChatOnly);
    return "executed";
  }
  if (!parsed.fragment) return "executed"; // a bare "/" — the menu already said everything
  // Completion prefers built-ins: "/re" completing to /rename predates skill
  // commands, and a skill named resume-* must not turn that into "ambiguous".
  // Skills join only when no built-in carries the fragment.
  const builtins = COMMANDS.filter((c) => c.name.startsWith(parsed.fragment));
  const matches =
    builtins.length > 0
      ? builtins
      : allCommands().filter((c) => c.name.startsWith(parsed.fragment));
  if (matches.length === 1 && matches[0]) {
    const command = matches[0];
    if (command.takesArg) return { complete: `/${command.name} ` };
    runSlash(command, undefined);
    return "executed";
  }
  note(i18n.t("commands.unknown", { name: parsed.fragment }));
  return "executed";
}
