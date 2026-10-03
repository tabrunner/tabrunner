import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { getActiveProvider, watchActiveProvider, watchProviders } from "@/modules/providers";
import { providerDisplayName } from "@/modules/providers/presets";
import { credentialStatus, isOAuthProvider } from "@/modules/providers/status";
import type { ProviderConfig } from "@/modules/providers/types";
import { bridgeConnected, bridgeItem } from "@/modules/bridge/config";
import { useStoredItem } from "@/components/useStoredItem";
import { Button } from "@/components/Button";

/**
 * The active provider as React state — read live, re-read whenever the list or
 * the active id changes (a rename, a new sign-in, a model switch).
 */
function useActiveProvider(): ProviderConfig | undefined {
  const [provider, setProvider] = useState<ProviderConfig | undefined>();
  useEffect(() => {
    let live = true;
    const refresh = () => void getActiveProvider().then((p) => live && setProvider(p));
    refresh();
    const unwatchId = watchActiveProvider(refresh);
    const unwatchList = watchProviders(refresh);
    return () => {
      live = false;
      unwatchId();
      unwatchList();
    };
  }, []);
  return provider;
}

/**
 * The link-state dot, shared with the MCP pane. Only "connected" earns a color:
 * waiting-for-the-daemon is the normal state for the majority who never run one
 * — `attention` gold is for states that ask something of the user, and an
 * unused feature asks nothing.
 */
export function StatusDot({ tone }: { tone: "ok" | "waiting" | "off" }) {
  const color = tone === "ok" ? "bg-brand-500" : "bg-neutral-300 dark:bg-neutral-600";
  return <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${color}`} aria-hidden />;
}

/**
 * The two facts every settings page is quietly about: is there a model to
 * think with, and is the MCP link up. Reports only — the fixes live on their
 * own pages, and the empty-provider state routes there.
 */
export function StatusStrip({ onAddProvider }: { onAddProvider: () => void }) {
  const { t } = useTranslation();
  const provider = useActiveProvider();
  const bridge = useStoredItem(bridgeItem);
  const connected = useStoredItem(bridgeConnected);

  const bridgeTone = !bridge.enabled ? "off" : connected ? "ok" : "waiting";
  const bridgeLabel = !bridge.enabled
    ? t("settings.strip.mcpOff")
    : connected
      ? t("settings.strip.mcpConnected")
      : t("settings.strip.mcpWaiting");

  return (
    <div className="mt-4 flex flex-wrap items-center justify-between gap-x-6 gap-y-1 rounded-lg bg-neutral-50 px-3 py-2 text-xs dark:bg-neutral-900/50">
      {provider ? (
        credentialStatus(provider) === "connected" ? (
          <span className="text-neutral-700 dark:text-neutral-300">
            {providerDisplayName(provider)}
            {provider.model && (
              <span className="text-neutral-500 dark:text-neutral-400"> · {provider.model}</span>
            )}
          </span>
        ) : (
          /* A refresh that fails for good clears the credential — the name
             alone would claim a brain that isn't there. Say what broke and
             route to the fix, in the one affordance voice (brand text on a
             hover pill — the caption styling this replaced read as a label). */
          <Button variant="quiet-brand" size="sm" className="-ml-2" onClick={onAddProvider}>
            {providerDisplayName(provider)}:{" "}
            {isOAuthProvider(provider.id)
              ? t("settings.strip.signInAgain")
              : t("settings.strip.addKeyAgain")}
          </Button>
        )
      ) : (
        /* A settings page with no provider can't run anything — say so and
           offer the way forward, right where the fact is reported. */
        <Button variant="quiet-brand" size="sm" className="-ml-2" onClick={onAddProvider}>
          {t("settings.strip.noProvider")}
        </Button>
      )}
      <span className="flex items-center gap-1.5 text-neutral-600 dark:text-neutral-400">
        <StatusDot tone={bridgeTone} />
        {bridgeLabel}
      </span>
    </div>
  );
}
