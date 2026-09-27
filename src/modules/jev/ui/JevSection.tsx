import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { ProviderError } from "@providerkit/core";
import { useProvidersStore } from "@/modules/providers/ui";
import { Button } from "@/components/Button";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { PasswordField } from "@/components/PasswordField";
import { Select } from "@/components/Select";
import { Switch } from "@/components/Switch";
import { TextField } from "@/components/TextField";
import { useStoredItem } from "@/components/useStoredItem";
import { i18n } from "@/i18n";
import { formatMoney } from "@/lib/format";
import type { JevHost } from "@providerkit/core/jev";
import { JEV_HOSTS, JEV_HOST_IDS, openRouterBalance } from "../hosts";
import { jevSettingsItem, removeJevKey, saveJevKey, setJevEnabled } from "../settings";

/** A key check that never answers must not strand the button. */
const KEY_CHECK_TIMEOUT_MS = 10_000;

/** A failed key check, in words that say what to fix. */
function checkError(e: unknown, host: JevHost): string {
  const name = JEV_HOSTS[host].label;
  // Our own 10 s cap aborts the check with a bare TimeoutError, not a ProviderError.
  const timedOut = e instanceof Error && e.name === "TimeoutError";
  const kind = e instanceof ProviderError ? e.kind : timedOut ? "timeout" : undefined;
  if (kind === "auth") {
    return host === "cloudflare"
      ? i18n.t("settings.jev.error.authCloudflare")
      : i18n.t("settings.jev.error.auth", { host: name });
  }
  if (kind === "quota") return i18n.t("settings.jev.error.quota", { host: name });
  if (kind === "rate" || kind === "overload")
    return i18n.t("settings.jev.error.busy", { host: name });
  if (kind === "network" || kind === "timeout" || kind === "aborted") {
    return i18n.t("settings.jev.error.network", { host: name });
  }
  return i18n.t("settings.jev.error.other", {
    host: name,
    detail: e instanceof Error ? e.message : String(e),
  });
}

/**
 * Jev's whole setup, under the provider list: where it runs, the key, and —
 * once a key checks out — the switch, what it has spent, and the way out. The
 * key is checked before it is saved, and saving it turns Jev on.
 */
