import { describe, it, expect, beforeEach } from "vitest";
import { generateSnapshot } from "../snapshot-script";
import type { SnapshotOptions } from "../snapshot-script";

function setupDOM(html: string) {
  document.documentElement.innerHTML = `<body>${html}</body>`;
  // Reset ref state
  (window as unknown as { __tabrunnerRefs: undefined }).__tabrunnerRefs = undefined;
  (window as unknown as { __tabrunnerReverse: undefined }).__tabrunnerReverse = undefined;
  (window as unknown as { __tabrunnerCounter: undefined }).__tabrunnerCounter = undefined;
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
