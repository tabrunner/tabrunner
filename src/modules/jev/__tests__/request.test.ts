import { describe, expect, it } from "vitest";
import type { SnapshotElement } from "@/modules/browser/snapshot-script";
import { buildRequest, readDecision } from "../request";
import type { DelegateTask, PageView } from "../request";
import type { ChoiceAnswer } from "@providerkit/core/jev";

const el = (ref: string, name: string, extra: Partial<SnapshotElement> = {}): SnapshotElement => ({
  ref,
  role: "button",
  name,
  kind: "click",
  inViewport: true,
  ...extra,
});

const task: DelegateTask = {
  goal: "Search flights from Zurich",
  doneWhen: "Flight results are listed",
  values: [{ for: "From", text: "Zurich" }],
};

const view = (elements: SnapshotElement[]): PageView => ({
  url: "https://example.com/",
  title: "Example",
  text: "Welcome",
  elements,
});

const answer = (choice: string, probabilities: Record<string, number>): ChoiceAnswer => ({
  type: "choice",
  choice,
  probabilities,
  confidence: null,
});

describe("buildRequest", () => {
  it("pairs every text field with every given value, and leaves password fields out", () => {
    const req = buildRequest(
      view([
        el("e1", "From", { role: "textbox", kind: "fill" }),
        el("e2", "Password", { role: "textbox", kind: "fill", sensitive: true }),
        el("e3", "Search"),
      ]),
      task,
      [],
      false,
    );
    expect(Object.keys(req.targets.TYPE ?? {})).toEqual(["1=1"]);
    expect(Object.keys(req.targets.CLICK ?? {})).toEqual(["2"]);
    expect(JSON.stringify(req.state)).not.toContain("Password");
    expect(req.operations).not.toContain("ENTER");
  });

  it("offers ENTER only right after typing", () => {
    const req = buildRequest(view([el("e1", "Go")]), task, [], true);
    expect(req.operations).toContain("ENTER");
  });

  it("offers each dropdown option but the one already picked", () => {
    const req = buildRequest(
      view([el("e1", "Size", { kind: "select", options: ["S", "M", "L"], value: "M" })]),
      task,
      [],
      false,
    );
    expect(Object.values(req.targets.SELECT ?? {}).map((t) => t.text)).toEqual(["S", "L"]);
  });

  it("cuts below-the-fold controls before anything on screen", () => {
    const onScreen = Array.from({ length: 20 }, (_, i) => el(`a${i}`, `Visible ${i}`));
    const below = Array.from({ length: 400 }, (_, i) =>
      el(`b${i}`, `Footer link number ${i} with a long name`, { inViewport: false }),
    );
    const req = buildRequest(view([...below, ...onScreen]), task, [], false, 3000);
    expect(req.tokens).toBeLessThanOrEqual(3000);
    const names = Object.values(req.targets.CLICK ?? {}).map((t) => t.element.name);
    expect(names.slice(0, 20)).toEqual(onScreen.map((e) => e.name));
    expect(names.length).toBeLessThan(420);
  });
});

describe("readDecision", () => {
  const req = buildRequest(view([el("e1", "Search"), el("e2", "Reset")]), task, [], false);

  it("joins the operation and target odds and keeps the runner-up", () => {
    const d = readDecision(req, {
      operation: answer("CLICK", { CLICK: 0.8, SCROLL_DOWN: 0, WAIT: 0.2, DONE: 0, HAND_BACK: 0 }),
      click_target: answer("1", { "1": 0.5, "2": 0.5 }),
      goal_done: answer("NO", { YES: 0.1, NO: 0.9 }),
      stuck: answer("NO", { YES: 0.05, NO: 0.95 }),
    });
    expect(d?.op).toBe("CLICK");
    expect(d?.target?.element.ref).toBe("e1");
    expect(d?.fallback?.element.ref).toBe("e2");
    expect(d?.p).toBeCloseTo(0.4);
    expect(d?.done).toBeCloseTo(0.1);
  });

  it("refuses an answer that picks something it wasn't offered", () => {
    expect(
      readDecision(req, {
        operation: answer("CLICK", { CLICK: 1, SCROLL_DOWN: 0, WAIT: 0, DONE: 0, HAND_BACK: 0 }),
        click_target: answer("7", { "1": 0, "2": 0, "7": 1 }),
      }),
    ).toBeNull();
  });
});
