import { useState } from "react";
import type { FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { useProvidersStore } from "./store";
import { ProviderIcon } from "./ProviderIcon";
import { OAuthSignIn, SIGN_IN_DONE_MS } from "./OAuthSignIn";
import { PRESETS, presetSection, providerName, type PresetSection } from "../presets";
import { checkCredential, modelsTarget, writeModelsCache } from "../models";
import { splitErrorDetail } from "@/modules/conversation/error-detail";
import { isChatProviderSupported } from "../status";
import type { ProviderConfig, ProviderShape } from "../types";
import { OPENCODE_PUBLIC_API_KEY } from "@providerkit/core";
import type { Credential } from "@providerkit/core/auth";
import { Select } from "@/components/Select";
import { TextField } from "@/components/TextField";
import { PasswordField } from "@/components/PasswordField";
import { Button } from "@/components/Button";

const CUSTOM = "custom";

/** Cap on the add-time key check — an endpoint that never answers must not strand the button. */
const KEY_CHECK_TIMEOUT_MS = 8000;

function isLocalUrl(url: string): boolean {
  try {
    const { hostname } = new URL(url);
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
  } catch {
    return false;
  }
}

/**
 * Add-provider form — credentials only. Model and reasoning effort are
 * per-task choices made in the side panel, where the stored key lets us
 * list the endpoint's live models; they don't belong at setup time.
 *
 * A pasted key is spent once before it's stored, on a model listing: a key the
 * endpoint refuses is caught here rather than halfway through a task. OAuth
 * presets save on sign-in itself — approving the vendor page writes the
 * provider (re-signing-in on the edit path refreshes the credential), so the
 * OAuth path has no submit button.
 *
 * Picking an already-configured preset is the edit path: the CTA becomes
 * "Update …", model/effort choices are preserved, and an empty key keeps
 * the saved one (key rotation = paste a new one). Pass `initialProvider` to
 * open the form straight onto that provider's edit path — custom endpoints
 * included (they update in place instead of adding a duplicate).
 */
export function ProviderForm({
  onSaved,
  initialProvider,
}: {
  onSaved?: (id: string) => void;
  initialProvider?: ProviderConfig;
}) {
  const { t } = useTranslation();
  const add = useProvidersStore((s) => s.add);
  const providers = useProvidersStore((s) => s.providers);
  const unavailable =
    initialProvider && !isChatProviderSupported(initialProvider) ? initialProvider : undefined;
  const editable = unavailable ? undefined : initialProvider;
  const initialPreset = editable ? PRESETS.find((p) => p.id === editable.id) : undefined;
  const [presetId, setPresetId] = useState(
    editable
      ? (initialPreset?.id ?? CUSTOM)
      : (PRESETS.find(isChatProviderSupported)?.id ?? CUSTOM),
  );
  const [name, setName] = useState(editable && !initialPreset ? editable.name : "");
  const [shape, setShape] = useState<ProviderShape>(editable?.shape ?? "openai");
  const [baseUrl, setBaseUrl] = useState(editable && !initialPreset ? editable.baseUrl : "");
  const [apiKey, setApiKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"checking" | "saving" | null>(null);

  const preset = presetId === CUSTOM ? undefined : PRESETS.find((p) => p.id === presetId);
  const existing = providers.find((p) => p.id === (preset ? preset.id : editable?.id));
  const isOAuth = preset?.auth === "oauth";
  const auth = existing?.auth;
  const freeAccess =
    preset?.free &&
    !auth &&
    !apiKey.trim() &&
    (!existing?.apiKey || existing.apiKey === OPENCODE_PUBLIC_API_KEY);

  const fail = (message: string) => setError(message);

  /**
   * Write the provider row. Throws — the sign-in card and the submit button
   * each word their own failure.
   */
  const save = async (authOverride?: Credential): Promise<string> => {
    const nextAuth = authOverride ?? (apiKey.trim() ? undefined : auth);
    return add({
      // Unseeded custom → undefined → the store assigns custom-<ts>.
      id: preset?.id ?? existing?.id,
      name: preset ? preset.name : name.trim(),
      shape: preset ? preset.shape : shape,
      baseUrl: preset ? preset.baseUrl : baseUrl.trim(),
      apiKey:
        apiKey.trim() ||
        existing?.apiKey ||
        (preset?.free && !nextAuth ? OPENCODE_PUBLIC_API_KEY : ""),
      ...(nextAuth ? { auth: nextAuth } : {}),
      // Not asked at setup — preserved across an update, picked per task in the panel.
      model: existing?.model,
      reasoningEffort: existing?.reasoningEffort,
    });
  };

  /**
   * Write the row a sign-in produced, then let the "connected" card have its
   * moment before the dialog closes over it. Shared by both sign-in paths —
   * the subscription rows, and the keyed row that can mint its own key.
   */
  const finishSignIn = async (credential: Credential) => {
    const id = await save(credential);
    setTimeout(() => onSaved?.(id), SIGN_IN_DONE_MS);
  };

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);

    // OAuth providers save from the sign-in card itself — the submit button
    // isn't rendered on their path, so this never runs for them.
    if (isOAuth) return;

    const resolvedName = preset ? preset.name : name.trim();
    const resolvedUrl = preset ? preset.baseUrl : baseUrl.trim();
    const checkedAuth = apiKey.trim() ? undefined : auth;
    const key =
      apiKey.trim() ||
      existing?.apiKey ||
      (preset?.free && !checkedAuth ? OPENCODE_PUBLIC_API_KEY : "");

    if (!preset && !resolvedName) {
      fail(t("providerForm.nameRequired"));
      return;
    }
    if (!preset && !resolvedUrl) {
      fail(t("providerForm.baseUrlRequired"));
      return;
    }
    if (!preset) {
      try {
        new URL(resolvedUrl);
      } catch {
        fail(t("providerForm.baseUrlInvalid"));
        return;
      }
    }
    if (!key && !existing && !isLocalUrl(resolvedUrl)) {
      fail(t("providerForm.apiKeyRequired"));
      return;
    }

    try {
      // A key the endpoint refuses would otherwise only surface mid-task, so
      // it's spent here instead — one listing call, and only a flat rejection
      // stops the save. A successful listing also warms the picker's cache, so
      // the panel opens on the live shelf instead of the preset fallback.
      setBusy("checking");
      const target = {
        ...(preset?.id ? { id: preset.id } : {}),
        shape: preset ? preset.shape : shape,
        baseUrl: checkedAuth?.baseUrl ?? resolvedUrl,
        apiKey: checkedAuth?.accessToken ?? key,
        ...(checkedAuth ? { auth: checkedAuth } : {}),
      };
      const checked = await checkCredential(target, AbortSignal.timeout(KEY_CHECK_TIMEOUT_MS));
      if (checked.rejected) {
        // Bare name: the sentence is about a key, so "(API key)" would say it twice.
        fail(t("providerForm.keyRejected", { name: resolvedName }));
        return;
      }
      setBusy("saving");
      const id = await save();
      if (checked.models.length > 0) {
        // Same target shape the picker lists with (see modelsTarget), so the
        // warmed entry is found, not orphaned. Custom rows learn their id at
        // save time, which is why this lands after, not before.
        writeModelsCache(modelsTarget({ ...target, id }), checked.models);
      }
      onSaved?.(id);
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const sectionLabels: Record<PresetSection, string> = {
    free: t("providerForm.groupFree"),
    subscription: t("providerForm.groupSubscription"),
    key: t("providerForm.groupApiKey"),
    unavailable: t("providerForm.groupUnavailable"),
  };

  const keyHint = isLocalUrl(preset ? preset.baseUrl : baseUrl.trim()) ? (
    t("providerForm.keyHintLocal")
  ) : freeAccess ? (
    t("providerForm.zenFreeHint")
  ) : auth && !apiKey.trim() ? (
    t("providerForm.keyHintAccount")
  ) : existing ? (
    t("providerForm.keyHintKeep")
  ) : preset?.apiKeyUrl ? (
    <a
      className="text-brand-600 hover:underline dark:text-brand-400"
      href={preset.apiKeyUrl}
      target="_blank"
      rel="noreferrer"
    >
      {t("providerForm.keyHintGet")}
    </a>
  ) : undefined;

  // A raw engine message ("Anthropic API error 400: {…}") is not an error a
  // user can act on — lift the provider's own reason into the line, the JSON
  // behind the disclosure, same as the chat error bubble.
  const split = error ? splitErrorDetail(error) : null;
  let submitLabel = t("providerForm.add");
  if (existing) submitLabel = t("providerForm.update", { name: providerName(existing) });
  if (freeAccess) submitLabel = t("providerForm.useFreeModels");
  if (busy === "checking") {
    submitLabel = t(freeAccess ? "providerForm.connecting" : "providerForm.checkingKey");
  } else if (busy === "saving") {
    submitLabel = t("providerForm.saving");
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-3">
      {unavailable && (
        <p role="status" className="attention rounded-lg p-3 text-sm">
          {t("errors.providerDisabled", { name: providerName(unavailable) })}
        </p>
      )}
      <div className="flex flex-col gap-1 text-sm">
        {/* Sections explain access and billing without changing provider transport. */}
        <Select
          label={t("providerForm.provider")}
          value={presetId}
          onChange={setPresetId}
          options={[
            ...PRESETS.map((p) => {
              let hint: string | undefined;
              if (p.disabled) hint = t("providerList.statusUnavailable");
              else if (p.id === "antigravity") hint = t("providerForm.freeQuota");
              return {
                value: p.id,
                label: providers.some((cp) => cp.id === p.id)
                  ? t("providerForm.configured", { name: p.name })
                  : p.name,
                icon: <ProviderIcon icon={p.icon} size={20} />,
                hint,
                group: sectionLabels[presetSection(p)],
                disabled: p.disabled ?? false,
              };
            }),
            {
              value: CUSTOM,
              label: t("providerForm.customEndpoint"),
              group: t("providerForm.groupApiKey"),
              disabled: false,
            },
          ].sort((a, b) => Number(a.disabled) - Number(b.disabled))}
        />
        {/* The endpoint is worth showing where the user is about to hand over a
            key — it says where that key goes. A sign-in reveals its own
            destination on the vendor's page, so the URL is just noise there. */}
        {preset && !isOAuth && (
          <span className="text-xs text-neutral-500 dark:text-neutral-400">{preset.baseUrl}</span>
        )}
      </div>

      {!preset && (
        <>
          <TextField
            label={t("providerForm.name")}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("providerForm.namePlaceholder")}
          />
          <Select
            label={t("providerForm.apiShape")}
            value={shape}
            onChange={(v) => setShape(v as ProviderShape)}
            options={[
              { value: "openai", label: t("providerForm.shapeOpenai") },
              { value: "anthropic", label: t("providerForm.shapeAnthropic") },
            ]}
          />
          <TextField
            label={t("providerForm.baseUrl")}
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="https://api.example.com/v1"
          />
        </>
      )}

      {preset?.id === "antigravity" && (
        <div role="note" className="attention flex flex-col gap-2 rounded-lg p-3 text-xs">
          <p>{t("providerForm.antigravityWarning")}</p>
          <a
            className="self-start underline underline-offset-2"
            href="https://antigravity.google/docs/faq/"
            target="_blank"
            rel="noreferrer"
          >
            {t("providerForm.antigravityRules")}
          </a>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="self-start"
            onClick={() => setPresetId("gemini")}
          >
            {t("providerForm.useGeminiKey")}
          </Button>
        </div>
      )}

      {isOAuth ? (
        <OAuthSignIn
          key={preset.id}
          preset={preset}
          signedIn={auth}
          hint={preset.id === "antigravity" ? t("providerForm.antigravityHint") : undefined}
          onSignedIn={finishSignIn}
        />
      ) : (
        <>
          {/* A keyed row whose vendor can also mint the key for you. Both
              routes end on the same key and the same bill, so neither is the
              "real" one — they are offered side by side, with the rule between
              them saying they are alternatives rather than steps. */}
          {preset?.signIn && (
            <>
              <OAuthSignIn
                key={preset.id}
                preset={preset}
                signedIn={auth}
                hint={
                  preset.signIn === "key"
                    ? t("providerForm.signInMintsKey", { provider: preset.name })
                    : t("providerForm.signInAccountHint", { provider: preset.name })
                }
                onSignedIn={finishSignIn}
              />
              <div className="flex items-center gap-2" aria-hidden>
                <span className="h-px flex-1 bg-neutral-200 dark:bg-neutral-800" />
                <span className="text-xs text-neutral-400 dark:text-neutral-500">
                  {t("providerForm.or")}
                </span>
                <span className="h-px flex-1 bg-neutral-200 dark:bg-neutral-800" />
              </div>
            </>
          )}
          <PasswordField
            label={preset?.free ? t("providerForm.apiKeyOptional") : t("providerForm.apiKey")}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={
              existing
                ? t("providerForm.apiKeyPlaceholderSaved")
                : t("providerForm.apiKeyPlaceholder")
            }
            autoComplete="off"
            hint={keyHint}
          />
        </>
      )}

      <p className="text-xs text-neutral-500 dark:text-neutral-400">
        {t("providerForm.modelNote")}
      </p>

      {split && (
        <div
          role="alert"
          className="arrive rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200"
        >
          {split.summary}
          {split.detail && (
            <details className="mt-1">
              <summary className="cursor-pointer text-xs underline underline-offset-2">
                {t("chat.details")}
              </summary>
              <pre className="mt-1 max-h-40 overflow-auto rounded bg-red-100/70 p-1.5 font-mono text-xs break-all whitespace-pre-wrap dark:bg-red-900/40">
                {split.detail}
              </pre>
            </details>
          )}
        </div>
      )}

      {!isOAuth && (
        <Button type="submit" disabled={busy !== null}>
          {submitLabel}
        </Button>
      )}
    </form>
  );
}
