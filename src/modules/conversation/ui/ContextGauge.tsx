import { useTranslation } from "react-i18next";
import { useConversationStore } from "./store";
import { useEngine } from "./hooks";
import {
  CONTEXT_RESERVE,
  knownContextWindow,
  learnedContextLimits,
} from "@/modules/providers/context-window";
import { useStoredItem } from "@/components/useStoredItem";
import { formatTokens } from "@/lib/format";

/**
 * How full the model's context is — the number you read before deciding whether
 * to compact, and the button that does it.
 *
 * **It shows a token count, not a percentage.** A percentage needs a
 * denominator, and for most providers nobody can tell us one: the extension is
 * provider-agnostic, any `baseUrl` can serve any model id, and no table stays
 * current. "42% full" against a number we guessed is a made-up statistic, and
 * the user would act on it. So the count — which we measure — always shows, and
 * the bar joins it only when the window is genuinely known (learned from a real
 * rejection, or reported by the endpoint's own listing). When it is, the pair
 * reads "24.3k / 200k" and the bar is that ratio; when it isn't, the count
 * stands alone and claims nothing.
 *
 * **It is the compact button.** Red once inside the reserve, the number has
 * stopped being information and become an instruction — and an instruction with
 * nothing to press is the dead end the house rules forbid. Clicking compacts, at
 * any fill: the fold is append-only, so the worst a stray click costs is one
 * short model call. That also makes the feature discoverable from the very
 * number that motivates it, instead of only from `/compact`.
 *
 * **It outlives the run.** Panel state dies with the panel, so the reading falls
 * back to the last turn's input persisted on the conversation — a reopened
 * panel shows the same number it showed before, instead of blanking until the
 * next run. Only a conversation that has never run a turn has nothing to say.
 *
 * Gold, because it measures rather than acts.
 */
export function ContextGauge() {
  const { t } = useTranslation();
  const live = useConversationStore((s) => s.contextTokens);
  // The run that ended — including one that ended while the panel was closed.
  const stored = useConversationStore(
    (s) => s.conversations.find((c) => c.id === s.activeId)?.lastRun?.lastInput ?? 0,
  );
  const compact = useConversationStore((s) => s.compact);
  const learned = useStoredItem(learnedContextLimits);
  const { provider } = useEngine();

  const used = live > 0 ? live : stored;
  // Nothing has been measured yet — a gauge reading zero would be a claim we
  // cannot make. It appears with the first turn that reports its usage.
  if (used <= 0 || !provider) return null;

  // Not `window`: that name is the DOM global, and the panel calls it elsewhere.
  const limit = knownContextWindow(provider, learned);
  const known = limit !== undefined;
  const pressured = known && used >= limit - CONTEXT_RESERVE;
  const label = known
    ? t("context.usedOf", { used: formatTokens(used), window: formatTokens(limit) })
    : t("context.used", { used: formatTokens(used) });
  const explain = known
    ? t("context.tooltip", { used: formatTokens(used), window: formatTokens(limit) })
    : t("context.tooltipUnknown", { used: formatTokens(used) });

  return (
    // Self-aligning: both bands drop it in a column, and an empty wrapper left
    // behind by a gauge with nothing to say would still spend the column's gap.
    <div className="flex justify-end">
      <button
        type="button"
        onClick={() => compact()}
        title={explain}
        // The visible text is a measurement; the accessible name has to be the
        // action, or the button announces "24.3k / 200k" and nothing else.
        aria-label={explain}
        className="inline-flex shrink-0 cursor-pointer items-center gap-1 rounded px-0.5 hover:bg-neutral-100 focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:outline-none dark:hover:bg-neutral-800"
      >
        {known && (
          <span
            aria-hidden
            className="h-1 w-8 overflow-hidden rounded-full bg-neutral-200 dark:bg-neutral-700"
          >
            <span
              className={`block h-full rounded-full transition-[width] duration-500 ${
                pressured ? "bg-red-500 dark:bg-red-400" : "bg-amber-500 dark:bg-amber-300"
              }`}
              style={{ width: `${Math.max(Math.min(100, Math.round((used / limit) * 100)), 2)}%` }}
            />
          </span>
        )}
        <span
          className={
            pressured
              ? "font-mono text-[11px] tabular-nums text-red-600 dark:text-red-400"
              : "telemetry text-[11px]"
          }
        >
          {label}
        </span>
      </button>
    </div>
  );
}
