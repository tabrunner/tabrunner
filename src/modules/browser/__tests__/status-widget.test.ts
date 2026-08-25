import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { paintWidget, removeWidget, type WidgetState } from "../status-widget";

// The page-side half of the status widget, run directly in jsdom the way the
// indicator is tested. The widget's shadow root is closed in production so the
// page can't reach in; the test forces open roots to assert on the internals.

const HOST_ID = "tabrunner-status-widget";

const BASE: WidgetState = {
  mode: "ambient",
  task: "Summarize the thread",
  queuedText: "",
  awaiting: false,
  awaitingText: "",
  hideLabel: "Hide",
  openHint: "Open hint",
  hideHint: "Hide hint",
  expandHint: "Expand hint",
};

const SETTLED: Partial<WidgetState> = {
  settle: { ok: true, text: "Task finished" },
  hideLabel: "",
  hideHint: "",
};

function paint(overrides: Partial<WidgetState> = {}) {
  paintWidget(HOST_ID, { ...BASE, ...overrides });
}

function host(): HTMLElement {
  const el = document.getElementById(HOST_ID);
  expect(el).not.toBeNull();
  return el as HTMLElement;
}

function parts() {
  const root = host().shadowRoot;
  expect(root).not.toBeNull();
  return {
    pill: root!.querySelector<HTMLElement>(".pill")!,
    open: root!.querySelector<HTMLButtonElement>(".open")!,
    mini: root!.querySelector<HTMLElement>(".mini")!,
    hide: [...root!.querySelectorAll<HTMLButtonElement>(".btn")].find(
      (b) => b.textContent === "Hide",
    )!,
  };
}

const visible = (el: HTMLElement) => el.style.display !== "none";

describe("status widget collapse", () => {
  const original = Element.prototype.attachShadow;

  beforeEach(() => {
    document.head.innerHTML = "";
    document.body.innerHTML = "";
    Element.prototype.attachShadow = function () {
      return original.call(this, { mode: "open" });
    };
  });

  afterEach(() => {
    Element.prototype.attachShadow = original;
  });

  it("starts expanded: pill visible, dot hidden", () => {
    paint();
    const { pill, mini } = parts();
    expect(visible(pill)).toBe(true);
    expect(visible(mini)).toBe(false);
    expect(host().dataset.collapsed).toBe("0");
  });

  it("hide collapses to the dot instead of removing the widget", () => {
    paint();
    const { pill, mini, hide } = parts();
    hide.click();

    expect(visible(pill)).toBe(false);
    expect(visible(mini)).toBe(true);
    expect(host().dataset.collapsed).toBe("1");
    // The working signal survives the collapse.
    expect(mini.querySelector(".dot")).not.toBeNull();
    expect(mini.title).toBe("Expand hint");
  });

  it("clicking the dot brings the pill back", () => {
    paint();
    const { pill, mini, hide } = parts();
    hide.click();
    mini.click();

    expect(visible(pill)).toBe(true);
    expect(visible(mini)).toBe(false);
    expect(host().dataset.collapsed).toBe("0");
  });

  it("a repaint keeps the collapsed state", () => {
    paint();
    parts().hide.click();
    paint({ queuedText: "+1 queued" }); // board content changed — the worker re-injects

    const { pill, mini } = parts();
    expect(visible(pill)).toBe(false);
    expect(visible(mini)).toBe(true);
  });

  it("a waiting run collapses to the still ?, never the pulse", () => {
    paint({ awaiting: true });
    parts().hide.click();

    const { mini } = parts();
    expect(mini.querySelector(".wait")?.textContent).toBe("?");
    expect(mini.querySelector(".dot")).toBeNull();
  });

  it("a parked run names the wait in words, keeping the task on the tooltip", () => {
    paint({ awaiting: true, awaitingText: "Waiting for your approval" });

    const line = parts().open.querySelector<HTMLElement>(".task")!;
    // The excerpt can't say the run is blocked on you — the state leads.
    expect(line.textContent).toBe("Waiting for your approval");
    expect(line.title).toBe("Summarize the thread");
  });

  it("removeWidget still takes the whole thing down", () => {
    paint();
    removeWidget(HOST_ID);
    expect(document.getElementById(HOST_ID)).toBeNull();
  });

  it("the pill's whole body opens the panel, and hide only hides", () => {
    const sendMessage = vi.fn();
    const chromeBackup = globalThis.chrome;
    (globalThis as Record<string, unknown>).chrome = {
      ...chromeBackup,
      runtime: { sendMessage },
    };
    try {
      paint();
      // Dot, name, task and queue count all sit inside the one open control —
      // the pill is the target, not a small labeled button within it.
      expect(parts().open.textContent).toContain("Summarize the thread");
      parts().open.click();
      expect(sendMessage).toHaveBeenCalledWith({ type: "tabrunner-mark", action: "open" });

      // Hide is its sibling, not its child: hiding must never also jump you to
      // the panel (and a nested button would be invalid markup besides).
      sendMessage.mockClear();
      parts().hide.click();
      expect(sendMessage).not.toHaveBeenCalled();
      expect(visible(parts().pill)).toBe(false);
    } finally {
      (globalThis as Record<string, unknown>).chrome = chromeBackup;
    }
  });
});

