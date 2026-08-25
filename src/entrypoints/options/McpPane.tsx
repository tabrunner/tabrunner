import { useState } from "react";
import { useTranslation } from "react-i18next";
import { bridgeConnected, bridgeItem, validBridgePort } from "@/modules/bridge/config";
import { McpServersSection } from "@/modules/mcp/ui/McpServersSection";
import { Button } from "@/components/Button";
import { Switch } from "@/components/Switch";
import { TextField } from "@/components/TextField";
import { useStoredItem } from "@/components/useStoredItem";
import { LINKS } from "@/lib/links";
import { StatusDot } from "./StatusStrip";

/**
 * The whole setup, paste-ready: fetch the single-file daemon to a conventional
 * home, then register it. No placeholders — the release alias is stable and
 * `~/.tabrunner-mcp.js` is a path we chose, so the command runs as copied.
 * (bun runs the file as-is; the daemon's own id check defaults to the release
 * build's extension id, so no env var is needed here.)
 */
const SETUP_COMMANDS = `curl -fsSL ${LINKS.mcpDaemon} -o ~/.tabrunner-mcp.js
claude mcp add tabrunner -- bun ~/.tabrunner-mcp.js`;

/** Copy with a moment of confirmation, then back to a quiet button. */
function CopyButton({ text }: { text: string }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant="outline"
      size="sm"
      className="shrink-0"
      onClick={() => {
        void navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied ? (
        // inline-block, or the rise half of `arrive` is dropped — inline boxes
        // aren't transformable.
        <span className="arrive inline-block">{t("settings.mcp.copied")}</span>
      ) : (
        t("settings.mcp.copy")
      )}
    </Button>
  );
}

/**
 * The bridge's knobs and its live link state, plus the one command a new MCP
 * client needs. Everything reads and writes the same `bridge` storage item the
 * worker's socket reconciles on, so a port change here reconnects on its own.
 */
export function McpPane() {
  const { t } = useTranslation();
  const bridge = useStoredItem(bridgeItem);
  const connected = useStoredItem(bridgeConnected);
  // Edited locally, persisted on blur — a half-typed port must never reach the
  // socket (same contract as the fallback start URL).
  const [port, setPort] = useState<string | null>(null);
  const [portError, setPortError] = useState(false);
  const portValue = port ?? String(bridge.port);

  const commitPort = () => {
    const value = Number(portValue.trim());
    if (validBridgePort(value)) {
      setPortError(false);
      void bridgeItem.set({ ...bridge, port: value });
      setPort(null);
    } else {
      setPortError(true);
    }
  };

  return (
    <section>
      <h2 className="text-base font-semibold text-neutral-900 dark:text-neutral-100">
        {t("settings.mcp.title")}
      </h2>
      <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
        {t("settings.mcp.help")}
      </p>
      {/* The whole page, orientated before any knob: MCP is two directions, and
          this pane carries both. The full manual stays one link away. */}
      <details className="mt-3 rounded-lg bg-neutral-50 px-3 py-2 dark:bg-neutral-900/50">
        <summary className="cursor-pointer select-none text-xs font-medium text-brand-700 hover:underline dark:text-brand-400">
          {t("settings.mcp.guideTitle")}
        </summary>
        <div className="mt-2 flex flex-col gap-2 text-xs leading-relaxed text-neutral-600 dark:text-neutral-300">
          <p>{t("settings.mcp.guideIn")}</p>
          <p>{t("settings.mcp.guideOut")}</p>
          <p>{t("settings.mcp.guideQuestions")}</p>
          <p>
            <a
              href={LINKS.mcpDocs}
              target="_blank"
              rel="noreferrer"
              className="text-brand-600 hover:underline dark:text-brand-400"
            >
              {t("settings.mcp.docsLink")}
            </a>
          </p>
        </div>
      </details>

      <div className="mt-4 flex items-start justify-between gap-4">
        <div>
          <div className="text-sm font-medium text-neutral-800 dark:text-neutral-200">
            {t("settings.mcp.enable")}
          </div>
          <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
            {t("settings.mcp.enableHint")}
          </p>
        </div>
        <Switch
          checked={bridge.enabled}
          onChange={(v) => void bridgeItem.set({ ...bridge, enabled: v })}
          ariaLabel={t("settings.mcp.enable")}
        />
      </div>

      {/* The page's biggest collapse — everything below the switch appears at
          once, so it arrives instead of materializing. */}
      {bridge.enabled && (
        <div className="arrive">
          <div className="mt-4 max-w-40">
            <TextField
              label={t("settings.mcp.port")}
              hint={
                portError ? (
                  <span className="arrive block text-red-600 dark:text-red-400">
                    {t("settings.mcp.invalidPort")}
                  </span>
                ) : (
                  t("settings.mcp.portHint")
                )
              }
              value={portValue}
              onChange={(e) => {
                setPort(e.target.value);
                if (portError) setPortError(false);
              }}
              onBlur={commitPort}
              placeholder={String(bridgeItem.fallback.port)}
              inputMode="numeric"
              spellCheck={false}
              aria-invalid={portError || undefined}
            />
          </div>

          <p className="mt-4 flex items-center gap-1.5 text-xs text-neutral-600 dark:text-neutral-400">
            <StatusDot tone={connected ? "ok" : "waiting"} />
            {connected ? t("settings.mcp.statusConnected") : t("settings.mcp.statusWaiting")}
          </p>

          <h3 className="mt-6 text-sm font-medium text-neutral-800 dark:text-neutral-200">
            {t("settings.mcp.setupTitle")}
          </h3>
          <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
            {t("settings.mcp.setupHelp")}
          </p>
          <div className="mt-2 flex items-center gap-2 rounded-lg bg-neutral-50 px-3 py-2 dark:bg-neutral-900/50">
            <code className="min-w-0 flex-1 overflow-x-auto font-mono text-xs whitespace-pre text-neutral-800 dark:text-neutral-200">
              {SETUP_COMMANDS}
            </code>
            <CopyButton text={SETUP_COMMANDS} />
          </div>
          <p className="mt-2 text-xs">
            <a
              href={LINKS.mcpDocs}
              target="_blank"
              rel="noreferrer"
              className="text-brand-600 hover:underline dark:text-brand-400"
            >
              {t("settings.mcp.docsLink")}
            </a>
          </p>

          <div className="mt-4 flex items-center justify-between gap-4">
            <div className="min-w-0">
              <div className="text-sm font-medium text-neutral-800 dark:text-neutral-200">
                {t("settings.mcp.extensionId")}
              </div>
              <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
                {t("settings.mcp.extensionIdHint")}
              </p>
            </div>
            <code className="shrink-0 rounded-md bg-neutral-50 px-2 py-1 font-mono text-xs text-neutral-700 dark:bg-neutral-900/50 dark:text-neutral-300">
              {chrome.runtime.id}
            </code>
          </div>
        </div>
      )}

      {/* The outbound half of MCP lives on this same page: clients dial IN above
          (through the daemon), our agent dials OUT below. */}
      <McpServersSection />
    </section>
  );
}
