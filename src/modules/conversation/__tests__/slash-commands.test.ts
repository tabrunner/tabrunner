import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  COMMANDS,
  completeSlash,
  executeSlash as dispatchSlash,
  findCommand,
  parseSlash as parseCommand,
  resolveSlashArg,
  slashItems as listSlashItems,
} from "../ui/slash-commands";
import { useConversationStore } from "../ui/store";
import { useProvidersStore } from "@/modules/providers/ui";
import { getProviders, saveProvider } from "@/modules/providers";
import type { ProviderConfig } from "@/modules/providers/types";
import type { Skill } from "@/modules/skills";
import { i18n } from "@/i18n";
import ptBR from "@/i18n/locales/pt-BR.json";
import es from "@/i18n/locales/es.json";

const PROVIDER: ProviderConfig = {
  id: "p1",
  name: "Anthropic",
  shape: "anthropic",
  baseUrl: "https://api.anthropic.com",
  apiKey: "sk-test",
  createdAt: 0,
};

function skill(name: string, enabled = true): Skill {
  return {
    id: name,
    name,
    description: `does ${name}`,
    body: "steps",
    enabled,
    createdAt: 0,
    updatedAt: 0,
  };
}

function command(name: string) {
  const found = COMMANDS.find((c) => c.name === name);
  if (!found) throw new Error(`no command ${name}`);
  return found;
}

function lastNote(): string {
  const messages = useConversationStore.getState().messages;
  const note = messages[messages.length - 1];
  expect(note?.role).toBe("step");
  expect(note?.tool).toBeUndefined();
  return note?.content ?? "";
}

beforeEach(() => {
  skillsUi.skills.length = 0;
  useProvidersStore.setState({ providers: [PROVIDER], activeId: "p1", loaded: true });
  useConversationStore.setState({
    messages: [],
    runMode: "foreground",
    status: "idle",
    deferred: null,
    queuedRun: null,
    board: { queue: [] },
    // The engine pick of a conversation that has no id yet — a picker write
    // lands here, so leaving it set would carry one test's /effort into the next.
    draftEngine: null,
    conversations: [],
    activeId: null,
  });
});

describe("parseSlash", () => {
  it("ignores plain text, prose after the slash, and multiline drafts", () => {
    expect(parseSlash("book the flight")).toBeNull();
    expect(parseSlash("/ prose, not a command")).toBeNull();
    expect(parseSlash("/model gpt-5\nsecond line")).toBeNull();
  });

  it("parses fragments, exact names, and args", () => {
    expect(parseSlash("/")).toEqual({ fragment: "" });
    expect(parseSlash("/mo")).toEqual({ fragment: "mo" });
    expect(parseSlash("/effort")).toEqual({ fragment: "effort", command: command("effort") });
    expect(parseSlash("/effort  Hi")).toEqual({
      fragment: "effort",
      command: command("effort"),
      arg: "Hi",
    });
  });
});

describe("resolveSlashArg", () => {
  it("keeps empty empty, matches exact and unique prefixes, passes the rest raw", () => {
    const effort = command("effort");
    expect(resolveSlashArg(effort, undefined)).toBeUndefined();
    expect(resolveSlashArg(effort, "")).toBeUndefined();
    expect(resolveSlashArg(effort, "HIGH")).toBe("high");
    expect(resolveSlashArg(effort, "h")).toBe("high");
    // No match passes through so the command answers with the options.
    expect(resolveSlashArg(effort, "turbo")).toBe("turbo");
    // Free-text args (a model id) have no candidates to resolve against.
    expect(resolveSlashArg(command("model"), "gpt-5")).toBe("gpt-5");
  });
});

