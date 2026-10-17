# TabRunner plugin

Lets Claude Code, Cowork and Codex hand browser tasks to TabRunner, a browser agent that runs in
your own Chrome with the accounts you are signed in to. Or the agent can click through a page
itself.

## What you need

1. The TabRunner extension, with a provider set up (a subscription sign-in or an API key). See
   [tabrunner.app](https://tabrunner.app).
2. The bridge turned on in TabRunner's Settings → MCP. It is off until you turn it on.
3. [bun](https://bun.sh). The plugin starts the bridge with `bunx tabrunner-mcp`, pinned to the
   plugin's version.

## Install

```bash
claude plugin install tabrunner --marketplace tabrunner/tabrunner
```

In Codex:

```bash
codex plugin marketplace add tabrunner/tabrunner
codex plugin add tabrunner@tabrunner
```

Then ask the agent to call `health`. It says whether the extension is connected, and what to do
if it isn't.

## Where your data goes

TabRunner has no server. The bridge runs on your machine, listens only on `127.0.0.1` and stores
nothing.

- When you hand TabRunner a task (`run`), the extension sends the task, the page's text and a
  screenshot to the AI provider you set up in TabRunner, with your own key or sign-in. TabRunner
  acts on the websites the task needs.
- When the agent drives the page itself (`browser_*`), the page's text, screenshots and anything
  a script reads go back to that agent.
- Your chats stay in your browser's local storage. TabRunner keeps the 50 most recent.

The full list, including the optional services you can add, is in the
[privacy policy](https://tabrunner.app/privacy).

## Links

- Setup guide and every tool: [docs/mcp.md](https://github.com/tabrunner/tabrunner/blob/main/docs/mcp.md)
- Terms: https://tabrunner.app/terms
- Help: https://github.com/tabrunner/tabrunner/issues
- License: MIT
