import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useProvidersStore } from "./store";
import { engineLabel } from "./engine-label";
import { FILTER_THRESHOLD, narrowModels } from "./narrow-models";
import { ProviderMark } from "./ProviderIcon";
import { AddProviderDialog } from "./AddProviderDialog";
import { UsageSection } from "./UsageSection";
import {
  knownModels,
  listModels,
  modelsTarget,
  pickLatestModel,
  readModelsCache,
  writeModelsCache,
} from "../models";
import type { ModelsTarget } from "../models";
import { PRESETS, providerDisplayName } from "../presets";
import { supportsUsage } from "../usage";
import { EFFORT_LABEL_KEYS, isEffort, REASONING_EFFORTS } from "../types";
import type { ConversationEngine, ModelInfo, ProviderConfig } from "../types";
import { Popover } from "@/components/Popover";
import { Select } from "@/components/Select";
import { TextField } from "@/components/TextField";
import { Button } from "@/components/Button";
import { altKeyLabel } from "@/lib/format";
import { CheckIcon, ChevronDownIcon } from "@/components/Icon";

/**
 * The engine picker — provider, model, and reasoning effort behind one quiet
 * chip in the composer footer (the layout every agent harness converged on:
 * the control sits where the task is typed, and effort folds into the model
 * picker rather than living as a peer select). Controlled: it renders the pick in
 * force and reports what was chosen — the conversation owns which engine it
 * runs on, and this owns how you say so. The background snapshots the pick at
 * run start, so a change applies to the next task, never a run in flight.
 *
 * **Model is the frequent choice, provider the rare one**, and the layout says
 * so: the model list owns the popover body, and the providers are a strip of
 * their brand tiles across the top. That shape is what makes ten connected
 * providers a non-event:
 *
 * - Provider count costs *horizontal* space — one tile each, wrapping past
 *   eight — instead of a row apiece, so the list you came for still starts at
 *   the top of the popover rather than below ten rows of chrome.
 * - Only the active provider is ever listed. Listing means an authenticated
 *   request to that endpoint, and drawing every provider's models at once fired
 *   one per connected provider on every open — several to rate-sensitive
 *   subscription endpoints, for lists nobody was reading.
 * - A tile click switches and the models beneath it swap in place: no expanding,
 *   no drilling in and back out. It commits immediately, carrying that
 *   provider's own saved model and effort (those are stored per provider), which
 *   is what keeps the effort row and the usage section below honest — they
 *   always describe the provider whose tile is lit.
 *
 * One provider — most installs — hides the strip entirely.
 *
 * The listing is warmed at panel mount, not on open: one request for the
 * provider that's about to run the task, which buys a popover that opens on a
 * list instead of a spinner and a trigger that names the model in the
 * endpoint's own words. Long lists stay bounded — OpenRouter serves 300+ and
 * Ollama serves whatever is installed — so they grow a filter and cap rows.
 */

interface ModelsResult {
  key: string;
  models: ModelInfo[];
  error: string | null;
}

