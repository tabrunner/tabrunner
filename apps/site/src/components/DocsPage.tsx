import type { ReactNode } from "react";
import { Trans, useTranslation } from "react-i18next";
import { localePath } from "../config/locale";
import { MCP, MCP_CLIENT_CONFIG } from "../config/mcp";
import { useLanguage } from "../i18n";
import { LINKS } from "../lib/links";
import { CodeBlock } from "./CodeBlock";
import { Footer } from "./Footer";
import { Nav } from "./Nav";

/**
 * The page people land on when something is unclear after install: how to connect Claude Code,
 * and short answers to the questions we hear most. Read mode: one quiet column, no sky.
 *
 * The MCP commands repeat `chrome/docs/mcp.md` and the extension's Settings → MCP pane. Change
 * all three together.
 */

/** Ids live here, not in the catalog: an anchor must mean the same thing in every language. */
const TOPICS = [
  { id: "mcp", title: "docs.mcp.title" },
  { id: "examples", title: "docs.examples.title" },
  { id: "access", title: "docs.access.title" },
  { id: "developers", title: "docs.developers.title" },
  { id: "remove", title: "docs.remove.title" },
  { id: "other-folders", title: "docs.faq.otherFolders.q" },
  { id: "not-connected", title: "docs.faq.notConnected.q" },
  { id: "browsers", title: "docs.faq.browsers.q" },
  { id: "account", title: "docs.faq.account.q" },
  { id: "data", title: "docs.faq.data.q" },
  { id: "confirm", title: "docs.faq.confirm.q" },
  { id: "stop", title: "docs.faq.stop.q" },
  { id: "update", title: "docs.faq.update.q" },
] as const;

type TopicId = (typeof TOPICS)[number]["id"];

const LINK_CLASS =
  "font-medium text-flare-300 underline decoration-flare-500/40 underline-offset-4 transition-colors hover:text-flare-200";

function Topic({ id, children }: { id: TopicId; children: ReactNode }) {
  const { t } = useTranslation();
  const topic = TOPICS.find((candidate) => candidate.id === id);
  return (
    <section id={id} className="mt-12 scroll-mt-20 border-t border-field-600/50 pt-10">
      <h2 className="text-xl font-semibold text-balance text-star-100">
        {topic ? t(topic.title) : null}
      </h2>
      {children}
    </section>
  );
}

/** `spacing` is the whole top margin and any size, so a caller replaces it instead of racing it. */
function P({ children, spacing = "mt-3" }: { children: ReactNode; spacing?: string }) {
  return (
    <p className={`${spacing} max-w-[68ch] leading-relaxed text-pretty text-star-300`}>
      {children}
    </p>
  );
}

function Step({ n, children }: { n: number; children: ReactNode }) {
  return (
    <li className="flex gap-4">
      <span
        aria-hidden="true"
        className="tnum flex size-8 shrink-0 items-center justify-center rounded-full border border-flare-500/50 bg-field-900 font-mono text-sm text-flare-300"
      >
        {n}
      </span>
      <div className="min-w-0 flex-1 pt-1">{children}</div>
    </li>
  );
}