describe("executeSlash", () => {
  it("leaves normal tasks alone", () => {
    expect(executeSlash("book the flight")).toBe("not-slash");
    expect(useConversationStore.getState().messages).toHaveLength(0);
  });

  it("reports the run mode bare, and sets it explicitly by candidate", () => {
    expect(executeSlash("/background")).toBe("executed");
    expect(useConversationStore.getState().runMode).toBe("foreground"); // untouched
    expect(lastNote()).toContain("In foreground");
    expect(executeSlash("/background on")).toBe("executed");
    expect(useConversationStore.getState().runMode).toBe("background");
    expect(lastNote()).toContain("background");
    expect(executeSlash("/background sideways")).toBe("executed");
    expect(useConversationStore.getState().runMode).toBe("background"); // invalid changes nothing
    expect(lastNote()).toContain("sideways");
  });

  it("sets a valid effort and flags an invalid one — neither becomes a task", () => {
    expect(executeSlash("/effort high")).toBe("executed");
    expect(lastNote()).toContain("→ high");
    expect(executeSlash("/effort h")).toBe("executed");
    expect(lastNote()).toContain("→ high");
    expect(executeSlash("/effort turbo")).toBe("executed");
    expect(lastNote()).toContain("turbo");
    expect(lastNote()).toContain("none, low, medium, high, max");
  });

  it("reports the current model and effort when run bare", () => {
    executeSlash("/model");
    expect(lastNote()).toContain("Anthropic");
    executeSlash("/effort");
    expect(lastNote()).toContain("default");
  });

  it("offers only Default on a model with no effort setting, and says why", () => {
    // Haiku 4.5 takes no effort (anthropic.ts), so a stored "high" is not what
    // runs, and neither the list nor a note may say it is.
    useProvidersStore.setState({
      providers: [{ ...PROVIDER, model: "claude-haiku-4-5-20251001", reasoningEffort: "high" }],
    });
    const items = slashItems("/effort")?.items;
    expect(items?.map((i) => i.key)).toEqual(["default"]);
    expect(items?.find((i) => i.current)?.key).toBe("default");
    executeSlash("/effort high");
    expect(lastNote()).toBe(
      "claude-haiku-4-5-20251001 has no reasoning effort setting, so it always runs at its default.",
    );
    executeSlash("/effort");
    expect(lastNote()).toContain("has no reasoning effort setting");
  });

  it("answers an unknown command with the way forward", () => {
    expect(executeSlash("/frobnicate")).toBe("executed");
    expect(lastNote()).toContain("/frobnicate");
  });

  it("completes a unique arg-taking fragment instead of executing it", () => {
    expect(executeSlash("/eff")).toEqual({ complete: "/effort " });
    expect(executeSlash("/back")).toEqual({ complete: "/background " });
    // A unique no-arg fragment fires — there's nothing left to type.
    expect(executeSlash("/ne")).toBe("executed");
  });

  it("switches provider by name prefix", () => {
    useProvidersStore.setState({
      providers: [PROVIDER, { ...PROVIDER, id: "p2", name: "OpenAI", shape: "openai" as const }],
    });
    executeSlash("/provider open");
    expect(lastNote()).toContain("→ OpenAI");
  });

  it("answers /usage on an API-key provider without fetching", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    executeSlash("/usage");
    expect(lastNote()).toContain("API key");
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("reports /usage windows for a subscription provider", async () => {
    const claude: ProviderConfig = {
      ...PROVIDER,
      id: "claude",
      apiKey: "",
      auth: {
        accessToken: "at",
        refreshToken: "rt",
        expiresAt: Date.now() + 60_000,
      },
    };
    // The credential is read from storage on every call, never from the copy in hand.
    await saveProvider(claude);
    useProvidersStore.setState({ providers: [claude], activeId: "claude", loaded: true });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          five_hour: { utilization: 42 },
          seven_day: { utilization: 68 },
        }),
      ),
    );
    executeSlash("/usage");
    await vi.waitFor(() => {
      expect(lastNote()).toContain("42%");
    });
    expect(lastNote()).toContain("Claude");
    expect(lastNote()).toContain("68%");
    vi.unstubAllGlobals();
  });
});