export function JevSection() {
  const { t } = useTranslation();
  const saved = useStoredItem(jevSettingsItem);
  const openRouterKey = useProvidersStore(
    (s) => s.providers.find((p) => p.id === "openrouter")?.apiKey,
  );
  const [editing, setEditing] = useState(false);
  const [host, setHost] = useState<JevHost>(saved?.host ?? "typesafe");
  const [apiKey, setApiKey] = useState("");
  const [accountId, setAccountId] = useState(saved?.accountId ?? "");
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [balance, setBalance] = useState<number | undefined>();

  const savedHost = saved?.host;
  const savedKey = saved?.apiKey;
  useEffect(() => {
    if (savedHost !== "openrouter" || !savedKey) return;
    let live = true;
    void openRouterBalance(savedKey).then((b) => live && setBalance(b));
    return () => {
      live = false;
    };
  }, [savedHost, savedKey]);

  const info = JEV_HOSTS[host];
  const showForm = !saved || editing;

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const key = apiKey.trim();
    if (!key) return setError(t("settings.jev.error.missingKey"));
    if (host === "cloudflare" && !accountId.trim()) {
      return setError(t("settings.jev.error.missingAccount"));
    }
    setError(null);
    setChecking(true);
    try {
      await saveJevKey(
        { host, apiKey: key, ...(host === "cloudflare" ? { accountId: accountId.trim() } : {}) },
        AbortSignal.timeout(KEY_CHECK_TIMEOUT_MS),
      );
      setApiKey("");
      setEditing(false);
    } catch (err) {
      setError(checkError(err, host));
    } finally {
      setChecking(false);
    }
  };

  return (
    <section className="mt-8">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold text-neutral-900 dark:text-neutral-100">
            {t("settings.jev.title")}
          </h2>
          <p className="mt-1 max-w-prose text-xs text-neutral-500 dark:text-neutral-400">
            {t("settings.jev.help")}
          </p>
        </div>
        {saved && (
          <Switch
            checked={saved.enabled}
            onChange={(v) => void setJevEnabled(v)}
            ariaLabel={t("settings.jev.enable")}
          />
        )}
      </div>

      {saved && !editing && (
        <div className="arrive mt-3 rounded-lg border border-neutral-200 px-3 py-2.5 text-sm dark:border-neutral-800">
          <div className="text-neutral-800 dark:text-neutral-200">
            {t("settings.jev.savedAs", {
              host: JEV_HOSTS[saved.host].label,
              last4: saved.apiKey.slice(-4),
            })}
          </div>
          <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
            <span className="telemetry">
              {t("settings.jev.spent", { cost: formatMoney(saved.spent) })}
            </span>
            {balance !== undefined && (
              <>
                {" · "}
                <span className="telemetry">
                  {t("settings.jev.balance", { cost: formatMoney(balance) })}
                </span>
              </>
            )}
            {" · "}
            <a
              href={JEV_HOSTS[saved.host].usageUrl}
              target="_blank"
              rel="noreferrer"
              className="text-brand-600 hover:underline dark:text-brand-400"
            >
              {t("settings.jev.usageLink", { host: JEV_HOSTS[saved.host].label })}
            </a>
          </p>
          <div className="mt-2 flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setHost(saved.host);
                setAccountId(saved.accountId ?? "");
                setEditing(true);
              }}
            >
              {t("settings.jev.change")}
            </Button>
            <ConfirmDialog
              trigger={
                <Button variant="ghost" size="sm">
                  {t("settings.jev.remove")}
                </Button>
              }
              title={t("settings.jev.removeTitle")}
              description={t("settings.jev.removeBody")}
              onConfirm={() => void removeJevKey()}
            />
          </div>
        </div>
      )}

      {showForm && (
        <form onSubmit={onSubmit} className="arrive mt-3 flex max-w-md flex-col gap-3">
          <Select
            label={t("settings.jev.host")}
            value={host}
            onChange={(v) => {
              const next = JEV_HOST_IDS.find((id) => id === v);
              if (next) setHost(next);
              setError(null);
            }}
            options={JEV_HOST_IDS.map((id) => ({ value: id, label: JEV_HOSTS[id].label }))}
          />
          <PasswordField
            label={host === "cloudflare" ? t("settings.jev.token") : t("settings.jev.key")}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            autoComplete="off"
            hint={
              <a
                className="text-brand-600 hover:underline dark:text-brand-400"
                href={info.keyUrl}
                target="_blank"
                rel="noreferrer"
              >
                {t("settings.jev.keyGet", { host: info.label })}
              </a>
            }
          />
          {host === "openrouter" && openRouterKey && !apiKey && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="self-start"
              onClick={() => setApiKey(openRouterKey)}
            >
              {t("settings.jev.useOpenRouter")}
            </Button>
          )}
          {host === "cloudflare" && (
            <TextField
              label={t("settings.jev.accountId")}
              hint={t("settings.jev.accountIdHint")}
              value={accountId}
              onChange={(e) => setAccountId(e.target.value)}
              spellCheck={false}
            />
          )}
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            {t(`settings.jev.privacy.${host}`)}
          </p>
          {error && (
            <div
              role="alert"
              className="arrive rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200"
            >
              {error}
            </div>
          )}
          <div className="flex gap-2">
            <Button type="submit" disabled={checking}>
              {checking ? t("settings.jev.checking") : t("settings.jev.save")}
            </Button>
            {editing && (
              <Button type="button" variant="ghost" onClick={() => setEditing(false)}>
                {t("common.cancel")}
              </Button>
            )}
          </div>
        </form>
      )}
    </section>
  );
}
