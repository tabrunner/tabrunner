import { describe, expect, it } from "vitest";
import type { SnapshotElement } from "@/modules/browser/snapshot-script";
import { runDelegate, siteOf } from "../executor";
import type { Ask, ExecutorPage, Observed, PageAction } from "../executor";
import type { ChoiceQuestion } from "../client";
import type { DelegateTask } from "../request";

const button = (ref: string, name: string): SnapshotElement => ({
  ref,
  role: "button",
  name,
  kind: "click",
  inViewport: true,
});

const task: DelegateTask = { goal: "Check out", doneWhen: "Order summary shown", values: [] };

/** A page that moves only when `step` says so; every act is recorded. */
function fakePage(
  start: Observed,
  step: (view: Observed, action: PageAction) => Observed = (v) => v,
): ExecutorPage & { acts: PageAction[] } {
  let view = start;
  const acts: PageAction[] = [];
  return {
    acts,
    observe: async () => view,
    act: async (a) => {
      acts.push(a);
      view = step(view, a);
    },
    settle: async () => {},
  };
}

const page = (elements: SnapshotElement[], url = "https://shop.example.com/cart"): Observed => ({
  url,
  title: "Shop",
  text: "Your cart",
  elements,
});

/** A full distribution over a question's options: the pick gets `p`, the
 *  rest share what's left — the shape readChoice insists on. */
function dist(question: ChoiceQuestion, choice: string, p: number) {
  const ids = Object.keys(question.criteria);
  const rest = ids.length > 1 ? (1 - p) / (ids.length - 1) : 0;
  return {
    choice,
    probabilities: Object.fromEntries(ids.map((id) => [id, id === choice ? p : rest])),
  };
}

/** A yes/no answer with P(YES) = `yes`. */
const yesNo = (q: ChoiceQuestion, yes: number) =>
  yes >= 0.5 ? dist(q, "YES", yes) : dist(q, "NO", 1 - yes);

interface Script {
  op: string;
  target?: string;
  runnerUp?: string;
  pOp?: number;
  /** Target odds, when the pick should be a close call. */
  spread?: Record<string, number>;
  done?: number;
  stuck?: number;
}

/** A Jev that answers each step from the script (the last line repeats) and the
 *  commit check with `commits`. */
function fakeJev(script: Script[], commits = 0.02): Ask & { calls: string[] } {
  const calls: string[] = [];
  let i = 0;
  const ask = async (_state: unknown, questions: Record<string, ChoiceQuestion>) => {
    const reply = (answers: Record<string, unknown>) => ({
      answers,
      inputTokens: 1000,
      cost: 0.0001,
    });
    if (questions.commits) {
      calls.push("guard");
      return reply({ commits: yesNo(questions.commits, commits) });
    }
    const s = script[Math.min(i++, script.length - 1)]!;
    calls.push(s.op);
    const answers: Record<string, unknown> = {
      operation: dist(questions.operation!, s.op, s.pOp ?? 0.9),
      goal_done: yesNo(questions.goal_done!, s.done ?? 0),
      stuck: yesNo(questions.stuck!, s.stuck ?? 0),
    };
    const targets = questions[`${s.op.toLowerCase()}_target`];
    if (s.target && targets) {
      const ids = Object.keys(targets.criteria);
      const odds: Record<string, number> = s.spread ?? {
        [s.target]: s.runnerUp ? 0.6 : 1,
        ...(s.runnerUp ? { [s.runnerUp]: 0.4 } : {}),
      };
      answers[`${s.op.toLowerCase()}_target`] = {
        choice: s.target,
        probabilities: Object.fromEntries(ids.map((id) => [id, odds[id] ?? 0])),
      };
    }
    return reply(answers);
  };
  return Object.assign(ask, { calls });
}

