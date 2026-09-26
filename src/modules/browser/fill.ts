import { runInPage } from "./inject";
import type { TabId } from "@/shared/types";
import { i18n } from "@/i18n";

/**
 * Set a field's value from the page side — the fallback for when trusted key
 * events don't land: pages that swallow keystrokes, focus that won't stick, a
 * field that must be emptied before it can be retyped. Uses the element's own
 * setter plus the input/change events, which is the one path every framework
 * (React, Vue, the rich-text editors) treats as real input.
 */

/** What the page-side function can report back. The wrapper maps these to i18n. */
export type FillResult =
  | { status: "ok" }
  | { status: "no-ref" }
  | { status: "not-field"; tag: string }
  | { status: "no-option"; options: string[] };

/**
 * MUST be fully self-contained: no closure over module scope.
 * executeScript serializes via toString() and runs in page context.
 */
export function fillByRef(refId: string, text: string): FillResult {
  const el = window.__tabrunnerRefs?.get(refId)?.deref();
  if (!el) return { status: "no-ref" };

  const fire = (type: string) => el.dispatchEvent(new Event(type, { bubbles: true }));

  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    if (el instanceof HTMLInputElement) {
      const type = (el.getAttribute("type") || "text").toLowerCase();
      // Buttons want click; checkboxes/radios are toggles, not text; file is
      // unsettable by design (only a real file picker can fill it).
      if (["checkbox", "radio", "file", "submit", "button", "image", "reset"].includes(type)) {
        return { status: "not-field", tag: `input[type=${type}]` };
      }
    }
    el.scrollIntoView({ block: "center", inline: "center" });
    el.focus();
    // The prototype's setter, not el.value = …: a framework may own the
    // element's own property and only notice the change via the input event.
    const proto =
      el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter) setter.call(el, text);
    else el.value = text;
    fire("input");
    fire("change");
    return { status: "ok" };
  }

  if (el instanceof HTMLSelectElement) {
    const wanted = text.trim().toLowerCase();
    const option = [...el.options].find(
      (o) => o.value === text || o.textContent?.trim().toLowerCase() === wanted,
    );
    if (!option) {
      return {
        status: "no-option",
        options: [...el.options].slice(0, 10).map((o) => o.textContent?.trim() ?? o.value),
      };
    }
    el.scrollIntoView({ block: "center", inline: "center" });
    el.focus();
    el.value = option.value;
    fire("input");
    fire("change");
    return { status: "ok" };
  }

  // isContentEditable covers editability inherited from a parent; the
  // attribute check keeps jsdom (which doesn't implement the property) honest.
  if (el.isContentEditable || el.getAttribute("contenteditable") === "true") {
    el.scrollIntoView({ block: "center", inline: "center" });
    el.focus();
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(el);
    selection?.removeAllRanges();
    selection?.addRange(range);
    // Deprecated, but still the one insertion rich-text editors (Slate, Draft,
    // Quill) treat as a real paste/typing — plain textContent assignment
    // bypasses their beforeinput handling and desyncs their model.
    if (document.execCommand?.("insertText", false, text)) return { status: "ok" };
    el.textContent = text;
    fire("input");
    return { status: "ok" };
  }

  return { status: "not-field", tag: el.tagName.toLowerCase() };
}

export async function fillField(tabId: TabId, ref: string, text: string): Promise<void> {
  const result = await runInPage(tabId, fillByRef, [ref, text]);
  if (!result || result.status === "no-ref") {
    throw new Error(i18n.t("errors.refNotFound", { ref }));
  }
  if (result.status === "not-field") {
    throw new Error(i18n.t("errors.notAField", { tag: result.tag }));
  }
  if (result.status === "no-option") {
    throw new Error(i18n.t("errors.noSuchOption", { text, options: result.options.join(", ") }));
  }
}
