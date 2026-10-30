# TabRunner

<p>
  <img src="apps/extension/public/icon/128.png?v=2" width="64" height="64" alt="TabRunner comet mark" align="left" />
  <strong>You give the goal. It runs the tabs.</strong><br/>
  An AI agent that drives your <em>real</em> browser (your tabs, your sessions and your logged-in
  accounts) through any provider you choose. Describe a task in the side panel; TabRunner reads
  pages, clicks, types, and navigates until the job is done.
</p>

<br/>

> Named for what it does: it runs your tabs. You give the goal, it does the running in your
> browser, with your authority, while you watch.

## Why

Most browser agents run in a sandboxed, logged-out browser. TabRunner runs in **yours**, so it can
act on the sites you're actually logged into. And it's provider-agnostic by construction: no
vendor lock-in, no relay, no account with us. Your API key (or the subscription you sign in with)
goes straight from the extension to your provider.

## Features

- **Use your AI provider**: sign in to a provider, paste an API key or connect a local model.
  Other OpenAI- or Anthropic-compatible providers work too.
- **Real trusted input**: clicks and keystrokes go through the Chrome DevTools Protocol, so they
  are genuine trusted events, not synthetic JS dispatches that sites can ignore.
- **Sees the page, not the HTML**: the model works from a compact semantic tree
  (`[ref=e12] button "Submit"`): small prompts, stable refs, and sanitized, capped results.
  Passwords, one-time codes and card numbers never leave the page.
- **Page-internals tools**: when keystrokes won't land, the agent acts directly in the page
  (`fill`, `evaluate`); read-only network and console rings let it see a failing request or a
  script error itself.
- **Guardrails that hold**: you approve the plan before anything happens, and consequential
  actions (paying, sending, deleting) come back for confirmation. Automatic retry with backoff on
  transient provider errors, a step budget, truncation detection, and a Stop button that actually
  stops.
- **Live run status**: current action, elapsed time, and token spend while the agent works,
  Claude Code-style.
- **Reasoning effort control**: optional per-provider effort (`none` → `max`), mapped to each
  wire format; omitted entirely when you want provider defaults.
- **Auto model selection**: Auto uses the provider's model list and shows the selected model.
  ChatGPT follows your account's catalog. You can pin a model and reasoning effort for each chat.
- **Remembers across runs**: your standing instructions (`AGENTS.md`) and the agent's own notes
  (`MEMORY.md`) load into every run; a `## site:` section loads only when a task starts on that
  site. Editable on the options page, off with one toggle.
- **Skills**: saved instructions the agent loads when a
  task matches: `/skill new` distills a conversation you just steered into one, `/skill <name>`
  runs one on demand, and skills tied to a site surface only there. Import one from a URL,
  GitHub `owner/repo`, or pasted markdown (SKILL.md-compatible); export as markdown to share.
- **Runs on a timer**: "every weekday at 9am, summarize my inbox", "at 3pm, check the delivery".
  Ask for it in the panel and approving the plan is the consent; the run fires later in a tab of
  its own and notifies you when it lands. The agent can pace itself the same way: schedule a
  follow-up, keep checking, cancel when the goal is met. Review and cancel them in Settings.
