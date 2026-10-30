const NAME = "tabrunner";
const COMMAND = "bunx";
const PACKAGE = "tabrunner-mcp@latest";

/** Commands are data: never translated, and exactly what the extension's own Settings pane shows. */
export const MCP = {
  name: NAME,
  command: COMMAND,
  package: PACKAGE,
  plugin: "claude plugin install tabrunner --marketplace tabrunner/tabrunner",
  removePlugin: "claude plugin uninstall tabrunner",
  add: `claude mcp add --scope user ${NAME} -- ${COMMAND} ${PACKAGE}`,
  remove: `claude mcp remove --scope user ${NAME}`,
  removeLocal: `claude mcp remove --scope local ${NAME}`,
  deleteFile: "rm ~/.tabrunner-mcp.js",
} as const;

export const MCP_CLIENT_CONFIG = JSON.stringify(
  { mcpServers: { [NAME]: { command: COMMAND, args: [PACKAGE] } } },
  null,
  2,
);
