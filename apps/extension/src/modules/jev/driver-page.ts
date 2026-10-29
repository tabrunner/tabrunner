import type { BrowserDriver } from "@/modules/browser";
import type { ExecutorPage } from "./executor";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The executor's page over the run's own driver — the same trusted clicks and
 * keystrokes the planner's tools use, the same ref registry, so a ref Jev
 * picked is a ref the planner can read back.
 */
export async function driverPage(driver: BrowserDriver): Promise<ExecutorPage> {
  // ponytail: "opened a tab" = a tab id that wasn't there at the start. A tab
  // the user opens by hand mid-stretch reads the same and ends it early — a
  // harmless stop. The upgrade is tabs.onCreated filtered by openerTabId.
  const known = new Set((await driver.listTabs()).map((t) => t.id));
  const snapshot = async () => {
    // A page mid-navigation has no document to read; a moment later it does.
    for (let attempt = 1; ; attempt++) {
      try {
        return await driver.snapshot({ structured: true });
      } catch (e) {
        if (attempt >= 3) throw e;
        await sleep(300);
      }
    }
  };
  return {
    async observe() {
      const [snap, tabs] = await Promise.all([snapshot(), driver.listTabs()]);
      return {
        url: snap.url,
        title: snap.title,
        text: snap.visibleText ?? "",
        elements: snap.elements ?? [],
        openedTab: tabs.some((t) => !known.has(t.id)),
      };
    },
    async act(a) {
      switch (a.op) {
        case "CLICK":
          await driver.click(a.ref);
          return;
        case "TYPE":
          // Click to focus, then select-all + insert: trusted input, so
          // autocomplete and the page's own handlers fire as for a person.
          await driver.click(a.ref);
          await driver.type(a.text);
          return;
        case "SELECT":
          await driver.fill(a.ref, a.text);
          return;
        case "ENTER":
          await driver.key("Enter");
          return;
        case "SCROLL_DOWN":
          await driver.scrollDown(600);
          return;
        case "SCROLL_UP":
          await driver.scrollUp(600);
          return;
        case "WAIT":
          return;
      }
    },
    // ponytail: fixed waits after the load watch — 250 ms lets a suggestion
    // list render after typing, 1 s is what a WAIT buys. The upgrade is
    // waiting on the listbox itself, as the spike's settle did.
    async settle(a) {
      await driver.settle();
      await sleep(a.op === "WAIT" ? 1000 : a.op === "TYPE" ? 250 : 100);
    },
  };
}