describe("slashItems", () => {
  it("lists everything on a bare slash and filters by prefix", () => {
    expect(slashItems("/")?.items).toHaveLength(COMMANDS.length);
    expect(slashItems("/mo")?.items[0]?.key).toBe("model");
    expect(slashItems("just text")).toBeNull();
  });

  it("opens a bare picker's candidates with the current value marked", () => {
    const effort = slashItems("/effort");
    expect(effort?.kind).toBe("candidates");
    expect(effort?.items.map((i) => i.key)).toContain("high");
    // p1 has no persisted effort → "default" is the one checked.
    expect(effort?.items.find((i) => i.current)?.key).toBe("default");

    const model = slashItems("/model");
    expect(model?.items.map((i) => i.key)).toContain("auto");
    expect(model?.items.find((i) => i.current)?.key).toBe("auto");

    const background = slashItems("/background");
    expect(background?.items.map((i) => i.key)).toEqual(["off", "on"]);
    expect(background?.items.find((i) => i.current)?.key).toBe("off");
  });

  it("filters candidates by the typed arg", () => {
    expect(slashItems("/effort h")?.items.map((i) => i.key)).toEqual(["high"]);
    // A no-arg command's exact name shows nothing — Enter runs it.
    expect(slashItems("/new")?.items).toEqual([]);
  });
});

/**
 * The one command that acts on the live run. It exists because the composer's
 * ■ button yields to ↑ Send the moment there is text: a run you decide to kill
 * halfway through typing a steer has no mouse target until the line is cleared.
 */
describe("/stop", () => {
  it("stops a run working this conversation, and says nothing — the seam line does", () => {
    useConversationStore.setState({ status: "running" });
    const before = useConversationStore.getState().messages.length;

    command("stop").run(undefined);

    expect(useConversationStore.getState().status).toBe("idle");
    expect(useConversationStore.getState().messages).toHaveLength(before);
  });

  it("takes a still-queued submission out of the line instead", () => {
    useConversationStore.setState({
      status: "idle",
      queuedRun: { id: "q1", position: 2, task: "check the price" },
    });

    command("stop").run(undefined);

    expect(useConversationStore.getState().queuedRun).toBeNull();
    expect(lastNote()).toContain("queue");
  });

  it("orients instead of failing silently when there is nothing to stop", () => {
    command("stop").run(undefined);
    expect(lastNote()).toContain("no task running here to stop");
  });
});

// The command tests supply the same stored snapshot that the composer reads.
const skillsUi = vi.hoisted(() => {
  const skills: Skill[] = [];
  return { skills, openSkillDraft: vi.fn(), openSkillsManage: vi.fn() };
});
vi.mock("@/modules/skills/ui", () => ({
  openSkillDraft: skillsUi.openSkillDraft,
  openSkillsManage: skillsUi.openSkillsManage,
}));

const executeSlash = (text: string, thisChatOnly = false) =>
  dispatchSlash(text, thisChatOnly, skillsUi.skills);
const parseSlash = (text: string) => parseCommand(text, skillsUi.skills);
const slashItems = (text: string) => listSlashItems(text, skillsUi.skills);

describe("/document", () => {
  let sent: string[];

  beforeEach(() => {
    sent = [];
    useConversationStore.setState({
      sendTask: (task: string) => {
        sent.push(task);
      },
    });
  });

  it("wraps the task in an ask the model's document tool actually triggers on", () => {
    executeSlash("/document export the Q3 report");
    expect(sent).toHaveLength(1);
    // The contract with the tool description (agent/prompt.ts): the wrapper has
    // to contain the word the model is told to watch for, and it must keep the
    // user's own task intact.
    expect(sent[0]).toContain("export the Q3 report");
    expect(sent[0]?.toLowerCase()).toContain("document");
  });

  it("completes to a template instead of firing, so the task can be typed after it", () => {
    // Bare "/doc" must land the cursor after "/document ", never send an empty
    // documented run.
    expect(executeSlash("/doc")).toEqual({ complete: "/document " });
    expect(sent).toEqual([]);
  });

  it("teaches the phrase rather than dead-ending when run with no task", () => {
    executeSlash("/document ");
    expect(sent).toEqual([]);
    expect(lastNote()).toContain("document it");
  });
});

