import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  AddProviderDialog,
  ProviderList,
  useProvidersStore,
  activeProviderOf,
} from "@/modules/providers/ui";
import { InstructionsSection, MemorySection } from "@/modules/memory/ui";
import { HooksSection } from "@/modules/hooks/ui/HooksSection";
import { SchedulesSection } from "@/modules/schedule/ui";
import { SkillsSection } from "@/modules/skills/ui";
import { Button } from "@/components/Button";
import { BrandMark } from "@/components/BrandMark";
import { Icon } from "@/components/Icon";
import { Switch } from "@/components/Switch";
import { TextField } from "@/components/TextField";
import { useStoredItem } from "@/components/useStoredItem";
import { ThemeToggle } from "@/components/ThemeControl";
import { LanguageToggle } from "@/components/LanguageToggle";
import { defaultStartUrl, tipsEnabled, walkthroughsEnabled, widgetHidden } from "@/lib/prefs";
import { LINKS } from "@/lib/links";
import { newIssueUrl } from "@/lib/report";
import { StatusStrip } from "./StatusStrip";
import { McpPane } from "./McpPane";

const PAGES = [
  "general",
  "behavior",
  "schedules",
  "knowledge",
  "skills",
  "providers",
  "mcp",
] as const;
type PageId = (typeof PAGES)[number];

/** The hash is the page's deep link — a reload or a copied URL lands back here. */
function pageFromHash(): PageId {
  const hash = window.location.hash.slice(1);
  return (PAGES as readonly string[]).includes(hash) ? (hash as PageId) : "general";
}

/** A start page a background run can actually open — full http(s) URL only. */
function validStartUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/** One rail destination — quiet until it's the page you're on. */
function NavItem({
  active,
  label,
  onClick,
  children,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Button
      variant="nav"
      aria-current={active ? "page" : undefined}
      className="flex w-full items-center justify-start gap-2"
      onClick={onClick}
    >
      <Icon>{children}</Icon>
      {label}
    </Button>
  );
}

/** The GitHub mark — a fill icon, so it lives outside the stroke Icon family. Used once: here. */
function GithubMark({ size = 14, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      className={className}
      aria-hidden
    >
      <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
    </svg>
  );
}

function GeneralPane() {
  const { t } = useTranslation();
  const version = chrome.runtime.getManifest().version;
  // The same provider every other surface calls active — a report is only
  // reproducible if it names the one the runs actually used.
  const provider = useProvidersStore(activeProviderOf);
  const linkClass = "text-brand-600 hover:underline dark:text-brand-400";
  return (
    <>
      <section className="flex flex-wrap items-start gap-x-10 gap-y-4">
        <div>
          <h2 className="text-base font-semibold text-neutral-900 dark:text-neutral-100">
            {t("settings.appearance")}
          </h2>
          <div className="mt-3">
            <ThemeToggle />
          </div>
        </div>
        <div>
          <h2 className="text-base font-semibold text-neutral-900 dark:text-neutral-100">
            {t("settings.language")}
          </h2>
          <div className="mt-3">
            <LanguageToggle />
          </div>
        </div>
      </section>

      {/* The product's identity card: what it is, that it's open source, and
          where its code, issues and license live. */}
      <section className="mt-10 border-t border-neutral-200 pt-6 dark:border-neutral-800">
        <h2 className="text-base font-semibold text-neutral-900 dark:text-neutral-100">
          {t("settings.about")}
        </h2>
        <p className="mt-3 max-w-prose text-sm text-neutral-600 dark:text-neutral-400">
          {t("settings.aboutBody")}
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
          <a
            href={LINKS.repo}
            target="_blank"
            rel="noreferrer"
            className={`inline-flex items-center gap-1.5 ${linkClass}`}
          >
            <GithubMark />
            tabrunner/tabrunner
          </a>
          <a href={LINKS.issues} target="_blank" rel="noreferrer" className={linkClass}>
            {t("settings.aboutIssues")}
          </a>
          {/* Browsing issues and filing one are different errands — the first
              is how you find out it's known, the second how it becomes known.
              This one arrives pre-filled with the version and provider. */}
          <a
            href={newIssueUrl({ provider })}
            target="_blank"
            rel="noreferrer"
            className={linkClass}
          >
            {t("settings.reportIssue")}
          </a>
          <a href={LINKS.site} target="_blank" rel="noreferrer" className={linkClass}>
            tabrunner.app
          </a>
        </div>
        <p className="mt-3 text-xs text-neutral-500 dark:text-neutral-400">
          v{version} ·{" "}
          <a href={LINKS.license} target="_blank" rel="noreferrer" className="hover:underline">
            MIT
          </a>
        </p>
      </section>
    </>
  );
}

