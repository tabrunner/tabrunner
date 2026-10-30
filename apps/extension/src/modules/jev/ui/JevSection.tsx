import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { ProviderError } from "@providerkit/core";
import type { DecisionHost, DecisionModel } from "@providerkit/core/decisions";
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
import {
  JEV_HOSTS,
  JEV_HOST_IDS,
  OPENCODE_JEV_MODELS,
  OPENROUTER_FALLBACK_DECISION_MODELS,
  listOpenRouterExecutorModels,
  openRouterBalance,
} from "../hosts";
import type { OpenCodeJevModel } from "../hosts";
import {
  activeJevEntry,
  isJevEntryReady,
  isKeylessJev,
  jevSettingsItem,
  removeJevKey,
  saveJevKey,
  setActiveJev,
  setJevEnabled,
} from "../settings";
import type { JevEntry } from "../settings";

/** A key check that never answers must not strand the button. */
const KEY_CHECK_TIMEOUT_MS = 10_000;

/** A failed key check, in words that say what to fix. */
function checkError(e: unknown, host: DecisionHost): string {
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

function entryHostLabel(entry: JevEntry): string {
  if (entry.host === "opencode") {
    return `${JEV_HOSTS.opencode.label} · ${entry.model ?? "jev-1.13-free"}`;
  }
  if (entry.host === "openrouter" && entry.model) {
    return `${JEV_HOSTS.openrouter.label} · ${entry.model}`;
  }
  return JEV_HOSTS[entry.host].label;
}

function entryTitle(entry: JevEntry, ready: boolean, usesConnectedProvider: boolean): string {
  const host = entryHostLabel(entry);
  if (!ready) {
    return i18n.t("settings.jev.savedMissingProvider", { host });
  }
  if (entry.apiKey) {
    return i18n.t("settings.jev.savedAs", { host, last4: entry.apiKey.slice(-4) });
  }
  if (usesConnectedProvider) {
    return i18n.t("settings.jev.savedProviderAuth", { host });
  }
  return i18n.t("settings.jev.savedFree", { host });
}

function keyFieldLabel(host: DecisionHost, keyOptional: boolean): string {
  if (host === "cloudflare") return i18n.t("settings.jev.token");
  if (keyOptional) return i18n.t("settings.jev.keyOptional");
  return i18n.t("settings.jev.key");
}

function submitButtonLabel(checking: boolean, keyOptional: boolean, apiKey: string): string {
  if (checking) return i18n.t("settings.jev.checking");
  if (keyOptional && !apiKey.trim()) return i18n.t("settings.jev.saveFree");
  return i18n.t("settings.jev.save");
}

/**
 * Jev's setup under the provider list: saved decision options (with active
 * selection like normal providers), the switch, spend, and the form to add or
 * update a decision host/model.
 */
export function JevSection() {
  const { t } = useTranslation();
  const saved = useStoredItem(jevSettingsItem);
  const active = activeJevEntry(saved);
  const openRouterProvider = useProvidersStore((s) =>
    s.providers.find((p) => p.id === "openrouter"),
  );
  const openCodeProvider = useProvidersStore((s) => s.providers.find((p) => p.id === "opencode"));
  const openRouterKey = openRouterProvider?.apiKey;
  const openCodeKey = openCodeProvider?.apiKey;
  const openRouterConnected = Boolean(openRouterProvider?.apiKey || openRouterProvider?.auth);
  const openCodeConnected = Boolean(openCodeProvider?.apiKey || openCodeProvider?.auth);

  const [editing, setEditing] = useState(false);
  const [host, setHost] = useState<DecisionHost>(active?.host ?? "opencode");
  const [openCodeModel, setOpenCodeModel] = useState<OpenCodeJevModel>(
    active?.host === "opencode" && active.model === "jev-1.13" ? "jev-1.13" : "jev-1.13-free",
  );
  const [openRouterModels, setOpenRouterModels] = useState<readonly DecisionModel[]>(
    OPENROUTER_FALLBACK_DECISION_MODELS,
  );
  const [openRouterModel, setOpenRouterModel] = useState<string>(
    active?.host === "openrouter" && active.model
      ? active.model
      : OPENROUTER_FALLBACK_DECISION_MODELS[0]!.id,
  );
  const [apiKey, setApiKey] = useState("");
  const [accountId, setAccountId] = useState(active?.accountId ?? "");
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [balance, setBalance] = useState<number | undefined>();

  const openRouterSavedKey =
    saved?.entries.find((e) => e.host === "openrouter" && e.apiKey)?.apiKey || openRouterKey;
  useEffect(() => {
    if (!openRouterSavedKey) return;
    let live = true;
    void openRouterBalance(openRouterSavedKey).then((b) => live && setBalance(b));
    return () => {
      live = false;
    };
  }, [openRouterSavedKey]);

  const showForm = !saved || editing;
  useEffect(() => {
    if (!showForm || host !== "openrouter") return;
    let live = true;
    void listOpenRouterExecutorModels(apiKey.trim() || openRouterSavedKey).then((models) => {
      if (!live) return;
      setOpenRouterModels(models);
      setOpenRouterModel((prev) =>
        models.some((m) => m.id === prev) ? prev : (models[0]?.id ?? prev),
      );
    });
    return () => {
      live = false;
    };
  }, [showForm, host, apiKey, openRouterSavedKey]);

  const info = JEV_HOSTS[host];
  const effectiveModel =
    host === "opencode" ? openCodeModel : host === "openrouter" ? openRouterModel : undefined;
  const keyless = isKeylessJev({ host, ...(effectiveModel ? { model: effectiveModel } : {}) });
  const providerConnected =
    (host === "opencode" && openCodeConnected) || (host === "openrouter" && openRouterConnected);
  const keyOptional = keyless || providerConnected;

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const key = apiKey.trim();
    if (!key && !keyOptional) return setError(t("settings.jev.error.missingKey"));
    if (host === "cloudflare" && !accountId.trim()) {
      return setError(t("settings.jev.error.missingAccount"));
    }
    setError(null);
    setChecking(true);
    try {
      await saveJevKey(
        {
          host,
          ...(key ? { apiKey: key } : {}),
          ...(host === "cloudflare" ? { accountId: accountId.trim() } : {}),
          ...(effectiveModel ? { model: effectiveModel } : {}),
        },
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
          <div className="flex shrink-0 items-center gap-3">
            {!showForm && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setApiKey("");
                  setError(null);
                  setEditing(true);
                }}
              >
                {t("settings.jev.add")}
              </Button>
            )}
            <Switch
              checked={saved.enabled}
              onChange={(v) => void setJevEnabled(v)}
              ariaLabel={t("settings.jev.enable")}
            />
          </div>
        )}
      </div>

      {saved && (
        <ul className="arrive mt-3 flex flex-col gap-2">
          {saved.entries.map((entry) => {
            const isActive = entry.id === saved.activeId;
            const ready = isJevEntryReady(entry, {
              opencode: openCodeConnected,
              openrouter: openRouterConnected,
            });
            const usesConnectedProvider =
              !entry.apiKey &&
              ((entry.host === "opencode" && openCodeConnected) ||
                (entry.host === "openrouter" && openRouterConnected));
            const titleText = entryTitle(entry, ready, usesConnectedProvider);

            return (
              <li
                key={entry.id}
                className={`flex items-center justify-between gap-3 rounded-lg border px-3 py-2.5 text-sm ${
                  isActive
                    ? "border-brand-500 bg-brand-50 dark:bg-brand-950"
                    : "border-neutral-200 dark:border-neutral-800"
                }`}
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5 font-medium text-neutral-800 dark:text-neutral-200">
                    <span className="truncate">{titleText}</span>
                    {isActive && (
                      <span className="shrink-0 rounded border border-brand-200 bg-white px-1.5 py-px text-[10px] font-medium text-brand-700 dark:border-brand-800 dark:bg-neutral-900 dark:text-brand-300">
                        {t("providerList.active")}
                      </span>
                    )}
                  </div>
                  <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
                    <span className="telemetry">
                      {t("settings.jev.spent", { cost: formatMoney(entry.spent) })}
                    </span>
                    {entry.host === "openrouter" && balance !== undefined && (
                      <>
                        {" · "}
                        <span className="telemetry">
                          {t("settings.jev.balance", { cost: formatMoney(balance) })}
                        </span>
                      </>
                    )}
                    {" · "}
                    <a
                      href={JEV_HOSTS[entry.host].usageUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="text-brand-600 hover:underline dark:text-brand-400"
                    >
                      {t("settings.jev.usageLink", { host: JEV_HOSTS[entry.host].label })}
                    </a>
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {!isActive && ready && (
                    <Button variant="ghost" size="sm" onClick={() => void setActiveJev(entry.id)}>
                      {t("providerList.setActive")}
                    </Button>
                  )}
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setHost(entry.host);
                      if (entry.host === "opencode") {
                        setOpenCodeModel(entry.model === "jev-1.13" ? "jev-1.13" : "jev-1.13-free");
                      } else if (entry.host === "openrouter" && entry.model) {
                        setOpenRouterModel(entry.model);
                      }
                      setAccountId(entry.accountId ?? "");
                      setApiKey("");
                      setError(null);
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
                    onConfirm={() => void removeJevKey(entry.id)}
                  />
                </div>
              </li>
            );
          })}
        </ul>
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
          {host === "opencode" && (
            <Select
              label={t("settings.jev.model")}
              value={openCodeModel}
              onChange={(v) => {
                const next = OPENCODE_JEV_MODELS.find((m) => m === v);
                if (next) setOpenCodeModel(next);
                setError(null);
              }}
              options={OPENCODE_JEV_MODELS.map((m) => ({
                value: m,
                label: m === "jev-1.13-free" ? t("settings.jev.modelFree") : m,
              }))}
            />
          )}
          {host === "openrouter" && (
            <Select
              label={t("settings.jev.model")}
              value={openRouterModel}
              onChange={(v) => {
                setOpenRouterModel(v);
                setError(null);
              }}
              options={openRouterModels.map((m) => ({
                value: m.id,
                label: m.name ? `${m.name} (${m.id})` : m.id,
              }))}
            />
          )}
          <PasswordField
            label={keyFieldLabel(host, keyOptional)}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            autoComplete="off"
            hint={
              providerConnected && !apiKey ? (
                <span>{t("settings.jev.usingConnectedProvider", { host: info.label })}</span>
              ) : keyless && !apiKey ? (
                <span>{t("settings.jev.freeNoKeyHint")}</span>
              ) : (
                <a
                  className="text-brand-600 hover:underline dark:text-brand-400"
                  href={info.keyUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  {t("settings.jev.keyGet", { host: info.label })}
                </a>
              )
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
          {host === "opencode" && openCodeKey && !apiKey && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="self-start"
              onClick={() => setApiKey(openCodeKey)}
            >
              {t("settings.jev.useOpenCode")}
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
              {submitButtonLabel(checking, keyOptional, apiKey)}
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
