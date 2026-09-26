import { describe, it, expect, beforeEach } from "vitest";
import { generateSnapshot, refClickPoint } from "../snapshot-script";
import type { SnapshotOptions } from "../snapshot-script";

function setupDOM(html: string) {
  document.documentElement.innerHTML = `<body>${html}</body>`;
  // Reset ref state
  window.__tabrunnerRefs = undefined;
  window.__tabrunnerReverse = undefined;
  window.__tabrunnerCounter = undefined;
}

describe("generateSnapshot", () => {
  beforeEach(() => {
    setupDOM("");
  });

  it("resolves roles from explicit role attribute", () => {
    setupDOM(`<div role="navigation"><a href="/foo">Link</a></div>`);
    const result = generateSnapshot({} as SnapshotOptions);
    expect(result.pageContent).toContain("navigation");
    expect(result.pageContent).toContain("link");
  });

  it("resolves roles from tag/type map when no explicit role", () => {
    setupDOM(`
      <button>Click</button>
      <a href="#">Home</a>
      <input type="text" />
      <input type="checkbox" />
      <h2>Title</h2>
    `);
    const result = generateSnapshot({} as SnapshotOptions);
    expect(result.pageContent).toContain("button");
    expect(result.pageContent).toContain("link");
    expect(result.pageContent).toContain("textbox");
    expect(result.pageContent).toContain("checkbox");
    expect(result.pageContent).toContain("heading");
  });

  it("computes accessible name in correct precedence order", () => {
    // aria-label wins over placeholder for the name
    setupDOM(`<input aria-label="Email" placeholder="enter email" />`);
    const result = generateSnapshot({} as SnapshotOptions);
    // Name should be "Email" (aria-label precedence)
    expect(result.pageContent).toMatch(/textbox "Email"/);
    // Placeholder still appears as an attribute, but not as the name
    expect(result.pageContent).toContain('placeholder="enter email"');
  });

  it("falls back to placeholder when aria-label is absent", () => {
    setupDOM(`<input placeholder="Search..." />`);
    const result = generateSnapshot({} as SnapshotOptions);
    expect(result.pageContent).toContain('"Search..."');
  });

  it("resolves name from label[for]", () => {
    setupDOM(`
      <label for="user">Username</label>
      <input id="user" type="text" />
    `);
    const result = generateSnapshot({} as SnapshotOptions);
    expect(result.pageContent).toContain('"Username"');
  });

  it("survives an id that is not a valid selector", () => {
    // Wikipedia citation ids carry quotes (cite_ref-…_"14-bis"_…); an
    // unescaped label[for] lookup threw and took the whole snapshot down.
    setupDOM(`
      <label for='cite"14-bis"'>Note</label>
      <input id='cite"14-bis"' type="text" />
    `);
    const result = generateSnapshot({} as SnapshotOptions);
    expect(result.pageContent).toContain('textbox "Note"');
  });

  it("resolves name from aria-labelledby", () => {
    setupDOM(`
      <span id="lbl">Card number</span>
      <input type="text" aria-labelledby="lbl" />
    `);
    const result = generateSnapshot({} as SnapshotOptions);
    expect(result.pageContent).toContain('"Card number"');
  });

  it("redacts password fields", () => {
    setupDOM(`<input type="password" value="secret123" />`);
    const result = generateSnapshot({} as SnapshotOptions);
    expect(result.pageContent).toContain("[value redacted]");
    expect(result.pageContent).not.toContain("secret123");
  });

  it("filters hidden elements", () => {
    setupDOM(`
      <button style="display:none">Hidden</button>
      <button>Visible</button>
    `);
    const result = generateSnapshot({} as SnapshotOptions);
    expect(result.pageContent).not.toContain("Hidden");
    expect(result.pageContent).toContain("Visible");
  });

  it("keeps checkboxes, radios and selects a site restyled over opacity:0", () => {
    // The custom-control pattern (TodoMVC's .toggle): the real input sits
    // invisible over a painted box and still takes the click.
    setupDOM(`
      <ul><li><input class="toggle" type="checkbox" style="opacity:0" /><label>Pay rent</label></li></ul>
      <label><input type="radio" name="size" style="opacity:0" /> Large</label>
      <select style="opacity:0"><option>Blue</option></select>
    `);
    const result = generateSnapshot({} as SnapshotOptions);
    expect(result.pageContent).toMatch(/checkbox \[ref=e\d+\]/);
    expect(result.pageContent).toMatch(/radio \[ref=e\d+\]/);
    expect(result.pageContent).toMatch(/combobox "Blue" \[ref=e\d+\]/);
  });

  it("still hides opacity:0 containers and text fields", () => {
    // A faded-out menu hides everything in it; an invisible text field is
    // usually a bot trap, and filling it gets the run flagged.
    setupDOM(`
      <div style="opacity:0"><button>Ghost</button><input type="checkbox" /></div>
      <input type="text" placeholder="Leave empty" style="opacity:0" />
    `);
    const result = generateSnapshot({} as SnapshotOptions);
    expect(result.pageContent).not.toContain("Ghost");
    expect(result.pageContent).not.toContain("checkbox");
    expect(result.pageContent).not.toContain("Leave empty");
  });

  it("filters aria-hidden elements", () => {
    setupDOM(`
      <div aria-hidden="true"><button>Hidden</button></div>
      <button>Visible</button>
    `);
    const result = generateSnapshot({} as SnapshotOptions);
    expect(result.pageContent).not.toContain("Hidden");
    expect(result.pageContent).toContain("Visible");
  });

  it("assigns stable refs to interactive elements", () => {
    setupDOM(`
      <button>First</button>
      <a href="#">Second</a>
    `);
    const result = generateSnapshot({} as SnapshotOptions);
    expect(result.pageContent).toContain("[ref=e1]");
    expect(result.pageContent).toContain("[ref=e2]");
  });

  it("preserves refs across calls for same elements", () => {
    setupDOM(`<button id="btn">Click</button>`);
    const first = generateSnapshot({} as SnapshotOptions);
    const second = generateSnapshot({} as SnapshotOptions);
    const firstRef = first.pageContent.match(/\[ref=(e\d+)\]/);
    const secondRef = second.pageContent.match(/\[ref=(e\d+)\]/);
    expect(firstRef?.[1]).toBe(secondRef?.[1]);
  });

  it("includes href, type, and placeholder attributes", () => {
    setupDOM(`
      <a href="/page">Link</a>
      <input type="text" placeholder="query" />
    `);
    const result = generateSnapshot({} as SnapshotOptions);
    expect(result.pageContent).toContain('href="/page"');
    expect(result.pageContent).toContain('placeholder="query"');
  });

  it("expands select options", () => {
    setupDOM(`
      <select>
        <option value="a">Option A</option>
        <option value="b" selected>Option B</option>
      </select>
    `);
    const result = generateSnapshot({} as SnapshotOptions);
    expect(result.pageContent).toContain("Option A");
    expect(result.pageContent).toContain("Option B");
    expect(result.pageContent).toContain("(selected)");
  });

  it("respects maxDepth", () => {
    // Use structural elements (section, article) so depth actually increments
    setupDOM(`
      <section>
        <article>
          <button>Deep</button>
        </article>
      </section>
    `);
    const result = generateSnapshot({ maxDepth: 1 } as SnapshotOptions);
    // section at depth 0, article at depth 1 — button at depth 2 is cut
    expect(result.pageContent).toContain("region");
    expect(result.pageContent).toContain("article");
    expect(result.pageContent).not.toContain("Deep");
  });

  it("reports viewport and url", () => {
    setupDOM(`<button>Test</button>`);
    const result = generateSnapshot({} as SnapshotOptions);
    expect(result.viewport).toEqual({
      width: window.innerWidth,
      height: window.innerHeight,
    });
    expect(result.url).toBe(location.href);
    expect(result.title).toBe(document.title);
  });

  it("skips script and style tags", () => {
    setupDOM(`
      <script>const x = 1;</script>
      <style>.foo { color: red; }</style>
      <button>Real</button>
    `);
    const result = generateSnapshot({} as SnapshotOptions);
    expect(result.pageContent).not.toContain("const x");
    expect(result.pageContent).not.toContain("color: red");
    expect(result.pageContent).toContain("Real");
  });

  // newRefs is what the agent loop reads between a turn's actions to tell a page
  // that moved from one that stayed put — so it has to count only what is new.
  describe("newRefs", () => {
    it("counts every ref on a page it has never walked", () => {
      setupDOM(`<button>One</button><a href="/x">Two</a>`);
      expect(generateSnapshot({} as SnapshotOptions).newRefs).toBe(2);
    });

    it("counts nothing on a second walk of the same page", () => {
      setupDOM(`<button>One</button><a href="/x">Two</a>`);
      generateSnapshot({} as SnapshotOptions);
      expect(generateSnapshot({} as SnapshotOptions).newRefs).toBe(0);
    });

    it("counts only what appeared since the last walk", () => {
      setupDOM(`<button>One</button>`);
      generateSnapshot({} as SnapshotOptions);
      // What an opened menu or a validation error looks like from here.
      document.body.insertAdjacentHTML("beforeend", `<button>Two</button>`);
      expect(generateSnapshot({} as SnapshotOptions).newRefs).toBe(1);
    });

    it("counts nothing when text changes but no element does", () => {
      setupDOM(`<button>One</button>`);
      generateSnapshot({} as SnapshotOptions);
      document.querySelector("button")!.textContent = "Renamed";
      expect(generateSnapshot({} as SnapshotOptions).newRefs).toBe(0);
    });
  });
});

