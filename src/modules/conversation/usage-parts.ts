import { formatMoney, formatTokens } from "@/lib/format";
import { i18n } from "@/i18n";

/**
 * What a run spent, in the one wording the band above the composer and the
 * receipt in the transcript share: input and output apart, then the price when
 * the model has one. Never their sum. Every step re-sends the whole chat, so
 * input runs into the millions while the chat itself is a few tens of
 * thousands, and a single "3.6M tokens" read as the chat's size.
 *
 * Empty when nothing was measured, so a caller can skip the line.
 */
export function usageParts({
  input,
  output,
  cost,
}: {
  input: number;
  output: number;
  cost?: number | undefined;
}): string[] {
  if (input + output <= 0) return [];
  const parts = [
    i18n.t("run.receiptIn", { tokens: formatTokens(input) }),
    i18n.t("run.receiptOut", { tokens: formatTokens(output) }),
  ];
  if (cost !== undefined) parts.push(formatMoney(cost));
  return parts;
}