describe("/skill", () => {
  let sent: string[];

  beforeEach(() => {
    skillsUi.skills.length = 0;
    skillsUi.openSkillDraft.mockClear();
    sent = [];
    useConversationStore.setState({
      sendTask: (task: string) => {
        sent.push(task);
      },
    });
  });

  it("offers 'new' first, then only the enabled skills", () => {
    skillsUi.skills.push(skill("pay-rent"), skill("paused", false));
    const menu = slashItems("/skill");
    expect(menu?.kind).toBe("candidates");
    expect(menu?.items.map((i) => i.key)).toEqual(["new", "pay-rent"]);
  });

  it("resolves exact and unique-prefix names, passing the rest through as the task's args", () => {
    skillsUi.skills.push(skill("pay-rent"));
    executeSlash("/skill pay for August");
    expect(sent).toEqual(['Use the "pay-rent" skill for this task: for August']);
    executeSlash("/skill pay-rent");
    expect(sent[1]).toBe('Use the "pay-rent" skill.');
  });

  it("answers an unknown name with the available list, and a disabled one with its fix", () => {
    skillsUi.skills.push(skill("pay-rent"), skill("paused", false));
    executeSlash("/skill nope");
    expect(lastNote()).toContain("pay-rent");
    executeSlash("/skill paused");
    expect(lastNote()).toContain('"paused"');
    expect(sent).toEqual([]);
  });

  it("'new' opens the draft dialog only once there is a conversation to distill", () => {
    executeSlash("/skill new");
    expect(skillsUi.openSkillDraft).not.toHaveBeenCalled();
    useConversationStore.setState({
      activeId: "c1",
      messages: [{ id: "m1", role: "user", content: "pay my rent", timestamp: 0 }],
    });
    executeSlash("/skill new");
    expect(skillsUi.openSkillDraft).toHaveBeenCalledTimes(1);
  });
});

describe("per-skill commands", () => {
  let sent: string[];

  beforeEach(() => {
    skillsUi.skills.length = 0;
    sent = [];
    useConversationStore.setState({
      sendTask: (task: string) => {
        sent.push(task);
      },
    });
  });

  it("shows each enabled skill as its own menu entry and runs the citation task", () => {
    skillsUi.skills.push(skill("pay-rent"), skill("paused", false));
    expect(slashItems("/pay")?.items.map((i) => i.key)).toEqual(["pay-rent"]);
    expect(executeSlash("/pay-rent for August")).toBe("executed");
    expect(sent).toEqual(['Use the "pay-rent" skill for this task: for August']);
  });

  it("an exact fragment with args passes through to the same task template", () => {
    skillsUi.skills.push(skill("pay-rent"));
    expect(parseSlash("/pay-rent what I owe")?.command?.description).toBe("does pay-rent");
    executeSlash("/pay-rent what I owe");
    expect(sent[sent.length - 1]).toBe('Use the "pay-rent" skill for this task: what I owe');
  });

  it("a disabled skill gets neither a menu slot nor a run — /skill answers instead", () => {
    skillsUi.skills.push(skill("paused", false));
    expect(executeSlash("/paused soon")).toBe("executed");
    expect(lastNote()).toContain("paused");
    expect(sent).toEqual([]);
  });

  it("a built-in wins its name: no duplicate menu row, no derived dispatch", () => {
    skillsUi.skills.push(skill("model"));
    const keys = slashItems("/")?.items.map((i) => i.key) ?? [];
    expect(keys.filter((k) => k === "model")).toHaveLength(1);
    expect(parseSlash("/model")?.command?.descriptionKey).toBeDefined(); // the built-in's
    executeSlash("/model claude-x");
    // Engine changed, not a citation task — the built-in handled it.
    expect(sent).toEqual([]);
    expect(useConversationStore.getState().draftEngine?.model).toBe("claude-x");
  });

  it("fragment completion still prefers built-ins over a same-prefix skill", () => {
    skillsUi.skills.push(skill("resume-invoice"));
    expect(executeSlash("/re")).toEqual({ complete: "/rename " });
  });
});