describe("refClickPoint", () => {
  // JSDOM has no layout: stub the boxes and the hit test each case needs.
  const box = (x: number, y: number, width: number, height: number) => () =>
    ({ x, y, width, height }) as DOMRect;

  beforeEach(() => {
    Element.prototype.scrollIntoView = () => {};
  });

  function setup(html: string) {
    setupDOM(html);
    generateSnapshot({} as SnapshotOptions);
    return document.body.firstElementChild as HTMLElement;
  }

  it("clicks the middle of the control when that point lands on it", () => {
    const toggle = setup(
      `<input id="t" type="checkbox" style="opacity:0" /><label for="t">Pay rent</label>`,
    );
    toggle.getBoundingClientRect = box(10, 10, 40, 40);
    document.elementFromPoint = () => toggle;
    expect(refClickPoint("e1")).toEqual({ x: 30, y: 30 });
  });

  it("clicks the label when the whole-pixel point steps off a 1px control", () => {
    // TodoMVC's toggle-all, measured in Chrome: its center rounds to (362, 238),
    // one pixel past the box, so a click there toggled nothing.
    const toggle = setup(
      `<input id="all" type="checkbox" style="opacity:0" /><label for="all">Mark all as complete</label>`,
    );
    toggle.getBoundingClientRect = box(361, 237.1875, 1, 1);
    document.querySelector("label")!.getBoundingClientRect = box(340, 200, 60, 34);
    document.elementFromPoint = (x, y) =>
      x >= 361 && x < 362 && y >= 237.1875 && y < 238.1875 ? toggle : document.body;
    expect(refClickPoint("e1")).toEqual({ x: 370, y: 217 });
  });

  it("keeps the element's own point when there is no label to fall back to", () => {
    const link = setup(`<a href="/next">Next</a>`);
    link.getBoundingClientRect = box(5, 5, 50, 20);
    document.elementFromPoint = () => document.body;
    expect(refClickPoint("e1")).toEqual({ x: 30, y: 15 });
  });

  it("returns null for a ref the page no longer holds", () => {
    setup(`<button>Go</button>`);
    expect(refClickPoint("e99")).toBeNull();
  });
});