export function DocsPage() {
  const { t } = useTranslation();
  const language = useLanguage();
  const checks = t("docs.faq.notConnected.items", { returnObjects: true }) as string[];

  // Inline pieces a sentence can carry: <code>, and links that must stay in the reader's language.
  const components = {
    code: (
      <code className="rounded bg-field-700/60 px-1.5 py-0.5 font-mono text-[0.85em] text-star-100" />
    ),
    bun: <a href="https://bun.sh" target="_blank" rel="noreferrer" className={LINK_CLASS} />,
    manual: <a href={LINKS.mcpDocs} target="_blank" rel="noreferrer" className={LINK_CLASS} />,
    privacy: <a href={localePath(language, LINKS.privacy)} className={LINK_CLASS} />,
  };
  const rich = (key: string) => <Trans i18nKey={key} components={components} />;

  return (
    <>
      <Nav route={LINKS.docs} />
      <main id="main" className="mx-auto max-w-3xl px-4 pt-14 pb-24 sm:px-6 sm:pt-20">
        <h1 className="font-display text-3xl font-semibold tracking-[-0.02em] text-balance sm:text-4xl">
          {t("docs.title")}
        </h1>
        <P spacing="mt-3 text-lg">{t("docs.sub")}</P>
        <p className="mt-3">
          <a href={`${localePath(language, "/")}#install`} className={LINK_CLASS}>
            {t("docs.installLink")}
          </a>
        </p>

        <nav aria-label={t("docs.contentsLabel")} className="mt-10">
          <p className="font-mono text-[10px] tracking-wider text-star-500 uppercase">
            {t("docs.contentsLabel")}
          </p>
          <ul className="mt-3 grid gap-x-8 sm:grid-cols-2">
            {TOPICS.map((topic) => (
              <li key={topic.id}>
                <a
                  href={`#${topic.id}`}
                  className="block py-1.5 text-sm text-star-300 transition-colors hover:text-flare-300"
                >
                  {t(topic.title)}
                </a>
              </li>
            ))}
          </ul>
        </nav>

        <Topic id="mcp">
          <P>{t("docs.mcp.intro")}</P>
          <ol className="mt-8 space-y-8">
            <Step n={1}>
              <P spacing="mt-0">{t("docs.mcp.enable")}</P>
            </Step>
            <Step n={2}>
              <P spacing="mt-0">{rich("docs.mcp.install")}</P>
              <CodeBlock code={MCP.plugin} />
              <P spacing="mt-6">{rich("docs.mcp.add")}</P>
              <CodeBlock code={MCP.add} />
            </Step>
            <Step n={3}>
              <P spacing="mt-0">{rich("docs.mcp.check")}</P>
            </Step>
          </ol>
          <P spacing="mt-8">{rich("docs.mcp.manual")}</P>
        </Topic>

        <Topic id="examples">
          <P>{t("docs.examples.intro")}</P>
          <ul className="mt-6 space-y-5">
            {[0, 1, 2].map((index) => (
              <li key={index}>
                <CodeBlock code={t(`docs.examples.prompts.${index}`)} />
              </li>
            ))}
          </ul>
          <P spacing="mt-6">{rich("docs.examples.follow")}</P>
        </Topic>

        <Topic id="access">
          <P>{t("docs.access.browser")}</P>
          <P>{rich("docs.access.auth")}</P>
          <P>{t("docs.access.provider")}</P>
          <P>{rich("docs.access.direct")}</P>
        </Topic>

        <Topic id="developers">
          <P>{t("docs.developers.example")}</P>
          <CodeBlock code={`run(${JSON.stringify(t("docs.examples.prompts.0"))})`} />
          <P>{rich("docs.developers.status")}</P>
          <P>{t("docs.developers.intro")}</P>
          <CodeBlock code={MCP_CLIENT_CONFIG} />
          <P>{t("docs.developers.reconnect")}</P>
          <h3 className="mt-8 font-semibold text-star-100">{t("docs.developers.reference")}</h3>
          <ul className="mt-3 space-y-3">
            {(
              [
                ["/.well-known/mcp.json", "discovery"],
                ["/llms.txt", "index"],
                ["/llms-full.txt", "full"],
              ] as const
            ).map(([href, key]) => (
              <li key={href}>
                <a href={href} className={LINK_CLASS}>
                  {t(`docs.developers.${key}`)}
                </a>
              </li>
            ))}
          </ul>
        </Topic>

        <Topic id="remove">
          <P>{rich("docs.remove.disable")}</P>
          <P spacing="mt-6">{t("docs.remove.plugin")}</P>
          <CodeBlock code={MCP.removePlugin} />
          <P spacing="mt-6">{rich("docs.remove.remove")}</P>
          <CodeBlock code={MCP.remove} />
          <P spacing="mt-6">{rich("docs.remove.file")}</P>
          <CodeBlock code={MCP.deleteFile} />
          <P spacing="mt-6">{rich("docs.remove.update")}</P>
        </Topic>

        <Topic id="other-folders">
          <P>{rich("docs.faq.otherFolders.a1")}</P>
          <CodeBlock code={MCP.add} />
          <P spacing="mt-6">{t("docs.faq.otherFolders.a2")}</P>
          <CodeBlock code={MCP.removeLocal} />
        </Topic>

        <Topic id="not-connected">
          <P>{t("docs.faq.notConnected.lead")}</P>
          <ul className="mt-4 max-w-[68ch] space-y-3">
            {checks.map((_, i) => (
              <li key={i} className="flex gap-3 leading-relaxed text-star-300">
                <span
                  aria-hidden="true"
                  className="mt-2.5 size-1.5 shrink-0 rotate-45 bg-flare-400"
                />
                <span>{rich(`docs.faq.notConnected.items.${i}`)}</span>
              </li>
            ))}
          </ul>
          <P>{t("docs.faq.notConnected.tail")}</P>
        </Topic>

        <Topic id="browsers">
          <P>{t("docs.faq.browsers.a")}</P>
        </Topic>
        <Topic id="account">
          <P>{t("docs.faq.account.a")}</P>
        </Topic>
        <Topic id="data">
          <P>{rich("docs.faq.data.a")}</P>
        </Topic>
        <Topic id="confirm">
          <P>{t("docs.faq.confirm.a")}</P>
        </Topic>
        <Topic id="stop">
          <P>{rich("docs.faq.stop.a")}</P>
        </Topic>
        <Topic id="update">
          <P>{rich("docs.faq.update.a")}</P>
        </Topic>
      </main>
      <Footer route={LINKS.docs} />
    </>
  );
}
