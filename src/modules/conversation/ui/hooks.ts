import { useEffect, useMemo, useState } from "react";
import { useConversationStore, pinOf, boardRunHere } from "./store";
import type { ConversationState } from "./store";
import { isRestrictedUrl } from "@/modules/browser";
import { engineProvider } from "@/modules/providers/engine";
import { useProvidersStore } from "@/modules/providers/ui";
import type { ConversationEngine, ProviderConfig } from "@/modules/providers/types";

/**
 * Is a queue holding the footer busy? Queued steering lines, a queued run
 * waiting its turn, a command parked until the run ends, or a stop-redirect's
 * joined text still in transit — all crowd the footer, so the tip slot yields
 * (the composer's own and the run band's alike). One rule with one home: it
 * lived at both tip sites and drifted once already.
 */
export function useQueueBusy(): boolean {
  return useConversationStore(
    (s) =>
      s.queued.length > 0 || s.queuedRun !== null || s.deferred !== null || s.pendingSend !== null,
  );
}

/**
 * Ticking Date.now() for duration displays ("for 3m 48s"). Runs one interval
 * only while active — idle transcripts pay no timer.
 */
export function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

/**
 * May this panel walk away from a run, and would closing park it? Two bits,
 * because the composer's control needs both: `live` says there is a run to
 * walk away FROM (so the target control becomes the walk-away action);
 * `parked` says the run is blocked on the user's answer — a plan gate or a
 * server's question — which is the one state the walk-away button declines.
 *
 * Closing while an answer is parked strands it on an OS notification the user
 * has to click their way back from, so the button is disabled there and the
 * tooltip says why rather than leaving a dead grey button unexplained. Every
 * other live state — working, before the first gate, replanning — may be
 * walked away from: the run is unattended by design, and if a gate parks
 * later, the tab's "?" mark and a notification carry it.
 */
export function useWalkAway(): { live: boolean; parked: boolean } {
  const status = useConversationStore((s) => s.status);
  const runStartedAt = useConversationStore((s) => s.runStartedAt);
  const bridgeActive = useConversationStore((s) => s.bridgeActive);
  const parkedOnAnswer = useConversationStore(
    (s) => s.planApproval !== null || s.elicitation !== null,
  );
  const boardRun = useConversationStore(boardRunHere);

  // This panel's own run when it has one; the board's record of the run it
  // reopened into otherwise — but never a bridge session's: that client owns
  // the run, and the toggle's flip is not the walk-away there.
  const localLive = status === "running" && runStartedAt !== null;
  if (localLive) return { live: true, parked: parkedOnAnswer };
  if (bridgeActive || !boardRun) return { live: false, parked: false };
  return { live: true, parked: boardRun.awaiting === true };
}

/**
 * Is the window's active tab one Chrome forbids extensions from touching
 * (chrome://, the Web Store, devtools)? A run has no page to adopt there, so
 * the composer says so before the send instead of letting the task look like it
 * went somewhere it didn't — the send still works, it just opens a tab of its
 * own.
 *
 * Re-asked on every tab switch and every committed navigation: the answer is a
 * property of what the user is looking at right now, not of this panel.
 */
export function useRestrictedPage(): boolean {
  const [restricted, setRestricted] = useState(false);
  useEffect(() => {
    let alive = true;
    const check = async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (alive) setRestricted(isRestrictedUrl(tab?.url));
    };
    const onActivated = () => void check();
    // Only a url commit can flip the verdict — loading ticks and title changes
    // on the same page would just re-query for nothing.
    const onUpdated = (_id: number, info: chrome.tabs.OnUpdatedInfo) => {
      if (info.url !== undefined) void check();
    };
    void check();
    chrome.tabs.onActivated.addListener(onActivated);
    chrome.tabs.onUpdated.addListener(onUpdated);
    return () => {
      alive = false;
      chrome.tabs.onActivated.removeListener(onActivated);
      chrome.tabs.onUpdated.removeListener(onUpdated);
    };
  }, []);
  return restricted;
}

/**
 * The engine this conversation runs on, and how to change it.
 *
 * `provider` is the effective config — the thread's pin laid over the stored
 * provider, or the stored default when nothing is pinned. Every in-conversation
 * surface reads it from here (the composer chip, the context gauge's
 * denominator, the error bubble's key dialog) so none of them can name an
 * engine the run would not have used.
 *
 * The overlay is memoized rather than computed inside a zustand selector: a pin
 * produces a fresh object, and a selector that returns one on every call
 * re-renders forever.
 */
export function useEngine(): {
  provider: ProviderConfig | undefined;
  pin: ConversationEngine | undefined;
  setEngine: ConversationState["setEngine"];
} {
  const load = useProvidersStore((s) => s.load);
  useEffect(() => {
    void load();
  }, [load]);

  const providers = useProvidersStore((s) => s.providers);
  const storedId = useProvidersStore((s) => s.activeId);
  const pin = useConversationStore(pinOf);
  const setEngine = useConversationStore((s) => s.setEngine);

  const provider = useMemo(
    () => engineProvider(providers, storedId, pin),
    [providers, storedId, pin],
  );
  return { provider, pin, setEngine };
}

/** `useEngine` for the getState() world — the slash commands' resolver. */
export function engineNow(): ProviderConfig | undefined {
  const { providers, activeId } = useProvidersStore.getState();
  return engineProvider(providers, activeId, pinOf(useConversationStore.getState()));
}
