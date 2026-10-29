/**
 * Download contract with the extension repo (chrome/docs/website-brief.md):
 * hotlink only these stable URLs — never hardcode a version number anywhere.
 */
export const LINKS = {
  /**
   * The secondary path since the store listing went live (2026-08-15): a
   * developer-mode install for people who'd rather not use the store or want to
   * run the source build. Same extension ID as the store item, so the two can't
   * be installed side by side. There is no CRX and never will be — Chrome
   * installs those only through the store's own flow.
   */
  zip: "https://github.com/tabrunner/tabrunner/releases/latest/download/tabrunner-latest-chrome.zip",
  /** The MCP daemon: one file, and the extension's own Settings → MCP pane hotlinks the same alias. */
  mcpDaemon:
    "https://github.com/tabrunner/tabrunner/releases/latest/download/tabrunner-latest-mcp.js",
  releases: "https://github.com/tabrunner/tabrunner/releases/latest",
  repo: "https://github.com/tabrunner/tabrunner",
  issues: "https://github.com/tabrunner/tabrunner/issues",
  license: "https://github.com/tabrunner/tabrunner/blob/main/LICENSE",
  // Legal docs render in-site (synced from the chrome repo by `bun run sync:legal`). English
  // routes: put them in the reader's language with `localePath`.
  privacy: "/privacy",
  terms: "/terms",
  docs: "/docs",
  mcpDocs: "https://github.com/tabrunner/tabrunner/blob/main/docs/mcp.md",
  /**
   * Live since 2026-08-15, and the primary CTA everywhere.
   *
   * Deliberately the listing, not the CRX behind it. Chrome's update service
   * (`clients2.google.com/service/update2/crx`) does serve the store-signed
   * build from a stable URL, and dragging that file in works — it carries the
   * publisher proof a self-built CRX can never have. We skip it because it's an
   * undocumented internal channel, it serves the store's last-approved build
   * rather than `releases/latest`, and it trades one click for a download plus
   * a drag with none of the listing's trust signals. README's "The store CRX
   * endpoint" section has the working recipe and the cases that would justify
   * adding it *beside* this link (CWS-blocked regions, offline installs).
   */
  store: "https://chromewebstore.google.com/detail/tabrunner/ilnohobdcigbmlikjbkdpbkhciephdle",
} as const;

export const CHROMIUM_BROWSERS = ["Chrome", "Brave", "Edge", "Arc", "Opera", "Vivaldi"] as const;

export const PROVIDER_PRESETS = [
  "Anthropic",
  "OpenAI",
  "Kimi",
  "Z.ai",
  "Qwen",
  "DeepSeek",
  "Gemini",
  "OpenRouter",
  "Groq",
  "Mistral",
  "xAI",
  "Ollama",
] as const;
