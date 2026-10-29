import { initTheme } from "@/lib/theme";
import { i18n, initI18n } from "@/i18n";
import {
  buildDocHtml,
  buildSteps,
  docFilename,
  loadRecording,
  recordingIdFromUrl,
} from "@/modules/walkthrough";
import type { DocStep, Recording } from "@/modules/walkthrough";
import "./style.css";

/**
 * The walkthrough viewer — a full tab, because a document made of screenshots
 * cannot be read in a side panel.
 *
 * The document itself renders in an iframe from exactly the string the Download
 * button writes to disk, so the preview IS the export: there is no second
 * renderer to drift, and the doc's own stylesheet cannot collide with this
 * page's. Plain TypeScript, no React — this page has one control and a frame.
 */

const root = document.getElementById("root")!;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = "",
  text = "",
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text) node.textContent = text;
  return node;
}

/** Data URLs, not object URLs: the preview must be byte-identical to the file. */
function toDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("could not read frame"));
    reader.readAsDataURL(blob);
  });
}

/**
 * Problem, cause, fix — the house rule. A viewer opened on a recording that has
 * since been evicted must say why it is gone and what to do, never render blank.
 */
function renderMessage(body: string, title?: string, fix?: string): void {
  root.replaceChildren();
  const wrap = el("div", "mx-auto max-w-lg px-6 py-24 text-center");
  if (title)
    wrap.append(
      el("h1", "mb-2 text-lg font-semibold text-neutral-900 dark:text-neutral-100", title),
    );
  wrap.append(el("p", "text-sm text-neutral-600 dark:text-neutral-400", body));
  if (fix) wrap.append(el("p", "mt-1 text-sm text-neutral-600 dark:text-neutral-400", fix));
  root.append(wrap);
}

function render(recording: Recording, steps: DocStep[], images: Map<number, string>): void {
  let branding = true;
  const html = (): string => buildDocHtml({ recording, steps, images, branding });

  root.replaceChildren();
  const page = el("div", "flex h-screen flex-col bg-white dark:bg-neutral-950");

  const bar = el(
    "header",
    "flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-neutral-200 px-4 py-3 dark:border-neutral-800",
  );
  const titleWrap = el("div", "min-w-0 flex-1");
  titleWrap.append(
    el(
      "h1",
      "truncate text-sm font-semibold text-neutral-900 dark:text-neutral-100",
      recording.title,
    ),
    // The one line of consent copy that matters: these are pictures of the
    // user's own logged-in browser, and sharing is the whole point of the file.
    el("p", "text-xs text-neutral-500 dark:text-neutral-400", i18n.t("walkthrough.card.review")),
  );

  const creditLabel = el(
    "label",
    "flex cursor-pointer items-center gap-1.5 text-xs text-neutral-600 dark:text-neutral-400",
  );
  const credit = el("input", "accent-brand-500");
  credit.type = "checkbox";
  credit.checked = branding;
  creditLabel.append(credit, document.createTextNode(i18n.t("walkthrough.viewer.branding")));

  // No React on this page, so <Button> is out of reach — these are the classes
  // buttonClasses("primary", "md") paints, focus ring included.
  const download = el(
    "button",
    "cursor-pointer rounded-lg bg-brand-500 px-3 py-2 text-sm font-medium text-brand-950 transition-colors hover:bg-brand-600 active:bg-brand-700 focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 focus-visible:ring-offset-white focus-visible:outline-none dark:focus-visible:ring-offset-neutral-950",
    i18n.t("walkthrough.viewer.download"),
  );

  const frame = el("iframe", "min-h-0 flex-1 border-0 bg-white");
  frame.title = recording.title;
  // Belt to the CSP's braces: srcdoc would otherwise inherit this page's
  // extension origin, and the document is built from text the visited pages
  // supplied. An opaque origin with no scripts; allow-popups only so the
  // credit link still opens.
  frame.setAttribute("sandbox", "allow-popups allow-popups-to-escape-sandbox");

  credit.addEventListener("change", () => {
    branding = credit.checked;
    frame.srcdoc = html();
  });

  download.addEventListener("click", () => {
    const blob = new Blob([html()], { type: "text/html" });
    const url = URL.createObjectURL(blob);
    const link = el("a");
    link.href = url;
    link.download = docFilename(recording);
    link.click();
    // The anchor's own click is what Chrome allows; the URL is dead weight after.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  });

  bar.append(titleWrap, creditLabel, download);
  page.append(bar, frame);
  root.append(page);
  frame.srcdoc = html();
}

async function main(): Promise<void> {
  initTheme();
  await initI18n();
  document.title = i18n.t("walkthrough.viewer.tabTitle");

  // Decoding a 50-frame document to data URLs takes a moment; a blank tab in
  // the meantime reads as a broken link.
  renderMessage(i18n.t("walkthrough.viewer.loading"));

  const id = recordingIdFromUrl(window.location.href);
  const loaded = id ? await loadRecording(id) : undefined;
  if (!loaded) {
    renderMessage(
      i18n.t("walkthrough.viewer.missingBody"),
      i18n.t("walkthrough.viewer.missingTitle"),
      i18n.t("walkthrough.viewer.missingFix"),
    );
    return;
  }

  const steps = buildSteps(loaded.frames);
  if (steps.length === 0) {
    renderMessage(
      i18n.t("walkthrough.viewer.emptyBody"),
      i18n.t("walkthrough.viewer.emptyTitle"),
      i18n.t("walkthrough.viewer.missingFix"),
    );
    return;
  }

  const images = new Map<number, string>();
  for (const step of steps) {
    const { blob, seq } = step.frame;
    if (blob) images.set(seq, await toDataUrl(blob));
  }
  document.title = loaded.recording.title;
  render(loaded.recording, steps, images);
}

void main();
