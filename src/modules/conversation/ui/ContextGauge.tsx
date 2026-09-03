import { useTranslation } from "react-i18next";
import { useConversationStore } from "./store";
import { useEngine } from "./hooks";
import {
  CONTEXT_RESERVE,
  knownContextWindow,
  learnedContextLimits,
} from "@/modules/providers/context-window";
import { useStoredItem } from "@/components/useStoredItem";
import { formatMoney, formatTokens } from "@/lib/format";

/**
 * How big the conversation IS, and what it has cost — the two facts about the
 * THREAD, on the row under the run's own numbers.
 *
 * **The count is a size, not a total.** It is the newest turn's input as the
 * provider measured it — the whole replayed thread, cache reads included. Spend
 * accumulates and a context does not: every turn re-sends the same history, so
 * a run's `input` (the band above) passes this number many times over on a
 * thread that never grew. It is also the exact number the auto-fold acts on
 * (`needsCompaction`), so a fold can never fire at a size the gauge never
 * showed.
 *
 * **The count has no percentage.** A percentage needs a
 * denominator, and for most providers nobody can tell us one: the extension is
 * provider-agnostic, any `baseUrl` can serve any model id, and no table stays
 * current. "42% full" against a number we guessed is a made-up statistic, and
 * the user would act on it. So the count — which we measure — always shows, and
 * the bar joins it only when the window is genuinely known (learned from a real
 * rejection, or reported by the endpoint's own listing). When it is, the pair
 * reads "24.3k / 200k" and the bar is that ratio; when it isn't, the count
 * stands alone and claims nothing.
 *
 * **It is a readout, not a button.** It used to compact on click, and that was
 * the wrong verb on the wrong element: gold measures, emerald acts — a
 * measurement that spends a model call when your cursor slips is a trap, and
 * this one sits in the band the eye lands on between runs. Nothing is
 * dead-ended by taking the click away, because nothing is owed: the run folds
 * its own history when it approaches the ceiling (`needsCompaction`), a turn
 * that overflows anyway offers "Compact and retry →" on the error itself, and
 * `/compact` is there for a deliberate fold. The tooltip names it.
 *
 * **It outlives the run.** Panel state dies with the panel, so the reading falls
 * back to `ConversationMeta.contextTokens` — a reopened panel shows the same
 * number it showed before, instead of blanking until the next run. That is a
 * fact about the THREAD, not about a run: it survives the next user message,
 * which retires the run summary beside it, and a fold moves it down. Only a
 * conversation whose turns were never measured has nothing to say.
 * The fallback stands in BETWEEN runs only: mid-run the worker answers
 * `query_run` with the live figure, so a panel that just opened onto a running
 * task — or a second window watching it — reads the run in flight, never the
 * last one's leftovers.
 *
 * **The money is the thread's, not the run's.** `spentTotal` — every finished
 * run's estimate, summed — the same number a history row wears, borrowing its
 * tooltip word for word so one fact never gets two explanations. It was only
 * ever legible from the list, which left "what has this conversation cost me?"
 * a question you had to leave the conversation to answer, while the band one
 * row up answered it for a single run. It rides here rather than beside that
 * one because it is the same KIND of fact as the context: about the thread,
 * surviving the next message, unmoved by which run just ended. The run in
 * flight is deliberately not added in — it is live on the band above, and
 * reaching for it here would mean either double-counting it the moment its
 * summary lands or watching the total dip and recover. The word "total" is what
 * keeps the two dollar figures from reading as the same one.
 *
 * Gold, because it measures rather than acts.
 */
export function ContextGauge() {
  const { t } = useTranslation();
  const live = useConversationStore((s) => s.contextTokens);
  // The full usage recorded for this thread — including runs that ended while
  // the panel was closed, or one a schedule ran overnight.
  const stored = useConversationStore(
    (s) => s.conversations.find((c) => c.id === s.activeId)?.contextTokens ?? 0,
  );
  // Every finished run's cost, summed on the index row as each summary lands.
  const spent = useConversationStore(
    (s) => s.conversations.find((c) => c.id === s.activeId)?.spentTotal ?? 0,
  );
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

  const money = t("context.threadCost", { cost: formatMoney(spent) });
  // The history row's words for the same number — an estimate at list prices.
  const moneyTip = t("history.spentTip");

  return (
    // Self-aligning: both bands drop it in a column, and an empty wrapper left
    // behind by a gauge with nothing to say would still spend the column's gap.
    <div className="flex items-center justify-end gap-2">
      {spent > 0 && (
        <span title={moneyTip} aria-label={moneyTip} className="telemetry text-[11px]">
          {money}
        </span>
      )}
      <span
        title={explain}
        // "24.3k / 200k" read aloud is a pair of numbers with no subject — the
        // label says which numbers they are, and `status` lets a screen reader
        // announce the new one when a turn moves it.
        role="status"
        aria-label={explain}
        className="inline-flex shrink-0 items-center gap-1 px-0.5"
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
      </span>
    </div>
  );
}
