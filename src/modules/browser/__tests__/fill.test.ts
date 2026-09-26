import { describe, it, expect, beforeEach } from "vitest";
import { fillByRef } from "../fill";

function setupDOM(html: string) {
  document.documentElement.innerHTML = `<body>${html}</body>`;
  window.__tabrunnerRefs = undefined;
}

function register(el: HTMLElement, ref = "e1"): string {
  (window.__tabrunnerRefs ??= new Map()).set(ref, new WeakRef(el));
  return ref;
}

function eventsOf(el: HTMLElement): string[] {
  const fired: string[] = [];
  el.addEventListener("input", () => fired.push("input"));
  el.addEventListener("change", () => fired.push("change"));
  return fired;
}

beforeEach(() => {
  // jsdom has no layout — scrollIntoView is unimplemented in some versions.
  window.HTMLElement.prototype.scrollIntoView = function () {};
});

describe("fillByRef", () => {
  it("sets a text input's value through the prototype setter and fires input+change", () => {
    setupDOM(`<input id="f" type="text" value="old" />`);
    const el = document.getElementById("f") as HTMLInputElement;
    const fired = eventsOf(el);

    expect(fillByRef(register(el), "new text")).toEqual({ status: "ok" });
    expect(el.value).toBe("new text");
    expect(fired).toEqual(["input", "change"]);
    expect(document.activeElement).toBe(el);
  });

  it("clears a field with an empty string", () => {
    setupDOM(`<input id="f" type="text" value="93619-155793618-2642" />`);
    const el = document.getElementById("f") as HTMLInputElement;

    expect(fillByRef(register(el), "")).toEqual({ status: "ok" });
    expect(el.value).toBe("");
  });

  it("bypasses an own property descriptor, the way framework-tracked inputs need", () => {
    setupDOM(`<input id="f" type="text" value="old" />`);
    const el = document.getElementById("f") as HTMLInputElement;
    let ownSetterHit = false;
    Object.defineProperty(el, "value", {
      get: () => HTMLInputElement.prototype.valueOf.call(el),
      set: () => {
        ownSetterHit = true;
      },
      configurable: true,
    });

    expect(fillByRef(register(el), "past the trap")).toEqual({ status: "ok" });
    expect(ownSetterHit).toBe(false);
    // The prototype getter still reports what the prototype setter wrote.
    const getter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.get;
    expect(getter?.call(el)).toBe("past the trap");
  });

  it("fills a textarea", () => {
    setupDOM(`<textarea id="f">old</textarea>`);
    const el = document.getElementById("f") as HTMLTextAreaElement;

    expect(fillByRef(register(el), "multi\nline")).toEqual({ status: "ok" });
    expect(el.value).toBe("multi\nline");
  });

  it("selects an option by label or value", () => {
    setupDOM(
      `<select id="f"><option value="a">Option A</option><option value="b">Option B</option></select>`,
    );
    const el = document.getElementById("f") as HTMLSelectElement;
    const fired = eventsOf(el);

    expect(fillByRef(register(el), "Option B")).toEqual({ status: "ok" });
    expect(el.value).toBe("b");
    expect(fired).toEqual(["input", "change"]);
  });

  it("reports the available options when none match", () => {
    setupDOM(`<select id="f"><option value="a">Option A</option></select>`);
    const el = document.getElementById("f") as HTMLSelectElement;

    const result = fillByRef(register(el), "Nope");
    expect(result).toEqual({ status: "no-option", options: ["Option A"] });
  });

  it("refuses elements that are not settable fields", () => {
    setupDOM(`<input id="c" type="checkbox" /><button id="b">Go</button>`);
    const checkbox = document.getElementById("c") as HTMLInputElement;
    const button = document.getElementById("b") as HTMLButtonElement;

    expect(fillByRef(register(checkbox, "e1"), "x")).toEqual({
      status: "not-field",
      tag: "input[type=checkbox]",
    });
    expect(fillByRef(register(button, "e2"), "x")).toEqual({ status: "not-field", tag: "button" });
  });

  it("falls back to textContent for contenteditable when execCommand is unavailable", () => {
    setupDOM(`<div id="f" contenteditable="true">old</div>`);
    const el = document.getElementById("f") as HTMLElement;
    // jsdom: no execCommand — the fallback path is what runs here.
    const fired = eventsOf(el);

    const result = fillByRef(register(el), "fresh");
    expect(result).toEqual({ status: "ok" });
    expect(el.textContent).toBe("fresh");
    expect(fired).toContain("input");
  });

  it("reports an unknown ref", () => {
    setupDOM(`<input id="f" />`);
    expect(fillByRef("e99", "x")).toEqual({ status: "no-ref" });
  });
});