describe("/skills", () => {
  it("opens the management modal straight away — even mid-run, panel-local like /help", () => {
    skillsUi.openSkillsManage.mockClear();
    useConversationStore.setState({ status: "running" });
    expect(executeSlash("/skills")).toBe("executed");
    expect(skillsUi.openSkillsManage).toHaveBeenCalledTimes(1);
    useConversationStore.setState({ status: "idle" });
  });
});

/**
 * Scope: a pick lands on the open conversation, and — unless ⌥ says otherwise —
 * also becomes the stored default that the next new conversation starts on.
 */
describe("aliases and search words", () => {
  it("resolves every built-in alias to one canonical action", () => {
    for (const canonical of COMMANDS) {
      expect(canonical.aliases?.length).toBeGreaterThan(0);
      for (const alias of canonical.aliases ?? []) {
        expect(findCommand(alias)?.name).toBe(canonical.name);
        expect(parseSlash(`/${alias.toUpperCase()} arg`)?.command).toBe(canonical);
      }
    }
  });

  it("completes bare argument-taking aliases and retains arguments on completion", () => {
    expect(executeSlash("/llm")).toEqual({ complete: "/model " });
    expect(executeSlash("/repeat")).toEqual({ complete: "/loop " });
    expect(executeSlash("/loo every 1h at minute 5 say hi")).toEqual({
      complete: "/loop every 1h at minute 5 say hi",
    });
    expect(completeSlash(command("model"), "/llm custom-model")).toBe("/model custom-model");
    expect(slashItems("/llm")?.items.map((i) => i.key)).toEqual(["model"]);
  });

  it("shows canonical rows for aliases, tags and descriptions, never duplicate rows", () => {
    expect(slashItems("/walk")?.items[0]?.key).toBe("document");
    expect(slashItems("/cron")?.items.map((i) => i.key)).toContain("loop");
    expect(slashItems("/shareable")?.items.map((i) => i.key)).toContain("document");
    const keys = slashItems("/re")?.items.map((i) => i.key) ?? [];
    expect(keys[0]).toBe("rename");
    expect(new Set(keys).size).toBe(keys.length);
    executeSlash("/cron");
    expect(lastNote()).toContain("No command /cron");
  });

  it("searches translated words without requiring accents", async () => {
    i18n.addResourceBundle("pt-BR", "translation", ptBR);
    i18n.addResourceBundle("es", "translation", es);
    try {
      await i18n.changeLanguage("pt-BR");
      expect(slashItems("/RACIOCINIO")?.items[0]?.key).toBe("effort");
      expect(slashItems("/capturas")?.items[0]?.key).toBe("document");
      await i18n.changeLanguage("es");
      expect(slashItems("/suscripcion")?.items[0]?.key).toBe("usage");
      expect(slashItems("/guia")?.items[0]?.key).toBe("document");
    } finally {
      await i18n.changeLanguage("en");
    }
  });

  it("canonicalizes skill aliases, including /skill arguments", () => {
    skillsUi.skills.push({ ...skill("pay-rent"), aliases: ["rent"], tags: ["housing"] });
    const send = vi.fn();
    useConversationStore.setState({ sendTask: send });
    executeSlash("/rent for August");
    executeSlash("/skill rent for September");
    expect(send.mock.calls.map(([task]) => task)).toEqual([
      'Use the "pay-rent" skill for this task: for August',
      'Use the "pay-rent" skill for this task: for September',
    ]);
    expect(slashItems("/housing")?.items.map((i) => i.key)).toEqual(["pay-rent"]);
    expect(slashItems("/skill rent")?.items.map((i) => i.key)).toEqual(["pay-rent"]);
  });

  it("keeps exact canonical names ahead of legacy aliases and rejects ambiguous aliases", () => {
    const send = vi.fn();
    useConversationStore.setState({ sendTask: send });
    skillsUi.skills.push(
      { ...skill("rent"), aliases: ["shared"] },
      { ...skill("other"), aliases: ["rent", "shared"] },
    );
    expect(findCommand("rent", skillsUi.skills)?.name).toBe("rent");
    executeSlash("/shared now");
    expect(lastNote()).toContain("More than one command");
    expect(send).not.toHaveBeenCalled();
    executeSlash("/skill shared now");
    expect(send).not.toHaveBeenCalled();
  });

  it("keeps old reserved skill names usable through /skill only", () => {
    const send = vi.fn();
    useConversationStore.setState({ sendTask: send });
    skillsUi.skills.push(skill("doc"), { ...skill("invoice"), aliases: ["llm"] });
    expect(slashItems("/")?.items.map((i) => i.key)).not.toContain("doc");
    expect(findCommand("doc", skillsUi.skills)?.name).toBe("document");
    expect(findCommand("llm", skillsUi.skills)?.name).toBe("model");
    executeSlash("/skill doc");
    expect(send).toHaveBeenCalledWith('Use the "doc" skill.');
  });
});

