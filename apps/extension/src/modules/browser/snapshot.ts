import { generateSnapshot, refClickPoint } from "./snapshot-script";
import type { SnapshotOptions, SnapshotResult } from "./snapshot-script";
import { runInPage } from "./inject";
import type { TabId } from "@/shared/types";
import { i18n } from "@/i18n";

/**
 * Injects the snapshot function into the page and returns the result.
 */
export async function captureSnapshot(
  tabId: TabId,
  opts?: SnapshotOptions,
): Promise<SnapshotResult> {
  const result = await runInPage(tabId, generateSnapshot, [opts ?? {}]);
  if (!result) {
    throw new Error(i18n.t("errors.snapshotFailed"));
  }
  return result;
}

/**
 * Resolves a ref (e.g. "e12") to the viewport point a click on it should land
 * on, via executeScript. Used by the driver for click-by-ref.
 */
export async function resolveRefPoint(
  tabId: TabId,
  ref: string,
): Promise<{ x: number; y: number }> {
  const result = await runInPage(tabId, refClickPoint, [ref]);

  if (!result) {
    throw new Error(i18n.t("errors.refNotFound", { ref }));
  }

  return result;
}

export type { SnapshotOptions, SnapshotResult };