function BehaviorPane() {
  const { t } = useTranslation();
  // Stored inverted ("hidden") so the default needs no write; shown as the
  // positive toggle.
  const hidden = useStoredItem(widgetHidden);
  const tips = useStoredItem(tipsEnabled);
  const walkthroughs = useStoredItem(walkthroughsEnabled);
  const stored = useStoredItem(defaultStartUrl);
  // Edited locally, persisted on blur — a half-typed URL must never reach a run.
  const [startUrl, setStartUrl] = useState<string | null>(null);
  const [urlError, setUrlError] = useState(false);
  const urlValue = startUrl ?? stored;

  const commitStartUrl = () => {
    const value = urlValue.trim();
    if (validStartUrl(value)) {
      setUrlError(false);
      void defaultStartUrl.set(value);
      setStartUrl(null);
    } else {
      // Keep the text with the error under it — the fix happens here, and
      // nothing invalid ever reaches the store.
      setUrlError(true);
    }
  };

  return (
    <>
      {/* Dispatch-and-forget knobs: where background tasks open, and whether
          the floating indicator reports them on the active tab. */}
      <section>
        <h2 className="text-base font-semibold text-neutral-900 dark:text-neutral-100">
          {t("settings.backgroundTasks")}
        </h2>
        <div className="mt-3 flex items-start justify-between gap-4">
          <div>
            <div className="text-sm font-medium text-neutral-800 dark:text-neutral-200">
              {t("settings.showWidget")}
            </div>
            <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
              {t("settings.showWidgetHint")}
            </p>
          </div>
          <Switch
            checked={!hidden}
            onChange={(v) => void widgetHidden.set(!v)}
            ariaLabel={t("settings.showWidget")}
          />
        </div>
        <div className="mt-4">
          <TextField
            label={t("settings.defaultStartUrl")}
            hint={
              urlError ? (
                <span className="arrive block text-red-600 dark:text-red-400">
                  {t("settings.invalidUrl")}
                </span>
              ) : (
                t("settings.defaultStartUrlHint")
              )
            }
            value={urlValue}
            onChange={(e) => {
              setStartUrl(e.target.value);
              if (urlError) setUrlError(false);
            }}
            onBlur={commitStartUrl}
            placeholder={defaultStartUrl.fallback}
            inputMode="url"
            spellCheck={false}
            aria-invalid={urlError || undefined}
          />
        </div>
      </section>

      {/* What a run is allowed to keep. Its own section: this is the only
          setting that decides whether pictures of the user's browser are
          written to disk, and burying it under "background tasks" would hide
          the one knob a privacy-minded user comes here for. */}
      {/* One control, so the switch rides the heading. The other sections pair a
          category heading with differently-named rows under it; this one has a
          single row named after its own section, so the intermediate label was
          the same words twice, 12px apart, and read as a rendering bug. */}
      <section className="mt-8">
        <div className="flex items-start justify-between gap-4">
          <h2 className="text-base font-semibold text-neutral-900 dark:text-neutral-100">
            {t("settings.walkthroughs")}
          </h2>
          <Switch
            checked={walkthroughs}
            onChange={(v) => void walkthroughsEnabled.set(v)}
            ariaLabel={t("settings.walkthroughs")}
          />
        </div>
        <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
          {t("settings.walkthroughsHint")}
        </p>
      </section>

      {/* Panel-only chrome — nothing here touches a background run. */}
      <section className="mt-8">
        <h2 className="text-base font-semibold text-neutral-900 dark:text-neutral-100">
          {t("settings.sidePanel")}
        </h2>
        <div className="mt-3 flex items-start justify-between gap-4">
          <div>
            <div className="text-sm font-medium text-neutral-800 dark:text-neutral-200">
              {t("settings.showTips")}
            </div>
            <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
              {t("settings.showTipsHint")}
            </p>
          </div>
          <Switch
            checked={tips}
            onChange={(v) => void tipsEnabled.set(v)}
            ariaLabel={t("settings.showTips")}
          />
        </div>
      </section>

      {/* Outbound run events — the same dispatch-and-forget spirit as the knobs
          above, pointed at the user's own endpoints. */}
      <HooksSection />
    </>
  );
}

function ProvidersPane() {
  const { t } = useTranslation();
  const loaded = useProvidersStore((s) => s.loaded);
  const hasProviders = useProvidersStore((s) => s.providers.length > 0);
  return (
    <section>
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold text-neutral-900 dark:text-neutral-100">
          {t("settings.providers")}
        </h2>
        {/* The empty list already offers the first-provider CTA in context —
            two Add buttons for one job is one too many. */}
        {(!loaded || hasProviders) && (
          <AddProviderDialog trigger={<Button size="sm">{t("settings.addProvider")}</Button>} />
        )}
      </div>
      <div className="mt-3">
        <ProviderList />
      </div>
    </section>
  );
}

