import { jsonLd, llmsTxt, mcpDiscoveryJson } from "@gusnips/vite";
import { CHROMIUM_BROWSERS, LINKS } from "../lib/links";
import { enUS, type Locale } from "../i18n/locales/en-US";
import { localePath, type SupportedLanguage } from "./locale";
import { MCP, MCP_CLIENT_CONFIG } from "./mcp";

/** Catalog strings carry four inline tags (code, bun, manual, privacy). Markdown for llms files. */
function markdown(text: string, origin: string): string {
  const links = {
    bun: "https://bun.sh",
    manual: LINKS.mcpDocs,
    privacy: `${origin}${LINKS.privacy}`,
  };
  return text
    .replace(/<code>(.*?)<\/code>/g, "`$1`")
    .replace(
      /<(bun|manual|privacy)>(.*?)<\/\1>/g,
      (_, tag: keyof typeof links, label: string) => `[${label}](${links[tag]})`,
    );
}

/** The same strings as plain text, for JSON fields. */
const plain = (text: string): string => text.replace(/<\/?[a-z]+>/g, "");

/** The `<script type="application/ld+json">` for the home page and the guide. */
export function softwareJsonLd(
  origin: string,
  language: SupportedLanguage,
  catalog: Locale,
): string {
  return jsonLd({
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    "@id": `${origin}/#software`,
    name: "TabRunner",
    description: catalog.seo.description,
    url: `${origin}${localePath(language, "/")}`,
    applicationCategory: "BrowserApplication",
    softwareRequirements: `Chromium desktop browser: ${CHROMIUM_BROWSERS.join(", ")}`,
    installUrl: LINKS.store,
    softwareHelp: `${origin}${localePath(language, LINKS.docs)}`,
    license: LINKS.license,
    inLanguage: language,
  });
}

/**
 * The machine-readable files, keyed by their path in `dist/`. English only: these files are
 * addresses a program fetches once, and each one links to the guide in all three languages.
 *
 * The MCP server is a local process the client starts, so the manifest says stdio. TabRunner has
 * no public HTTP endpoint, and nothing here may suggest one.
 */
export function discoveryFiles(origin: string): Record<string, string> {
  const docs = enUS.docs;
  const md = (text: string) => markdown(text, origin);
  const code = (text: string, language = "sh") => `\`\`\`${language}\n${text}\n\`\`\``;
  const section = (title: string, ...blocks: string[]) =>
    `## ${title}\n\n${blocks.map(md).join("\n\n")}`;
  const guide = `${origin}${LINKS.docs}`;

  const faq = Object.values(docs.faq).map((item) => {
    if ("a1" in item)
      return section(item.q, item.a1, code(MCP.add), item.a2, code(MCP.removeLocal));
    if ("items" in item)
      return section(
        item.q,
        item.lead,
        item.items.map((text) => `- ${text}`).join("\n"),
        item.tail,
      );
    return section(item.q, item.a);
  });

  const reference = [
    { title: "Connection guide", url: `${guide}#mcp` },
    {
      title: "Connection guide in Português (Brasil)",
      url: `${origin}${localePath("pt-BR", LINKS.docs)}#mcp`,
    },
    {
      title: "Connection guide in Español",
      url: `${origin}${localePath("es-ES", LINKS.docs)}#mcp`,
    },
    { title: "Every tool and setting", url: LINKS.mcpDocs },
    { title: "Privacy policy", url: `${origin}${LINKS.privacy}` },
  ];

  return {
    ".well-known/mcp.json": mcpDiscoveryJson({
      name: "app.tabrunner/tabrunner",
      description: docs.sub,
      homepage: origin,
      documentation: `${guide}#mcp`,
      llmsTxt: `${origin}/llms.txt`,
      llmsFullTxt: `${origin}/llms-full.txt`,
      servers: [
        {
          name: MCP.name,
          transport: "stdio",
          command: MCP.command,
          args: [MCP.package],
          authentication: [
            {
              type: "session",
              description: plain(docs.access.auth),
              documentation: `${guide}#access`,
            },
          ],
        },
      ],
    }),
    "llms.txt": llmsTxt({
      title: "TabRunner",
      summary: docs.sub,
      body: docs.mcp.intro,
      sections: [
        {
          title: "Documentation",
          links: [
            { ...reference[0]!, description: docs.seo.description },
            { title: "Full connection guide as plain text", url: `${origin}/llms-full.txt` },
            { title: "Local MCP install details", url: `${origin}/.well-known/mcp.json` },
            ...reference.slice(1),
          ],
        },
        { title: "Project", links: [{ title: "Source code", url: LINKS.repo }] },
      ],
    }),
    "llms-full.txt": llmsTxt({
      title: docs.title,
      summary: docs.sub,
      body: [
        section(
          docs.mcp.title,
          docs.mcp.intro,
          docs.mcp.enable,
          docs.mcp.install,
          code(MCP.plugin),
          docs.mcp.add,
          code(MCP.add),
          docs.mcp.check,
          docs.mcp.manual,
        ),
        section(
          docs.examples.title,
          docs.examples.intro,
          ...docs.examples.prompts.map((prompt) => code(prompt, "text")),
          docs.examples.follow,
        ),
        section(
          docs.access.title,
          docs.access.browser,
          docs.access.auth,
          docs.access.provider,
          docs.access.direct,
        ),
        section(
          docs.developers.title,
          docs.developers.intro,
          code(MCP_CLIENT_CONFIG, "json"),
          docs.developers.example,
          code(`run(${JSON.stringify(docs.examples.prompts[0])})`, "text"),
          docs.developers.status,
          docs.developers.reconnect,
        ),
        section(
          docs.remove.title,
          docs.remove.disable,
          docs.remove.plugin,
          code(MCP.removePlugin),
          docs.remove.remove,
          code(MCP.remove),
          docs.remove.file,
          code(MCP.deleteFile),
          docs.remove.update,
        ),
        ...faq,
      ].join("\n\n"),
      sections: [{ title: "Reference", links: reference }],
    }),
  };
}