/** Fetches the endpoint's live model list; identity-keyed on the target. */
function useModels(target: ModelsTarget | null) {
  const key = target ? JSON.stringify(target) : null;
  const [fetched, setFetched] = useState<ModelsResult | null>(null);

  useEffect(() => {
    if (!key || !target || readModelsCache(target)) return;
    let cancelled = false;
    listModels(target)
      .then((models) => {
        writeModelsCache(target, models);
        if (!cancelled) setFetched({ key, models, error: null });
      })
      .catch(
        (e: unknown) =>
          !cancelled &&
          setFetched({ key, models: [], error: e instanceof Error ? e.message : String(e) }),
      );
    return () => {
      cancelled = true;
    };
    // target identity is captured by key
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  // Cache hits resolve during render (switching back to a provider never waits
  // on a fetch it already paid for); errors are never cached, so a failed
  // listing retries the next time that provider is selected.
  const cached = target ? readModelsCache(target) : undefined;
  const current: ModelsResult | null =
    key && fetched?.key === key
      ? fetched
      : key && cached
        ? { key, models: cached, error: null }
        : null;
  return {
    models: current?.models ?? [],
    loading: key !== null && current === null,
    error: current?.error ?? null,
  };
}

/** What a provider is set to run, named without touching the network. */
function savedChoiceLabel(p: ProviderConfig, autoText: string): string {
  const known = knownModels(p);
  if (p.model) return known.find((m) => m.id === p.model)?.name ?? p.model;
  const auto = pickLatestModel(known);
  return auto ? `${autoText} · ${auto.name ?? auto.id}` : autoText;
}

function Row({
  selected,
  onClick,
  title,
  children,
}: {
  selected?: boolean;
  onClick: () => void;
  title?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className="flex w-full cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-xs text-neutral-700 hover:bg-neutral-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 dark:text-neutral-300 dark:hover:bg-neutral-800"
    >
      <span className="flex w-3.5 shrink-0 justify-center text-brand-600 dark:text-brand-400">
        {selected && <CheckIcon size={12} />}
      </span>
      {children}
    </button>
  );
}

/**
 * The connected providers as brand tiles. Toggle-button semantics rather than
 * ARIA tabs: there's no tabpanel to own and no arrow-key contract to honor —
 * one of these is pressed, and that's the whole truth of it.
 */
function ProviderTabs({
  providers,
  activeId,
  onSelect,
}: {
  providers: ProviderConfig[];
  activeId: string;
  onSelect: (p: ProviderConfig) => void;
}) {
  const { t } = useTranslation();
  return (
    <div
      role="group"
      aria-label={t("modelPicker.provider")}
      className="mb-2 flex flex-wrap items-center gap-1 border-b border-neutral-100 pb-2 dark:border-neutral-800"
    >
      {providers.map((p) => {
        const active = p.id === activeId;
        const name = providerDisplayName(p);
        return (
          <button
            key={p.id}
            type="button"
            aria-pressed={active}
            // The lit tile names itself; the rest answer "which is this, and
            // set to what?" on hover, so a strip of logos is never a puzzle.
            title={
              active
                ? name
                : t("enginePicker.useProviderTitle", {
                    name,
                    choice: savedChoiceLabel(p, t("modelPicker.auto")),
                  })
            }
            onClick={() => onSelect(p)}
            className={`flex max-w-full cursor-pointer items-center gap-1.5 rounded-md py-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 ${
              active
                ? "bg-brand-50 px-1.5 text-xs font-medium text-brand-800 ring-1 ring-brand-200 dark:bg-brand-950/60 dark:text-brand-200 dark:ring-brand-900"
                : "px-1 opacity-60 hover:bg-neutral-100 hover:opacity-100 dark:hover:bg-neutral-800"
            }`}
          >
            <ProviderMark provider={p} size={16} />
            {active && <span className="min-w-0 truncate">{name}</span>}
          </button>
        );
      })}
    </div>
  );
}

/** The active provider's models — the popover's body, and its only fetch. */
function ModelList({
  provider,
  models,
  loading,
  error,
  onPick,
}: {
  provider: ProviderConfig;
  models: ModelInfo[];
  loading: boolean;
  error: string | null;
  onPick: (model: string | undefined) => void;
}) {
  const { t } = useTranslation();
  const [filter, setFilter] = useState("");
  const preset = PRESETS.find((pr) => pr.id === provider.id);
  // Live list wins; presets are both the fallback for endpoints without a list
  // route AND what fills the wait, so a cold open shows models rather than a
  // spinner and refines in place when the listing lands.
  const listed: ModelInfo[] =
    models.length > 0 ? models : (preset?.models.map((id) => ({ id })) ?? []);
  const autoTarget = pickLatestModel(models) ?? listed[0];

  if (listed.length === 0) {
    if (loading) {
      return (
        <div className="px-2 py-1 text-xs text-neutral-500 dark:text-neutral-400">
          {t("enginePicker.loadingModels")}
        </div>
      );
    }
    // No list route and no preset data (custom endpoints, a dead listing) → free text.
    return (
      <TextField
        size="sm"
        aria-label={t("modelPicker.model")}
        title={error ? t("modelPicker.noModelListHint") : undefined}
        className="mt-0.5"
        value={provider.model ?? ""}
        onChange={(e) => onPick(e.target.value || undefined)}
        placeholder={t("modelPicker.freeTextPlaceholder")}
      />
    );
  }

  const { shown, hidden, matched } = narrowModels(listed, filter);

  return (
    <>
      {listed.length > FILTER_THRESHOLD && (
        <TextField
          size="sm"
          autoFocus
          aria-label={t("enginePicker.filterAria")}
          className="mb-1"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder={t("enginePicker.filterPlaceholder", { n: listed.length })}
        />
      )}

      {/* Auto leads and shows what it will actually run, tagged so it stays
          distinguishable from having pinned that same model by hand. It is the
          mode, not a match, so filtering never hides it. */}
      {autoTarget && (
        <Row
          selected={provider.model === undefined}
          onClick={() => onPick(undefined)}
          title={autoTarget.id}
        >
          <span className="shrink-0 rounded bg-neutral-100 px-1 py-px text-[10px] font-medium text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400">
            {t("modelPicker.auto")}
          </span>
          <span className="min-w-0 truncate">{autoTarget.name ?? autoTarget.id}</span>
        </Row>
      )}

      {shown.map((m) => (
        <Row
          key={m.id}
          selected={provider.model === m.id}
          onClick={() => onPick(m.id)}
          title={m.id}
        >
          <span className="min-w-0 truncate">{m.name ?? m.id}</span>
        </Row>
      ))}

      {/* Both dead ends get a way forward, never a blank gap. */}
      {matched === 0 && (
        <p className="px-2 py-1 text-xs text-neutral-500 dark:text-neutral-400">
          {t("enginePicker.noMatch", { query: filter.trim() })}
        </p>
      )}
      {hidden > 0 && (
        <p className="px-2 py-1 text-[11px] text-neutral-500 dark:text-neutral-400">
          {t("enginePicker.moreModels", { n: hidden })}
        </p>
      )}

      {/* A persisted id the endpoint no longer lists stays selectable. */}
      {provider.model && !listed.some((m) => m.id === provider.model) && (
        <Row selected onClick={() => onPick(provider.model)} title={t("modelPicker.notListed")}>
          <span className="min-w-0 truncate">{provider.model}</span>
          <span className="ml-auto shrink-0 text-[10px] text-neutral-500 dark:text-neutral-400">
            {t("modelPicker.notListed")}
          </span>
        </Row>
      )}
    </>
  );
}

export function EnginePicker({
  provider: active,
  onPick,
}: {
  /** The pick in force for this conversation — already resolved by `useEngine`. */
  provider: ProviderConfig | undefined;
  onPick: (patch: Partial<ConversationEngine>, thisChatOnly: boolean) => void;
}) {
  const { t } = useTranslation();
  const providers = useProvidersStore((s) => s.providers);
  const [open, setOpen] = useState(false);
  /**
   * Was ⌥ down for the choice being made? Read at the moment of the write, set
   * by whichever event started it — one ref rather than three handlers, because
   * the effort Select reports a value and no event at all, and a `<button>`
   * activated by Enter still reports its modifiers on the click it synthesizes.
   */
  const alt = useRef(false);
  const [addOpen, setAddOpen] = useState(false);
  const listing = useModels(active ? modelsTarget(active) : null);

  // With zero providers the side panel shows Onboarding instead.
  if (!active) return null;

  // The trigger reads the cached/preset list synchronously — the warm fetch
  // must never be the price of painting the composer.
  const known = knownModels(active);
  const autoTarget = pickLatestModel(known);
  const label = engineLabel({
    auto: active.model === undefined,
    modelName: active.model
      ? (known.find((m) => m.id === active.model)?.name ?? active.model)
      : (autoTarget?.name ?? autoTarget?.id),
    autoText: t("modelPicker.auto"),
    ...(active.reasoningEffort
      ? { effortLabel: t(EFFORT_LABEL_KEYS[active.reasoningEffort]) }
      : {}),
  });

  // Picking a model is the commit-and-close; everything else leaves the popover
  // open, because a tile click is normally the first half of a model change.
  const pick = (model: string | undefined) => {
    onPick({ model }, alt.current);
    setOpen(false);
  };

  // The extra "default" option means "don't send the knob at all".
  const effortOptions = [
    { value: "default", label: t("modelPicker.effort.default") },
    ...REASONING_EFFORTS.map((effort) => ({ value: effort, label: t(EFFORT_LABEL_KEYS[effort]) })),
  ];

  return (
    <>
      <Popover
        open={open}
        onOpenChange={setOpen}
        className="max-h-[70vh] w-72 overflow-y-auto"
        trigger={
          <Button
            variant="ghost"
            size="sm"
            aria-label={t("enginePicker.triggerTitle", { label: label.full })}
            title={t("enginePicker.triggerTitle", { label: label.full })}
            className="flex min-w-0 shrink items-center gap-1.5 hover:text-neutral-900 dark:hover:text-neutral-100"
          >
            <ProviderMark provider={active} size={14} />
            {/* The model id is the half that can afford to abbreviate; the
                effort is pinned, so narrowing the panel eats the name and
                never the setting. The send button outranks both — it is
                shrink-0 in the footer row, so this whole chip gives first. */}
            <span className="truncate">{label.model}</span>
            {label.effort && <span className="shrink-0">· {label.effort}</span>}
            <ChevronDownIcon size={12} className="shrink-0 text-neutral-400" />
          </Button>
        }
      >
        {/* `contents` so the capture wrapper generates no box of its own. */}
        <div
          className="contents"
          onPointerDownCapture={(e) => (alt.current = e.altKey)}
          onKeyDownCapture={(e) => (alt.current = e.altKey)}
        >
          {providers.length > 1 && (
            <ProviderTabs
              providers={providers}
              activeId={active.id}
              onSelect={(p) => onPick({ providerId: p.id }, alt.current)}
            />
          )}

          {/* Keyed on the provider so a switch resets the filter with the list. */}
          <div className="flex flex-col gap-0.5">
            <ModelList key={active.id} provider={active} {...listing} onPick={pick} />
          </div>

          <div className="mt-2 flex items-center justify-between gap-2 border-t border-neutral-100 pt-2 dark:border-neutral-800">
            <span className="shrink-0 text-xs font-medium text-neutral-500 dark:text-neutral-400">
              {t("modelPicker.reasoningEffort")}
            </span>
            <Select
              size="sm"
              variant="quiet"
              className="min-w-0"
              ariaLabel={t("modelPicker.reasoningEffort")}
              title={t("modelPicker.effortHint")}
              value={active.reasoningEffort ?? "default"}
              onChange={(v) => onPick({ effort: isEffort(v) ? v : undefined }, alt.current)}
              options={effortOptions}
            />
          </div>

          {supportsUsage(active.id) && (
            <div className="mt-2 border-t border-neutral-100 pt-2 dark:border-neutral-800">
              {/* Keyed: the section's snapshot is fetched per provider, and a key
                change is the only correct remount when active moves under us. */}
              <UsageSection key={active.id} provider={active} />
            </div>
          )}

          <div className="mt-2 border-t border-neutral-100 pt-1.5 dark:border-neutral-800">
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                setAddOpen(true);
              }}
              className="flex w-full cursor-pointer items-center rounded-md px-1.5 py-1 text-left text-xs font-medium text-neutral-500 hover:bg-neutral-100 hover:text-neutral-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
            >
              {t("modelPicker.addProvider")}
            </button>
          </div>

          {/* The gesture says itself: a modifier nobody is told about is a
            modifier nobody uses. */}
          <div className="mt-1.5 px-1.5 text-[10px] text-neutral-400 dark:text-neutral-500">
            {t("enginePicker.thisChatOnly", { mod: altKeyLabel() })}
          </div>
        </div>
      </Popover>
      {/* Adding a provider from inside a chat means you want to use it HERE —
          the stored default already follows it, and a pinned conversation
          would otherwise stay on the provider you just replaced. */}
      <AddProviderDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        onSaved={(id) => onPick({ providerId: id }, false)}
      />
    </>
  );
}
