import { beforeAll, describe, expect, it } from "vitest";

// The re-ask is the hard card: the run is already mid-list, so it has to say
// what is DONE and what CHANGED. Rendered with all seven steps and no marks it
// read as "start over" for work the user had just watched happen.

import { act } from "react";
import { createRoot } from "react-dom/client";
import { setI18n } from "react-i18next";
import { i18n } from "@/i18n";
import { MessageList } from "../ui/MessageList";
import { useConversationStore } from "../ui/store";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom has no element scrollTo, and the scroller jumps to the live edge on
// every render — the card lives at that edge.
Element.prototype.scrollTo = function (this: Element) {};

beforeAll(() => setI18n(i18n));

const STEPS = ["Open the inbox", "Find the invoice", "File it in the report"];

async function renderGate(planApproval: {
  steps: string[];
  current: number;
  previous?: string[];
  reapproval: boolean;
}) {
  useConversationStore.setState({
    messages: [{ id: "u1", role: "user", content: "file my invoice", timestamp: 0 }],
    status: "running",
    streamingText: "",
    reasoningText: "",
    planApproval,
  });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(<MessageList />));
  const rows = [...container.querySelectorAll("ol li")];
  const cleanup = async () => {
    await act(async () => root.unmount());
    container.remove();
    useConversationStore.setState({ planApproval: null });
  };
  return { container, rows, cleanup };
}

describe("the plan approval card", () => {
  it("marks nothing on the first ask — no step has run yet", async () => {
    const view = await renderGate({ steps: STEPS, current: 0, reapproval: false });
    expect(view.rows).toHaveLength(3);
    expect(view.container.innerHTML).not.toContain("line-through");
    // No baseline to diff against, so nothing is called out as new either.
    expect(view.container.textContent).not.toContain("new");
    await view.cleanup();
  });

  it("strikes what the run already finished and counts the rest", async () => {
    const view = await renderGate({ steps: STEPS, current: 2, reapproval: true });
    expect(view.rows[0]?.querySelector(".line-through")).not.toBeNull();
    expect(view.rows[1]?.querySelector(".line-through")).not.toBeNull();
    expect(view.rows[2]?.querySelector(".line-through")).toBeNull();
    expect(view.container.textContent).toContain("2 done · 1 to go");
    await view.cleanup();
  });

  it("tags only the steps that were not in the list the user last saw", async () => {
    const view = await renderGate({
      steps: [...STEPS.slice(0, 2), "Ask finance which report", "File it in the report"],
      current: 1,
      previous: STEPS,
      reapproval: true,
    });
    const tagged = view.rows.filter((li) => li.textContent?.endsWith("new"));
    expect(tagged).toHaveLength(1);
    expect(tagged[0]?.textContent).toContain("Ask finance which report");
    await view.cleanup();
  });
});
