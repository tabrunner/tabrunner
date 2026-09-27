import type { BrowserDriver } from "@/modules/browser";
import type { ErrorKind } from "@providerkit/core";
import { i18n } from "@/i18n";
import { formatMoney } from "@/lib/format";
import { driverPage } from "./driver-page";
import { runDelegate } from "./executor";
import type { DelegateReport } from "./executor";
import { jevClient } from "./hosts";
import type { JevConnection } from "./hosts";
import type { DelegateValue } from "./request";
import { addJevSpend } from "./settings";

/** What `delegate` hands back to the planner — and what its step row reads. */
export interface DelegateData {
  status: DelegateReport["status"];
  result: string;
  actions: string[];
  jev: { calls: number; input_tokens: number; cost_usd: number };
  next: string;
  snapshot?: unknown;
}

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/** Every usable `{for, text}` the model sent; anything else is dropped. */
function readValues(raw: unknown): DelegateValue[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((v: unknown) => {
    if (typeof v !== "object" || v === null) return [];
    const { for: field, text } = v as { for?: unknown; text?: unknown };
    if (typeof text !== "string" || !text) return [];
    return [{ text, ...(typeof field === "string" && field ? { for: field } : {}) }];
  });
}

/** Host failures in words that say what to fix; the rest keep their own message. */
function failureWords(kind: ErrorKind | undefined): string | undefined {
  switch (kind) {
    case "auth":
      return i18n.t("jev.error.auth");
    case "quota":
      return i18n.t("jev.error.quota");
    case "rate":
    case "overload":
      return i18n.t("jev.error.busy");
    case "network":
    case "timeout":
      return i18n.t("jev.error.network");
    default:
      return undefined;
  }
}

export async function handleDelegate(
  args: Record<string, unknown>,
  driver: BrowserDriver,
  conn: JevConnection,
  ctx: { signal?: AbortSignal; reportCost?: (usd: number) => void },
): Promise<{ ok: true; data: DelegateData } | { ok: false; error: string }> {
  const goal = str(args.goal);
  const doneWhen = str(args.done_when);
  if (!goal || !doneWhen) return { ok: false, error: i18n.t("jev.tool.missingGoal") };
  const maxActions = typeof args.max_actions === "number" ? args.max_actions : undefined;

  const report = await runDelegate(
    await driverPage(driver),
    jevClient(conn),
    { goal, doneWhen, values: readValues(args.values) },
    {
      ...(maxActions !== undefined ? { maxActions } : {}),
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    },
  );
  ctx.reportCost?.(report.cost);
  await addJevSpend(report.cost);

  if (report.reason === "jev_error" && report.steps.length === 0) {
    const why = failureWords(report.kind) ?? report.detail ?? "";
    return { ok: false, error: i18n.t("jev.tool.failed", { why }) };
  }
  // The planner checks the result against the real page before moving on —
  // Jev's "done" is a judgment, not proof.
  const snapshot = await driver.snapshot().catch(() => undefined);
  return {
    ok: true,
    data: {
      status: report.status,
      result: i18n.t(`jev.stop.${report.reason}`, { detail: report.detail ?? "" }),
      actions: report.steps.map((s) =>
        s.changed ? s.action : `${s.action} (${i18n.t("jev.tool.noChange")})`,
      ),
      jev: {
        calls: report.calls,
        input_tokens: report.inputTokens,
        cost_usd: Number(report.cost.toFixed(6)),
      },
      next: i18n.t(report.status === "done" ? "jev.tool.verify" : "jev.tool.continue"),
      ...(snapshot ? { snapshot } : {}),
    },
  };
}

/** The step row's one line. */
export function delegateSummary(data: DelegateData): string {
  const count = data.actions.length;
  if (data.status === "done") return i18n.t("jev.step.done", { count });
  if (data.status === "handed_back") return i18n.t("jev.step.handedBack", { count });
  return i18n.t("jev.step.stopped", { count });
}

/** The step row's drawer: why it ended, what it did, what it cost. */
export function delegateDetail(data: DelegateData): string {
  return [
    data.result,
    ...data.actions.map((a, i) => `${i + 1}. ${a}`),
    i18n.t("jev.step.usage", {
      count: data.jev.calls,
      tokens: data.jev.input_tokens.toLocaleString(),
      cost: formatMoney(data.jev.cost_usd),
    }),
  ].join("\n");
}
