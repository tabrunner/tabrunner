import { parseSkillMd } from "./skill-md";
import { listSkills, upsertBuiltinSkill } from "./store";

/**
 * The built-in skill: shipped with the binary, seeded into every install so
 * the agent can answer questions about TabRunner itself beyond the short map
 * in the system prompt — troubleshooting, the full command reference, where
 * every knob lives. It is an ordinary catalog entry (unsited, enabled) and a
 * user may disable or delete it like any other; presence drives the seed
 * contract, so deletion sticks until the record is removed by hand.
 */
const BUILTIN_ID = "builtin-tabrunner-help";
export const BUILTIN_SKILL_URL = "builtin://tabrunner-help";

const DOC = `---
name: tabrunner-help
description: Answers questions about TabRunner itself — setup, settings, slash commands, schedules, skills, MCP, troubleshooting. Load whenever the user asks how something in TabRunner works.
---

# TabRunner help

You are running inside TabRunner, a browser-automation extension for Chrome. The user's question here is about the tool itself, not about a website. Answer precisely from this reference, name the exact control or command, and never offer to click inside your own UI — guide the user instead.

## Slash commands

Typed as the first character of the composer. Most change a setting directly and never reach you as messages.

| Command | What it does |
| --- | --- |
| /stop | Stop the running task |
| /background | Foreground/background toggle for the next run |
| /effort | Reasoning effort (default, low → max) |
| /model | Pick this conversation's model |
| /provider | Switch provider |
| /rename | Rename the current chat |
| /usage | Subscription usage windows |
| /mcp | Status roll call of connected MCP servers |
| /document | Start a documented run ("do X **and document it**" works too) |
| /skill | Run a saved skill · \`/skill new\` saves this chat as one |
| /skills | Open the skills manager |
| /compact | Summarize the chat to free context |
| /new | New conversation |
| /help | Shortcuts and commands |

Every saved skill also runs as its own command — typing \`/invoice-download shopping\` is shorthand for "/skill invoice-download shopping".

## Where everything lives

Settings opens from the panel's gear menu ("All settings").

- **General** — theme and language.
- **Behavior** — status widget visibility, background-start page, tips toggle.
- **Schedules** — tasks that run on their own: one-shot, daily at a fixed time, or every N minutes, with optional weekday filter and active-hours window. Each schedule owns one conversation, so a recurring run can read what it did last time. "Run now", open its conversation, delete, all from its row.
- **Knowledge** — standing instructions for every chat plus remembered facts, editable and deletable. Instructions headed \`## site:\` load only on runs starting there.
- **Skills** — the recipe library: create, edit, import (URL, GitHub repo, pasted markdown), export, site-scope, enable/disable.
- **Providers** — subscription sign-in (Anthropic, OpenAI, Kimi) or API keys across presets plus any OpenAI-/Anthropic-compatible endpoint. Effort is the only generation knob; no temperature controls by design.
- **MCP** — connect OUT to remote Streamable HTTP servers (their tools join runs behind plan approval), and run the inbound bridge that lets external clients drive this browser.

The marketing site with install steps and screenshots is tabrunner.app.

## Troubleshooting

- **"TabRunner started debugging this browser" infobar** — normal. Actions ride Chrome's debugger protocol; it appears with the first action of a run and clears when the run detaches.
- **Nothing happens after sending a task** — the plan gate is probably waiting: the run shows a plan card the user must approve before any page action. Esc or ■ stops it.
- **A still amber "?" favicon dot and quiet tab badge** — the run ended on a question; the answer field is waiting in the panel.
- **Chrome internal pages** (chrome://, the Web Store, PDF viewer) can't be driven. Ask the agent to work in a normal tab instead.
- **CAPTCHAs, logins without a saved session, payments above what was agreed** — the agent stops and asks rather than pushing through. That is policy, not breakage.
- **Provider errors (401/quota)** — fix them in Settings → Providers: re-sign-in for subscriptions, paste a fresh key otherwise. \`/usage\` shows remaining windows on subscription plans.
- **An extension update landed** — chrome://extensions → TabRunner → reload, or restart the browser. A reload kills an in-flight worker mid-run; finished transcripts survive.
- **Sent a task and the answer references stale context?** — /compact summarizes long threads; older messages stay in scrollback, replay starts at the summary.

## Good habits to pass along

- Give the goal, not the clicks — describe the outcome, let the agent find the buttons.
- Signed-in sites just work: the agent uses the user's own tabs and sessions.
- Anything consequential (paying, sending, deleting, submitting) always stops for explicit permission first.
- Recurring drags ("check my invoices every Monday") belong in Schedules — ask the agent to schedule it.
`;

/**
 * Seed on install, refresh on update, respect deletion:
 * - `install` + absent id  → insert enabled
 * - `update`  + present id → refresh body/description, preserve user's toggle
 * - `update`  + absent id  → do nothing (they deleted it on purpose)
 */
export async function seedBuiltinSkills(reason: "install" | "update"): Promise<void> {
  const parsed = parseSkillMd(DOC);
  if (!parsed.name || !parsed.description) return; // our own doc — but guard anyway
  const existing = await listSkills();
  const present = existing.some((s) => s.id === BUILTIN_ID);
  if (!present && reason !== "install") return;
  await upsertBuiltinSkill({
    id: BUILTIN_ID,
    name: parsed.name,
    description: parsed.description,
    ...(parsed.sites.length > 0 ? { sites: parsed.sites } : {}),
    body: parsed.body,
    enabled: true,
    source: { url: BUILTIN_SKILL_URL },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
}
