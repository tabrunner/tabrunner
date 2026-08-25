import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/Button";
import { Switch } from "@/components/Switch";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { PencilIcon, TrashIcon } from "@/components/Icon";
import { useStoredItem } from "@/components/useStoredItem";
import { mcpServersItem } from "../config";
import { mcpStatusItem, deleteServer, setServerEnabled } from "../store";
import type { McpServerConfig } from "../types";
import { ServerDialog } from "./ServerDialog";

/**
 * Settings → MCP, the outbound half: remote servers whose tools join the
 * agent's toolkit during runs. The inbound bridge is rendered above this in
 * the same pane — one MCP page, two directions. Rows read their status from
 * the storage mirror, so what they show is what the last run or probe saw.
 */
export function McpServersSection() {
  const { t } = useTranslation();
  const servers = useStoredItem(mcpServersItem);
  const statuses = useStoredItem(mcpStatusItem);
  const [editor, setEditor] = useState<{ open: boolean; server?: McpServerConfig }>({
    open: false,
  });

  return (
    <section className="mt-8 border-t border-neutral-200 pt-6 dark:border-neutral-800">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h3 className="text-sm font-medium text-neutral-800 dark:text-neutral-200">
            {t("mcpOut.title")}
          </h3>
          <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">{t("mcpOut.help")}</p>
        </div>
        <Button variant="outline" size="sm" className="shrink-0" onClick={() => setEditor({ open: true })}>
          {t("mcpOut.add")}
        </Button>
      </div>

      {servers.length === 0 ? (
        <div className="mt-3 rounded-lg bg-neutral-50 px-3 py-3 dark:bg-neutral-900/50">
          <p className="text-xs text-neutral-500 dark:text-neutral-400">{t("mcpOut.empty")}</p>
        </div>
      ) : (
        <ul className="mt-3 space-y-1.5">
          {servers.map((server) => {
            const status = statuses[server.id];
            return (
              <li
                key={server.id}
                className="flex items-start justify-between gap-3 rounded-lg bg-neutral-50 px-3 py-2 dark:bg-neutral-900/50"
              >
                <div className={`min-w-0 flex-1 ${server.enabled ? "" : "opacity-50"}`}>
                  <p className="truncate text-sm font-semibold text-neutral-900 dark:text-neutral-100">
                    {server.name}
                  </p>
                  <p className="mt-0.5 truncate font-mono text-xs text-neutral-600 dark:text-neutral-300">
                    {server.url.replace(/^https?:\/\//, "")}
                  </p>
                  <p className="mt-1 flex items-center gap-1.5 text-[11px] text-neutral-500 dark:text-neutral-400">
                    <StatusTone ok={status?.ok} />
                    {status?.detail ?? t("mcpOut.statusNever")}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1 pt-0.5">
                  <Switch
                    checked={server.enabled}
                    onChange={(v) => void setServerEnabled(server.id, v)}
                    ariaLabel={t("mcpOut.enable")}
                    title={t("mcpOut.enable")}
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={t("mcpOut.edit")}
                    title={t("mcpOut.edit")}
                    onClick={() => setEditor({ open: true, server })}
                  >
                    <PencilIcon />
                  </Button>
                  <ConfirmDialog
                    trigger={
                      <Button
                        variant="ghost-danger"
                        size="sm"
                        aria-label={t("mcpOut.delete")}
                        title={t("mcpOut.delete")}
                      >
                        <TrashIcon />
                      </Button>
                    }
                    title={t("mcpOut.deleteTitle", { name: server.name })}
                    description={t("mcpOut.deleteDescription")}
                    onConfirm={() => void deleteServer(server.id)}
                  />
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {/* Mounted only while open — the form state must reset between opens,
          same contract as every other add/edit dialog here. */}
      {editor.open && (
        <ServerDialog
          open
          {...(editor.server ? { server: editor.server } : {})}
          onClose={() => setEditor({ open: false })}
        />
      )}
    </section>
  );
}

/** The dot only — the row's text line carries the detail next to it. Same dot
    language as the strip's StatusDot: brand green for ok, red for down. */
function StatusTone({ ok }: { ok: boolean | undefined }) {
  const color =
    ok === undefined ? "bg-neutral-300 dark:bg-neutral-600" : ok ? "bg-brand-500" : "bg-red-400";
  return <span className={`inline-block h-1.5 w-1.5 rounded-full ${color}`} aria-hidden />;
}
