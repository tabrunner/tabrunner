import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ArtifactPayload } from "@/shared/protocol";
import { Button } from "@/components/Button";
import { buildSteps } from "../caption";
import { listFrames } from "../store";
import { viewerUrl } from "../viewer-url";

/**
 * The run's deliverable, in the transcript.
 *
 * A card, not a step row: everything else in the column is the agent narrating
 * its work, and this is the thing the user actually asked for. The thumbnail is
 * what marks it — the only picture in a column of prose — so it needs no label
 * above the title to announce itself. It is also the only row in the panel that
 * leads somewhere outside it: the walkthrough opens full-page, because a
 * document made of screenshots cannot be read in a side panel.
 */

interface Preview {
  /** Object URL of the first captured frame. Null while loading, or all gaps. */
  thumb: string | null;
  /** Steps the document will actually print. Null until the frames are read. */
  steps: number | null;
}

/**
 * One IndexedDB read for both things the card shows. Read straight from IDB —
 * the panel shares the worker's origin, so nothing has to be messaged across.
 *
 * The step count is recomputed rather than taken from `artifact.frames`, which
 * counts frames captured: `buildSteps` drops the failed attempts, which is what
 * collapses "clicked, missed, retried, worked" into the one step a reader
 * performs. The card has to say the number they will see.
 */
function usePreview(recordingId: string): Preview {
  const [preview, setPreview] = useState<Preview>({ thumb: null, steps: null });
  useEffect(() => {
    let live = true;
    let made: string | null = null;
    void listFrames(recordingId)
      .then((frames) => {
        if (!live) return;
        const blob = frames.find((f) => f.blob)?.blob;
        if (blob) made = URL.createObjectURL(blob);
        setPreview({ thumb: made, steps: buildSteps(frames).length });
      })
      .catch(() => {});
    return () => {
      live = false;
      if (made) URL.revokeObjectURL(made);
    };
  }, [recordingId]);
  return preview;
}

export function ArtifactCard({ artifact }: { artifact: ArtifactPayload }) {
  const { t } = useTranslation();
  const { thumb, steps } = usePreview(artifact.recordingId);
  const [site] = artifact.sites;

  const flag =
    artifact.status === "partial"
      ? t("walkthrough.card.partial")
      : artifact.status === "truncated"
        ? t("walkthrough.card.truncated")
        : null;

  const open = () => {
    void chrome.tabs.create({ url: viewerUrl(artifact.recordingId) });
  };

  return (
    <div className="max-w-[85%] self-start rounded-lg border border-neutral-200 bg-neutral-50 p-2 dark:border-neutral-700 dark:bg-neutral-800/40">
      <div className="flex items-center gap-2.5">
        {/* The first screen of the process — the fastest way to recognize which
            walkthrough this is in a long thread. */}
        <div className="h-[36px] w-[56px] shrink-0 overflow-hidden rounded border border-neutral-200 bg-neutral-100 dark:border-neutral-700 dark:bg-neutral-900">
          {thumb && <img src={thumb} alt="" className="h-full w-full object-cover object-top" />}
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-medium text-neutral-800 dark:text-neutral-100">
            {artifact.title}
          </div>
          <div className="flex items-center gap-1.5 text-[11px] text-neutral-500 dark:text-neutral-400">
            <span className="shrink-0">
              {t("walkthrough.card.title")}
              {steps !== null && ` · ${t("walkthrough.card.steps", { count: steps })}`}
            </span>
            {site && <span className="truncate">· {site}</span>}
            {flag && (
              // Gold: a recording that stopped short is a measurement of what
              // was caught, not a failure — and never a silent one.
              // `telemetry` is a theme.css @utility, not a color token — as
              // `text-telemetry` it compiled to nothing and the flag went grey.
              <span className="telemetry shrink-0 rounded-full bg-amber-400/15 px-1.5">{flag}</span>
            )}
          </div>
        </div>
        <Button size="sm" variant="outline" onClick={open}>
          {t("walkthrough.card.open")}
        </Button>
      </div>
    </div>
  );
}
