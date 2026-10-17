# tabrunner-mcp

The MCP server for [TabRunner](https://tabrunner.app), the browser agent that works in your own
Chrome, with your tabs and the accounts you're already signed in to. Claude Code, Claude Desktop,
Codex or any other MCP client can give TabRunner a task and follow it to the answer, or click
through a page itself.

It needs [bun](https://bun.sh) and the TabRunner extension, with the bridge turned on in
Settings → MCP.

```bash
claude mcp add --scope user tabrunner -- bunx tabrunner-mcp@latest
```

Or install the plugin, which adds this server plus a skill that teaches the model how to use it:

```bash
claude plugin marketplace add tabrunner/tabrunner
claude plugin install tabrunner@tabrunner
```

Call `health` first: it says whether the extension is connected, and what to do if it isn't. The
tools and settings are in [docs/mcp.md](https://github.com/tabrunner/tabrunner/blob/main/docs/mcp.md).