describe("/loop", () => {
  it("asks to save a recurring schedule, not run the action immediately", () => {
    const send = vi.fn();
    useConversationStore.setState({ sendTask: send });
    executeSlash("/loop every 1h at minute 5 say hi");
    expect(send).toHaveBeenCalledTimes(1);
    const task: string = send.mock.calls[0]?.[0] ?? "";
    expect(task).toContain("every 1h at minute 5 say hi");
    expect(task).toContain("schedule_task");
    expect(task).toContain("Do not perform the repeated action now");
    expect(task).toContain("minute_of_hour");
    expect(task).toContain("ask me to clarify");
  });

  it("explains timing, approval and browser requirements when run bare", () => {
    const send = vi.fn();
    useConversationStore.setState({ sendTask: send });
    executeSlash("/loop");
    expect(send).not.toHaveBeenCalled();
    expect(lastNote()).toContain("/loop every 1h at minute 5 say hi");
    expect(lastNote()).toContain("Chrome must be running");
    expect(lastNote()).toContain("Approve the plan");
  });

  it("parks behind a live run and keeps the canonical command name", () => {
    const send = vi.fn();
    useConversationStore.setState({ status: "running", sendTask: send, deferred: null });
    executeSlash("/repeat every 1h at minute 5 say hi");
    expect(send).not.toHaveBeenCalled();
    const deferred = useConversationStore.getState().deferred;
    expect(deferred?.name).toBe("loop");
    deferred?.run();
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe("engine scope", () => {
  const pin = () => useConversationStore.getState().draftEngine;
  /** What was actually persisted — the store only mirrors it through a watch. */
  const storedModel = async () => (await getProviders())[0]?.model;

  // Seeded so "the default is untouched" is a claim about a provider that IS
  // stored, not about an empty store that would pass either way.
  beforeEach(async () => {
    await saveProvider(PROVIDER);
  });

  it("writes through to the stored default by default", async () => {
    executeSlash("/model claude-y");
    expect(pin()).toEqual({ providerId: "p1", model: "claude-y" });
    expect(await storedModel()).toBe("claude-y");
    expect(lastNote()).not.toContain("This chat only");
  });

  it("keeps a ⌥ pick off the default, and says so", async () => {
    executeSlash("/model claude-z", true);
    expect(pin()).toEqual({ providerId: "p1", model: "claude-z" });
    // The whole point of the gesture: tomorrow's conversations are untouched.
    expect(await storedModel()).toBeUndefined();
    expect(lastNote()).toContain("This chat only");
  });

  it("refines the pick in force rather than replacing it", () => {
    executeSlash("/model claude-y", true);
    executeSlash("/effort high", true);
    expect(pin()).toEqual({ providerId: "p1", model: "claude-y", effort: "high" });
  });

  it("pins onto the conversation once it has one", () => {
    useConversationStore.setState({ activeId: "c1", conversations: [] });
    executeSlash("/effort low", true);
    // No conversation row to patch yet — but the draft is not the target
    // either, because this conversation exists. Nothing silently lands.
    expect(pin()).toBeNull();
  });
});
