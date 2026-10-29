import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { fetchProviderUsage } from "../usage";
import type { ProviderUsage, UsageWindow } from "../usage";
import { formatAgo, formatResetRelative } from "../rate-limit";
import { ProviderError } from "../types";
import type { ProviderConfig } from "../types";
import { AddProviderDialog } from "./AddProviderDialog";
import { Button } from "@/components/Button";
import { useNow } from "@/modules/conversation/ui/hooks";

/**
 * Subscription usage, inline in the engine picker's footer (it used to hide
 * behind a gauge icon's own popover — one less overlay to know about). Lazy:
 * the section mounts only while the picker is open, so nothing is fetched
 * until then, and reopens within the TTL reuse the session cache — the
 * endpoints are unofficial and rate-sensitive.
 */

const TTL_MS = 60_000;

type Snapshot =
  { state: "ok"; usage: ProviderUsage } | { state: "error"; message: string; authFailed: boolean };

const cache = new Map<string, { snapshot: Snapshot; at: number }>();

function WindowRow({ label, window, now }: { label: string; window?: UsageWindow; now: number }) {
  const { t } = useTranslation();
  if (!window) return null;
  const pct = window.usedPercent;
  // A gauge is measurement, so it wears gold — red only when it overruns.
  const tone = pct >= 100 ? "bg-red-500" : "bg-amber-500";
  return (
    <div>
      <div className="flex items-baseline justify-between text-xs">
        <span className="font-medium text-neutral-700 dark:text-neutral-200">{label}</span>
        <span className="telemetry">{t("usage.usedPercent", { percent: pct })}</span>
      </div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-neutral-200 dark:bg-neutral-700">
        {/* Same fill as ContextGauge's — a refresh moves the bar rather than
            teleporting it, which is what says the number is live. */}
        <div
          className={`h-full rounded-full transition-[width] duration-500 ${tone}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      {window.resetsAtMs !== undefined && (
        <div className="mt-0.5 text-xs text-neutral-500 dark:text-neutral-400">
          {t("usage.resets", { reset: formatResetRelative(window.resetsAtMs, now) })}
        </div>
      )}
    </div>
  );
}

export function UsageSection({ provider }: { provider: ProviderConfig }) {
  const { t } = useTranslation();
  // Mount-time now — the section is a glance, not a live ticker.
  const now = useNow(false);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(() => {
    const hit = cache.get(provider.id);
    return hit && now - hit.at < TTL_MS ? hit.snapshot : null;
  });
  // Refresh-spinner state only: the MOUNT fetch needs no flag — "no snapshot
  // yet" already IS "checking", and keeping setState off the effect's sync
  // path is what the lint rule asks for (same shape as useModels).
  const [refreshing, setRefreshing] = useState(false);

  const store = useCallback(
    (next: Snapshot) => {
      cache.set(provider.id, { snapshot: next, at: Date.now() });
      setSnapshot(next);
    },
    [provider],
  );

  // Mount = the picker opened — that IS the ask for the numbers. A warm cache
  // already painted via the initializer, so this only runs cold.
  useEffect(() => {
    if (snapshot !== null) return;
    let cancelled = false;
    fetchProviderUsage(provider).then(
      (usage) => !cancelled && store({ state: "ok", usage }),
      (e: unknown) =>
        !cancelled &&
        store({
          state: "error",
          message: e instanceof Error ? e.message : String(e),
          authFailed: e instanceof ProviderError && e.kind === "auth",
        }),
    );
    return () => {
      cancelled = true;
    };
  }, [provider, snapshot, store]);

  const refresh = async () => {
    setRefreshing(true);
    const next: Snapshot = await fetchProviderUsage(provider).then(
      (usage) => ({ state: "ok", usage }) as const,
      (e: unknown) => ({
        state: "error",
        message: e instanceof Error ? e.message : String(e),
        authFailed: e instanceof ProviderError && e.kind === "auth",
      }),
    );
    store(next);
    setRefreshing(false);
  };

  const loading = snapshot === null;
  const usage = snapshot?.state === "ok" ? snapshot.usage : undefined;
  const hasWindows = Boolean(usage?.fiveHour || usage?.weekly);

  return (
    <div>
      <div className="text-xs font-semibold text-neutral-900 dark:text-neutral-100">
        {t("usage.title")}
        {usage?.plan && (
          <span className="ml-1.5 font-normal text-neutral-400 capitalize dark:text-neutral-500">
            {usage.plan}
          </span>
        )}
      </div>

      <div className="mt-2 flex flex-col gap-2.5">
        {loading && (
          <div className="text-xs text-neutral-500 dark:text-neutral-400">{t("usage.loading")}</div>
        )}
        {snapshot?.state === "error" && (
          <div>
            <div className="text-xs text-red-600 dark:text-red-400">{snapshot.message}</div>
            <div className="mt-1.5 -ml-2 flex items-center gap-1">
              <Button variant="ghost" size="sm" onClick={() => void refresh()}>
                {t("usage.refresh")}
              </Button>
              {snapshot.authFailed && (
                <AddProviderDialog
                  initialProvider={provider}
                  trigger={
                    <Button variant="ghost" size="sm">
                      {t("chat.cta.signIn")}
                    </Button>
                  }
                />
              )}
            </div>
          </div>
        )}
        {usage && !hasWindows && (
          <div className="text-xs text-neutral-500 dark:text-neutral-400">{t("usage.empty")}</div>
        )}
        {usage?.fiveHour && (
          <WindowRow label={t("usage.window5h")} window={usage.fiveHour} now={now} />
        )}
        {usage?.weekly && (
          <WindowRow label={t("usage.windowWeekly")} window={usage.weekly} now={now} />
        )}
      </div>

      {usage && (
        <div className="mt-2.5 flex items-center justify-between border-t border-neutral-100 pt-2 dark:border-neutral-800">
          <span className="text-xs text-neutral-500 dark:text-neutral-400">
            {t("usage.updated", { ago: formatAgo(usage.fetchedAt, now) })}
          </span>
          <Button
            variant="ghost"
            size="sm"
            className="-mr-2"
            disabled={refreshing}
            onClick={() => void refresh()}
          >
            {t("usage.refresh")}
          </Button>
        </div>
      )}
    </div>
  );
}