export default function App() {
  const { t } = useTranslation();
  const [page, setPage] = useState<PageId>(pageFromHash);
  /** Set once the user (or a hashchange) picks a page — a deliberate choice
   *  outranks the first-run redirect below. */
  const [navigated, setNavigated] = useState(false);
  const providersLoaded = useProvidersStore((s) => s.loaded);
  const providerCount = useProvidersStore((s) => s.providers.length);

  useEffect(() => {
    void useProvidersStore.getState().load();
  }, []);

  useEffect(() => {
    const onHash = () => {
      setNavigated(true);
      setPage(pageFromHash());
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  // A bare visit with nothing configured lands on the page that unblocks the
  // product, not on Appearance. A hash or a click is a deliberate choice and
  // always wins — this only speaks while the user has chosen nothing.
  const visiblePage =
    !navigated && providersLoaded && providerCount === 0 && !window.location.hash
      ? "providers"
      : page;

  const go = (id: PageId) => {
    setNavigated(true);
    setPage(id);
    // No per-page history stack, no scroll-to-anchor — the hash is a bookmark.
    window.history.replaceState(null, "", `#${id}`);
  };

  return (
    <div className="mx-auto max-w-3xl p-6">
      <h1 className="flex items-center gap-2 text-lg font-semibold text-neutral-900 dark:text-neutral-100">
        <BrandMark size={24} />
        {t("settings.pageTitle")}
      </h1>

      <StatusStrip onAddProvider={() => go("providers")} />

      <div className="mt-6 flex items-start gap-6">
        <nav aria-label={t("settings.pageTitle")} className="flex w-40 shrink-0 flex-col gap-0.5">
          <NavItem
            active={visiblePage === "general"}
            label={t("settings.nav.general")}
            onClick={() => go("general")}
          >
            <path d="M4 6h10" />
            <path d="M18 6h2" />
            <circle cx="16" cy="6" r="2" />
            <path d="M4 12h2" />
            <path d="M10 12h10" />
            <circle cx="8" cy="12" r="2" />
            <path d="M4 18h12" />
            <circle cx="18" cy="18" r="2" />
          </NavItem>
          <NavItem
            active={visiblePage === "behavior"}
            label={t("settings.nav.behavior")}
            onClick={() => go("behavior")}
          >
            <path d="M13 2 3 14h7l-1 8 10-12h-7l1-8z" />
          </NavItem>
          <NavItem
            active={visiblePage === "schedules"}
            label={t("settings.nav.schedules")}
            onClick={() => go("schedules")}
          >
            <rect x="3" y="5" width="18" height="16" rx="2" />
            <path d="M3 10h18" />
            <path d="M8 3v4" />
            <path d="M16 3v4" />
            <path d="M12 14v3l2 1" />
          </NavItem>
          <NavItem
            active={visiblePage === "knowledge"}
            label={t("settings.nav.knowledge")}
            onClick={() => go("knowledge")}
          >
            <path d="M2 4h6a4 4 0 0 1 4 4v12a3 3 0 0 0-3-3H2z" />
            <path d="M22 4h-6a4 4 0 0 0-4 4v12a3 3 0 0 1 3-3h7z" />
          </NavItem>
          <NavItem
            active={visiblePage === "skills"}
            label={t("settings.nav.skills")}
            onClick={() => go("skills")}
          >
            <path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z" />
            <path d="M20 3v4" />
            <path d="M22 5h-4" />
          </NavItem>
          <NavItem
            active={visiblePage === "providers"}
            label={t("settings.nav.providers")}
            onClick={() => go("providers")}
          >
            <circle cx="7.5" cy="15.5" r="4.5" />
            <path d="m11 12 10-10" />
            <path d="m16 5 3 3" />
          </NavItem>
          <NavItem
            active={visiblePage === "mcp"}
            label={t("settings.nav.mcp")}
            onClick={() => go("mcp")}
          >
            <path d="M9 2v6" />
            <path d="M15 2v6" />
            <path d="M6 8h12v4a6 6 0 0 1-12 0V8z" />
            <path d="M12 18v4" />
          </NavItem>
        </nav>

        <main className="min-w-0 flex-1">
          {/* Keyed on the page so the beat replays on every switch — the rail
              stays put and only the pane changes, so without it the swap is a
              hard cut with nothing saying which half moved. */}
          <div key={visiblePage} className="arrive">
            {visiblePage === "general" && <GeneralPane />}
            {visiblePage === "behavior" && <BehaviorPane />}
            {visiblePage === "schedules" && <SchedulesSection />}
            {visiblePage === "knowledge" && (
              /* The module sections carry their own mt-8 — flush the first. */
              <div className="[&>section:first-child]:mt-0">
                <InstructionsSection />
                <MemorySection />
              </div>
            )}
            {visiblePage === "skills" && (
              <div className="[&>section:first-child]:mt-0">
                <SkillsSection />
              </div>
            )}
            {visiblePage === "providers" && <ProvidersPane />}
            {visiblePage === "mcp" && <McpPane />}
          </div>
        </main>
      </div>
    </div>
  );
}
