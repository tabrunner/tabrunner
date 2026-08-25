import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/Button";
import { TextField } from "@/components/TextField";
import { Icon, XIcon } from "@/components/Icon";
import { TitledDialog } from "@/components/TitledDialog";
import type { McpServerConfig } from "../types";
import { saveServer } from "../store";
import { probeServer } from "../run";

/** Used only here — stays local, per Icon.tsx's rule. */
function PlusIcon() {
  return (
    <Icon>
      <path d="M12 5v14M5 12h14" />
    </Icon>
  );
}

interface HeaderRow {
  name: string;
  value: string;
}

/**
 * Add/Edit for one remote MCP server. Test connection runs the same
 * initialize/list/close a run's snapshot will — what it reports is what the
 * run would see, not a friendlier lie.
 */
export function ServerDialog({
  open,
  server,
  onClose,
}: {
  open: boolean;
  /** Present = edit; absent = create. */
  server?: McpServerConfig;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(server?.name ?? "");
  const [url, setUrl] = useState(server?.url ?? "");
  const [headers, setHeaders] = useState<HeaderRow[]>(() =>
    Object.entries(server?.headers ?? {}).map(([k, v]) => ({ name: k, value: v })),
  );
  const [error, setError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: true; count: number } | { ok: false; error: string } | null>(
    null,
  );

  const buildHeaders = (): Record<string, string> | undefined => {
    const rows = headers.filter((h) => h.name.trim() !== "");
    if (rows.length === 0) return undefined;
    return Object.fromEntries(rows.map((h) => [h.name.trim(), h.value]));
  };

  const test = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await probeServer({ url: url.trim(), headers: buildHeaders() });
      setTestResult(result);
    } finally {
      setTesting(false);
    }
  };

  const save = async () => {
    const result = await saveServer({
      ...(server ? { id: server.id } : {}),
      name,
      url,
      headers: buildHeaders(),
      enabled: server?.enabled ?? true,
    });
    if (result.ok) {
      onClose();
      return;
    }
    setError(result.error);
  };

  return (
    <TitledDialog
      open={open}
      onOpenChange={(next) => !next && onClose()}
      title={server ? t("mcpOut.editTitle", { name: server.name }) : t("mcpOut.newTitle")}
      description={t("mcpOut.dialogHelp")}
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <TextField
          label={t("mcpOut.nameLabel")}
          hint={t("mcpOut.nameHint")}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="aboard"
          spellCheck={false}
          autoFocus
        />
        <TextField
          label={t("mcpOut.urlLabel")}
          hint={t("mcpOut.urlHint")}
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://api.example.com/mcp"
          spellCheck={false}
        />

        <div>
          <p className="text-xs font-medium text-neutral-700 dark:text-neutral-300">
            {t("mcpOut.headersTitle")}
          </p>
          <p className="mt-0.5 text-[11px] text-neutral-500 dark:text-neutral-400">
            {t("mcpOut.headersHint")}
          </p>
          <div className="mt-1.5 flex flex-col gap-1.5">
            {headers.map((row, i) => (
              <div key={i} className="flex items-center gap-1.5">
                <input
                  className="w-2/5 rounded-md border border-neutral-200 bg-white px-2 py-1.5 font-mono text-xs text-neutral-800 focus:border-brand-500 focus:outline-none dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200"
                  value={row.name}
                  onChange={(e) =>
                    setHeaders(headers.with(i, { ...row, name: e.target.value }))
                  }
                  placeholder={i === 0 ? "Authorization" : ""}
                  spellCheck={false}
                  aria-label={t("mcpOut.headerName")}
                />
                <input
                  className="min-w-0 flex-1 rounded-md border border-neutral-200 bg-white px-2 py-1.5 font-mono text-xs text-neutral-800 focus:border-brand-500 focus:outline-none dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200"
                  value={row.value}
                  onChange={(e) =>
                    setHeaders(headers.with(i, { ...row, value: e.target.value }))
                  }
                  placeholder="Bearer …"
                  type="password"
                  aria-label={t("mcpOut.headerValue")}
                />
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={t("common.remove")}
                  onClick={() => setHeaders(headers.filter((_, j) => j !== i))}
                >
                  <XIcon />
                </Button>
              </div>
            ))}
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="mt-1 -ml-1.5"
            onClick={() => setHeaders([...headers, { name: "", value: "" }])}
          >
            <PlusIcon /> {t("mcpOut.addHeader")}
          </Button>
        </div>

        {testResult && (
          <p className="arrive text-xs" role="status">
            {testResult.ok ? (
              <span className="text-emerald-700 dark:text-emerald-400">
                ✓ {t("mcpOut.testOk", { count: testResult.count })}
              </span>
            ) : (
              <span className="block text-red-600 dark:text-red-400">
                {t("mcpOut.testFailed")} — <span className="opacity-75">{testResult.error}</span>
              </span>
            )}
          </p>
        )}
        {error && (
          <p className="arrive text-xs text-red-600 dark:text-red-400" role="alert">
            {error}
          </p>
        )}

        <div className="mt-1 flex items-center justify-between gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={!url.trim() || testing}
            onClick={() => void test()}
          >
            {testing ? t("mcpOut.testing") : t("mcpOut.test")}
          </Button>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={onClose}>
              {t("common.cancel")}
            </Button>
            <Button size="sm" disabled={!name.trim() || !url.trim()} type="submit">
              {t("mcpOut.save")}
            </Button>
          </div>
        </div>
      </form>
    </TitledDialog>
  );
}
