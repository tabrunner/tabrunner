import { i18n } from "@/i18n";
import { formatDuration } from "@/lib/format";
import type { DocStep, Recording } from "./types";

/**
 * The exported document: one self-contained HTML file, no assets, no network.
 *
 * One file over markdown-plus-an-image-folder because an extension has nowhere
 * to write a folder without more permissions and a zip dependency, and because
 * a single file is what actually gets shared — mailed, dropped in Slack, opened
 * from a USB stick. The print stylesheet makes "Save as PDF" the export we
 * never had to build.
 *
 * Pure string building: no DOM, no storage, no i18n side effects beyond
 * lookups. That is what lets one small test assert the whole document.
 */

export interface DocInput {
  recording: Recording;
  steps: DocStep[];
  /** Frame seq → `data:image/jpeg;base64,…`. Absent for gap frames. */
  images: Map<number, string>;
  /** The removable "Made with TabRunner" line. */
  branding: boolean;
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * What the reader needs before step 1, and the only place the sites appear.
 * Derived, not guessed: the run worked on these hosts with the user's own
 * sessions, so a reader who is not signed in falls off at the first step and
 * never learns why. Naming them inside the sentence that says why they matter
 * beats a row of host chips repeating the same words with none of the reason.
 */
function prerequisite(recording: Recording): string | null {
  if (recording.sites.length === 0) return null;
  return i18n.t("walkthrough.doc.prerequisite", { hosts: recording.sites.join(", ") });
}

/**
 * Everything about this recording that is less than the whole truth, said once,
 * at the top. A walkthrough with a silent hole in it is the failure this module
 * exists to refuse.
 */
function disclosures(recording: Recording): string[] {
  const notes: string[] = [];
  if (recording.status === "partial") notes.push(i18n.t("walkthrough.doc.notePartial"));
  if (recording.status === "truncated") notes.push(i18n.t("walkthrough.doc.noteTruncated"));
  if (recording.armedAtStep > 0) {
    notes.push(i18n.t("walkthrough.doc.noteLateArm", { count: recording.armedAtStep }));
  }
  if (recording.degraded) notes.push(i18n.t("walkthrough.doc.noteDegraded"));
  if (recording.outcome === "stopped") notes.push(i18n.t("walkthrough.doc.noteStopped"));
  if (recording.outcome === "error") notes.push(i18n.t("walkthrough.doc.noteFailed"));
  return notes;
}

/**
 * The emerald ring over the spot the agent clicked — Scribe's signature move,
 * except we know the exact point instead of inferring it from a DOM diff.
 * Positioned as a fraction of the CSS viewport, so it survives the screenshot
 * being scaled to whatever width the page renders at.
 */
function marker(step: DocStep): string {
  const { click, viewport } = step.frame;
  if (!click || !viewport || viewport.width <= 0 || viewport.height <= 0) return "";
  const left = ((click.x / viewport.width) * 100).toFixed(3);
  const top = ((click.y / viewport.height) * 100).toFixed(3);
  return `<span class="mark" style="left:${left}%;top:${top}%"></span>`;
}

function stepHtml(step: DocStep, images: Map<number, string>): string {
  const image = images.get(step.frame.seq);
  // The caption is the line directly above the picture; repeating it as alt
  // text makes a screen reader say every step twice. What the image adds is
  // which screen this is, so that is what it says.
  const alt = step.frame.title
    ? i18n.t("walkthrough.doc.shotAlt", { title: step.frame.title })
    : step.caption;
  const shot = image
    ? `<div class="shot">${marker(step)}<img src="${image}" alt="${esc(alt)}"></div>`
    : `<div class="shot missing">${esc(i18n.t("walkthrough.doc.missingShot"))}</div>`;
  const value = step.value ? `<p class="value"><code>${esc(step.value)}</code></p>` : "";
  return `<li class="step">
  <div class="head"><span class="num">${step.number}</span><h2>${esc(step.caption)}</h2></div>
  ${value}
  ${shot}
</li>`;
}

export function buildDocHtml(input: DocInput): string {
  const { recording, steps, images, branding } = input;
  const t = i18n.t;
  const duration =
    recording.endedAt && recording.endedAt > recording.startedAt
      ? formatDuration(recording.endedAt - recording.startedAt)
      : null;
  // The document's own language, not the machine's: an English walkthrough
  // with "19 de agosto de 2025" in its header was written by nobody.
  const date = new Date(recording.startedAt).toLocaleDateString(i18n.language, {
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  const meta = [
    date,
    t("walkthrough.doc.stepCount", { count: steps.length }),
    ...(duration ? [duration] : []),
  ];
  const pre = prerequisite(recording);
  const notes = disclosures(recording);

  // Light-first: this file gets printed, pasted into wikis, and opened by
  // people who have never heard of us. The dark variant is a courtesy for
  // reading it on screen, never the document's identity.
  return `<!doctype html>
<html lang="${esc(i18n.language)}">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(recording.title)}</title>
<style>
  :root {
    --bg: #ffffff; --panel: #f7f8fb; --ink: #10162a; --muted: #5b6480;
    --line: #e2e6f0; --brand: #047857; --note: #fffbeb;
    --note-line: #fcd34d; --note-ink: #713f12;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0b1224; --panel: #131c33; --ink: #e8eefb; --muted: #97a1bd;
      --line: #263153; --brand: #34d399; --note: #2a2109;
      --note-line: #a16207; --note-ink: #fde68a;
    }
  }
  * { box-sizing: border-box }
  body {
    margin: 0; padding: 48px 20px 72px; background: var(--bg); color: var(--ink);
    font: 16px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  main { max-width: 820px; margin: 0 auto }
  h1 { font-size: 30px; line-height: 1.25; margin: 0 0 12px; letter-spacing: -.02em }
  .meta { display: flex; flex-wrap: wrap; gap: 6px 10px; color: var(--muted); font-size: 14px; margin: 0 }
  .meta span:not(:last-child)::after { content: "·"; margin-left: 10px }
  .pre, .note {
    margin: 24px 0 0; padding: 12px 16px; border-radius: 10px;
    border: 1px solid var(--line); background: var(--panel); font-size: 14px; color: var(--muted);
  }
  .note { background: var(--note); border-color: var(--note-line); color: var(--note-ink) }
  .note p { margin: 0 }
  .note ul { margin: 0; padding-left: 18px }
  .note li + li { margin-top: 4px }
  hr { border: 0; border-top: 1px solid var(--line); margin: 32px 0 }
  ol { list-style: none; padding: 0; margin: 0 }
  .step { margin: 0 0 40px; break-inside: avoid }
  .head { display: flex; align-items: flex-start; gap: 12px }
  /* The one mark that keeps its color in every mode and on paper: a numeral is
     the shortest label there is, so it can hold the saturated fill the app's
     primary button holds — and it takes the same dark ink. White on emerald
     was the old pairing and it failed everywhere (3.8:1 light, 1.9:1 dark). */
  .num {
    flex: none; width: 28px; height: 28px; border-radius: 999px;
    background: #10b981; color: #022c22; font-size: 14px; font-weight: 700;
    display: inline-flex; align-items: center; justify-content: center;
    margin-top: 2px;
  }
  h2 { font-size: 18px; font-weight: 600; margin: 0; line-height: 1.4 }
  .value { margin: 10px 0 0 40px }
  code {
    font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
    background: var(--panel); border: 1px solid var(--line);
    padding: 3px 8px; border-radius: 6px; word-break: break-all;
  }
  .shot {
    position: relative; margin: 14px 0 0 40px; border: 1px solid var(--line);
    border-radius: 10px; overflow: hidden; background: var(--panel); line-height: 0;
  }
  .shot img { width: 100%; height: auto; display: block }
  .shot.missing {
    padding: 28px 16px; text-align: center; color: var(--muted);
    font-size: 13px; line-height: 1.5; border-style: dashed;
  }
  /* The click point. Two rings so it reads on any background — a solid dot
     inside a translucent halo, the same emerald that means "action" in the app. */
  .mark {
    position: absolute; width: 22px; height: 22px; margin: -11px 0 0 -11px;
    border-radius: 999px; background: #34d39933;
    box-shadow: 0 0 0 2px #059669, inset 0 0 0 7px #05966933; pointer-events: none;
  }
  footer {
    margin: 48px 0 0; padding-top: 20px; border-top: 1px solid var(--line);
    color: var(--muted); font-size: 13px;
  }
  footer a { color: var(--brand); text-decoration: none }
  /* On a phone the 40px step indent is a tenth of the screen, spent hanging a
     screenshot off a number that is already directly above it. */
  @media (max-width: 560px) {
    .value, .shot { margin-left: 0 }
  }
  /* Print is the PDF export, so it gets the same care as the screen. Two things
     would quietly ruin it: Chrome drops backgrounds unless told otherwise —
     which would drop the step numbers' disc and erase the click marker —
     and it carries a dark OS theme onto paper. Force the light palette, then
     force the ink back on for the three marks that ARE their color. */
  @media print {
    :root {
      --bg: #fff; --panel: #f7f8fb; --ink: #10162a; --muted: #4a5268;
      --line: #d7dcea; --brand: #047857; --note: #fffbeb;
      --note-line: #fcd34d; --note-ink: #713f12;
    }
    body { padding: 0 }
    .num, .mark, .note { -webkit-print-color-adjust: exact; print-color-adjust: exact }
    .step { page-break-inside: avoid }
    footer { page-break-before: avoid }
  }
</style>
<main>
  <h1>${esc(recording.title)}</h1>
  <p class="meta">${meta.map((m) => `<span>${esc(m)}</span>`).join("")}</p>
  ${pre ? `<p class="pre">${esc(pre)}</p>` : ""}
  ${
    // A list of one is not a list — the lone bullet reads as a stray mark.
    notes.length === 0
      ? ""
      : notes.length === 1
        ? `<div class="note"><p>${esc(notes[0] ?? "")}</p></div>`
        : `<div class="note"><ul>${notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul></div>`
  }
  <hr>
  <ol>
${steps.map((s) => stepHtml(s, images)).join("\n")}
  </ol>
  ${
    recording.summary
      ? `<hr><h2>${esc(t("walkthrough.doc.outcome"))}</h2><p>${esc(recording.summary)}</p>`
      : ""
  }
  ${
    // Nothing but the credit lives down here, so unticking it has to take the
    // rule above it too — an empty bordered footer reads as a lost paragraph.
    branding
      ? `<footer>${esc(t("walkthrough.doc.madeWith"))} <a href="https://tabrunner.app" target="_blank" rel="noopener">TabRunner</a></footer>`
      : ""
  }
</main>
`;
}

/** `Checkout process.html` — a filename a person recognizes in a downloads folder. */
export function docFilename(recording: Recording): string {
  const safe = recording.title.replace(/[^\p{L}\p{N} _-]/gu, "").trim() || "walkthrough";
  return `${safe.slice(0, 60)}.html`;
}