- **Two-way MCP**: Claude Code, Claude Desktop, or any Model Context Protocol client can hand
  TabRunner a task and follow it to the answer, using the same browser and the same logins,
  labelled in your history with which client did it. The client says what it wants done and
  TabRunner's model does the driving, or the client drives directly when the job is small and exact.
  TabRunner dials out too: connect remote MCP servers and their tools join every run behind the
  plan gate (`/mcp` reports what's connected), and run events can POST to your own webhook. See
  [docs/mcp.md](docs/mcp.md). In Claude Code, the plugin sets it up in one line:

  ```bash
  claude plugin install tabrunner --marketplace tabrunner/tabrunner
  ```

- **Speaks your language, matches your theme**: English, Português (Brasil), and Español; light,
  dark, or follow the OS.
- **Your data stays local**: provider configs and history live in `chrome.storage`. There is no
  TabRunner server. See [PRIVACY.md](PRIVACY.md) for the full picture, and
  [TERMS.md](TERMS.md) for the terms of use.

## Install

```bash
bun install
bun run --cwd apps/extension build
```

Then `chrome://extensions` → **Developer mode** → **Load unpacked** → select
`apps/extension/dist/chrome-mv3`. Click the TabRunner toolbar icon to open the side panel, add a provider
(options page), and describe a task.

Works on Chrome, Brave, Edge, Arc, Opera, and Vivaldi. Chromium-only by design: Firefox has no
`chrome.debugger` equivalent ([Bugzilla 1316741](https://bugzilla.mozilla.org/show_bug.cgi?id=1316741)),
which trusted input depends on.

## How it works

```
side panel (React) ──Port──▶ background service worker ──▶ provider API (SSE stream)
                                  │
                                  ├─▶ snapshot: accessibility tree via chrome.scripting
                                  └─▶ actions: trusted input via chrome.debugger (CDP)
```

1. You send a task. The run adopts your current tab (or opens its own tab when there's no
   page to work) and snapshots its accessibility tree.
2. The provider streams a reply; tool calls (`navigate`, `click`, `type`, `scroll`, `snapshot`,
   `screenshot`, `done`) execute against the real tab.
3. Results feed back into the conversation until the model calls `done` or you hit Stop.
   Panel tasks run one at a time. MCP clients and schedules have separate queues, with at most
   four tasks active across the extension.

An open Port keeps the MV3 service worker alive while the panel is open; with the panel closed
(after a background submit it closes itself) a periodic alarm holds it through long silences.
Durable state is written to storage as it changes, and tasks keep working with the panel closed.
Stop them from the Tasks band or by closing the driven tab.

## Repository layout

The extension, website and MCP daemon live in one Bun + Turbo workspace. Install once at the root.
Dependency versions live in the root catalog, with one `bun.lock`.

| Path              | What it contains                                       |
| ----------------- | ------------------------------------------------------ |
| `apps/extension/` | Chromium extension, WXT build and UI                   |
| `apps/site/`      | tabrunner.app, built and deployed separately           |
| `packages/mcp/`   | The published `tabrunner-mcp` daemon                   |
| `plugin/`         | Client plugin, skill and MCP launchers                 |
| `docs/`           | Public guides, product contract and source screenshots |

## Development

Run these from the repository root:

```bash
bun run extension     # extension hot reload
bun run site          # site dev server
bunx turbo run lint typecheck --filter=./apps/extension
bun run icons         # extension, plugin and repository brand assets
bun run bridge        # run the MCP daemon by hand
bun run bridge:check  # isolated bridge smoke check, no Chrome needed
```

Use `--filter=./apps/site` or `--filter=./packages/mcp` to check another package. Run only the test
file you changed, from its package directory. The full suite is manual, not part of CI or `check`.

The extension's domains live under `apps/extension/src/modules/`, with Base UI primitives in
`apps/extension/src/components/`. See [AGENTS.md](AGENTS.md) for workspace commands and the
[extension guide](apps/extension/AGENTS.md) for architecture and runtime boundaries.

Ready PRs typecheck affected packages and root scripts, then merge and start the site deploy when
its inputs changed. Draft PRs do not release anything. The extension and MCP package still publish
only from release tags; the site can deploy without an extension release.

## Roadmap

Next up: **domain policy** (tell it where it may never go), **skill waypoints** (a skill that
remembers the page's anchors, not just prose), and **file upload**. A **Firefox version** stays blocked because `chrome.debugger` has no
equivalent there, so it's a rewrite of the driver rather than a port.

Full reasoning, open questions and what we've ruled out: [docs/roadmap.md](docs/roadmap.md).

## License

[MIT](LICENSE) © Gus