describe("runDelegate", () => {
  it("stops done when the done check clears the line, without acting", async () => {
    const p = fakePage(page([button("e1", "Pay")]));
    const report = await runDelegate(p, fakeJev([{ op: "WAIT", done: 0.9 }]), task);
    expect(report).toMatchObject({ status: "done", reason: "done", calls: 1 });
    expect(p.acts).toEqual([]);
  });

  it("hands back before a click the commit check calls irreversible", async () => {
    const p = fakePage(page([button("e1", "Finish")]));
    const jev = fakeJev([{ op: "CLICK", target: "1" }], 0.8);
    const report = await runDelegate(p, jev, task);
    expect(report).toMatchObject({ status: "handed_back", reason: "irreversible" });
    expect(report.detail).toContain("Finish");
    expect(p.acts).toEqual([]);
    expect(jev.calls).toEqual(["CLICK", "guard"]);
  });

  it("clicks through when the commit check says no, and bills every call", async () => {
    let clicked = false;
    const p = fakePage(page([button("e1", "Next")]), (v) => {
      clicked = true;
      return { ...v, text: "Step 2" };
    });
    const report = await runDelegate(
      p,
      fakeJev([
        { op: "CLICK", target: "1" },
        { op: "WAIT", done: 0.95 },
      ]),
      task,
    );
    expect(clicked).toBe(true);
    expect(report).toMatchObject({ status: "done", calls: 3, inputTokens: 3000 });
    expect(report.cost).toBeCloseTo(0.0003);
    expect(report.steps).toEqual([{ action: 'CLICK button "Next"', changed: true }]);
  });

  it("stops after three actions that change nothing", async () => {
    const p = fakePage(page([button("e1", "A"), button("e2", "B"), button("e3", "C")]));
    const report = await runDelegate(
      p,
      fakeJev([
        { op: "CLICK", target: "1" },
        { op: "CLICK", target: "2" },
        { op: "CLICK", target: "3" },
      ]),
      task,
    );
    expect(report.reason).toBe("no_progress");
    expect(p.acts).toHaveLength(3);
  });

  it("gives a repeated dead step's runner-up one turn, then stops", async () => {
    const p = fakePage(page([button("e1", "Apply"), button("e2", "Apply filter")]));
    const report = await runDelegate(
      p,
      fakeJev([{ op: "CLICK", target: "1", runnerUp: "2" }]),
      task,
    );
    // e1, then e1 again → swapped for e2, then e1 again with the retry spent.
    expect(p.acts.map((a) => ("ref" in a ? a.ref : a.op))).toEqual(["e1", "e2"]);
    expect(report.reason).toBe("repeat");
  });

  it("stops when Jev is unsure twice running", async () => {
    const p = fakePage(
      page([button("e1", "Go"), button("e2", "Go on"), button("e3", "Onward")]),
      (v) => ({
        ...v,
        text: v.text + ".",
      }),
    );
    const report = await runDelegate(
      p,
      // 0.5 × 0.35: each pick is the favorite, and the pair is still a guess.
      fakeJev([
        { op: "CLICK", target: "1", pOp: 0.5, spread: { "1": 0.35, "2": 0.33, "3": 0.32 } },
      ]),
      task,
    );
    expect(report.reason).toBe("unsure");
    expect(p.acts).toHaveLength(1);
  });

  it("stops stuck only once a couple of steps are in", async () => {
    const p = fakePage(page([button("e1", "Go")]), (v) => ({ ...v, text: v.text + "." }));
    const report = await runDelegate(p, fakeJev([{ op: "CLICK", target: "1", stuck: 0.9 }]), task);
    expect(report.reason).toBe("stuck");
    expect(p.acts).toHaveLength(2);
  });

  it("stops unstable when the target keeps vanishing before the act", async () => {
    let n = 0;
    const p = fakePage(page([button("e1", "Go")]));
    // Every re-read shows a fresh ref, so no decision survives to the act.
    p.observe = async () => page([button(`e${++n}`, "Go")]);
    const report = await runDelegate(p, fakeJev([{ op: "CLICK", target: "1" }]), task);
    expect(report.reason).toBe("unstable");
    expect(p.acts).toEqual([]);
  });

  it("stops the moment the page leaves the site or opens a tab", async () => {
    const away = fakePage(page([button("e1", "Partner")]), () =>
      page([button("e9", "Other")], "https://tracker.example.net/"),
    );
    expect((await runDelegate(away, fakeJev([{ op: "CLICK", target: "1" }]), task)).reason).toBe(
      "left_site",
    );
    const popup = fakePage(page([button("e1", "Open")]), (v) => ({ ...v, openedTab: true }));
    expect((await runDelegate(popup, fakeJev([{ op: "CLICK", target: "1" }]), task)).reason).toBe(
      "new_tab",
    );
  });

  it("caps the number of actions", async () => {
    const p = fakePage(page([button("e1", "More")]), (v) => ({ ...v, text: v.text + "." }));
    const report = await runDelegate(p, fakeJev([{ op: "CLICK", target: "1" }]), task, {
      maxActions: 2,
    });
    expect(report.reason).toBe("max_actions");
    expect(p.acts).toHaveLength(2);
  });

  it("hands back when Jev asks to", async () => {
    const report = await runDelegate(fakePage(page([])), fakeJev([{ op: "HAND_BACK" }]), task);
    expect(report).toMatchObject({ status: "handed_back", reason: "hand_back" });
  });

  it("reports a Stop as aborted", async () => {
    const stop = new AbortController();
    stop.abort();
    const report = await runDelegate(fakePage(page([])), fakeJev([{ op: "WAIT" }]), task, {
      signal: stop.signal,
    });
    expect(report.reason).toBe("aborted");
  });
});

describe("siteOf", () => {
  it("keeps subdomains of one site together and splits neighbors apart", () => {
    expect(siteOf("https://www.google.com/travel/flights")).toBe("google.com");
    expect(siteOf("https://accounts.google.com/")).toBe("google.com");
    expect(siteOf("https://shop.example.co.uk/")).toBe("example.co.uk");
    expect(siteOf("https://loja.exemplo.com.br/")).toBe("exemplo.com.br");
  });
});