describe("the two voices", () => {
  const original = Element.prototype.attachShadow;

  beforeEach(() => {
    document.head.innerHTML = "";
    document.body.innerHTML = "";
    Element.prototype.attachShadow = function () {
      return original.call(this, { mode: "open" });
    };
  });

  afterEach(() => {
    Element.prototype.attachShadow = original;
  });

  it("the ambient voice names itself; the driven voice is already the sentence", () => {
    paint();
    expect(parts().open.textContent).toContain("TabRunner ·");

    paint({ mode: "driven", task: "TabRunner is controlling this tab" });
    const open = parts().open;
    expect(open.textContent).toContain("TabRunner is controlling this tab");
    expect(open.textContent).not.toContain("TabRunner ·");
    // Both voices carry the Hide button — one mark, one set of controls.
    expect(parts().hide).toBeDefined();
  });
});

describe("the settled receipt", () => {
  const original = Element.prototype.attachShadow;

  beforeEach(() => {
    document.head.innerHTML = "";
    document.body.innerHTML = "";
    Element.prototype.attachShadow = function () {
      return original.call(this, { mode: "open" });
    };
  });

  afterEach(() => {
    Element.prototype.attachShadow = original;
    vi.useRealTimers();
  });

  it("a finished run settles into the ✓ receipt, not a vanishing act", () => {
    paint(SETTLED);

    const { pill, open } = parts();
    expect(open.querySelector(".end.ok")?.textContent).toBe("✓");
    expect(open.textContent).toContain("Task finished");
    // No Hide: the whole pill is already leaving on its own.
    expect(parts().hide).toBeUndefined();
    expect(pill.className).not.toContain("bad");
  });

  it("a failed run settles into the ✗ receipt and wears its ring", () => {
    paint({ ...SETTLED, settle: { ok: false, text: "Task failed" } });

    const { pill, open } = parts();
    expect(open.querySelector(".end.bad")?.textContent).toBe("✗");
    expect(open.textContent).toContain("Task failed");
    // Emerald would read as success — the failed receipt's ring is red.
    expect(pill.className).toContain("bad");
  });

  it("the page takes the receipt down itself", () => {
    vi.useFakeTimers();
    paint(SETTLED);
    expect(document.getElementById(HOST_ID)).not.toBeNull();

    vi.advanceTimersByTime(6000);
    expect(document.getElementById(HOST_ID)).toBeNull();
  });

  it("a stale receipt timer never takes down a newer run's pill", () => {
    vi.useFakeTimers();
    paint(SETTLED);
    // The next run starts before the receipt's timer fires — its pill replaces it.
    paint({ queuedText: "+1 queued" });

    vi.advanceTimersByTime(6000);
    expect(document.getElementById(HOST_ID)).not.toBeNull();
    expect(parts().open.textContent).toContain("Summarize the thread");
  });
});
