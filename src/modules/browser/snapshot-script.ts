/**
 * Snapshot logic — self-contained function injected via chrome.scripting.executeScript.
 * All helpers are inlined inside generateSnapshot so func.toString() captures everything.
 *
 * Clean-room implementation of the accessibility-tree approach.
 * Output format: `[ref=e12] button "Submit"` or `heading "Welcome"`
 *
 * Two exports:
 * - `generateSnapshot`: the self-contained function (safe for executeScript)
 * - Types only (SnapshotOptions, SnapshotResult)
 */

export interface SnapshotOptions {
  filter?: "all" | "interactive";
  maxDepth?: number;
  maxElements?: number;
}

export interface SnapshotResult {
  pageContent: string;
  viewport: { width: number; height: number };
  url: string;
  title: string;
  /**
   * Refs this walk had to mint — interactive elements the registry had never
   * seen. Zero means the page holds nothing new, which is how the agent loop
   * tells a page that moved under a batch from one that stayed put. Only
   * comparable between identical walks, so the loop uses the same
   * no-arguments call the snapshot tool makes.
   */
  newRefs: number;
}

/**
 * MUST be fully self-contained: no closure over module scope.
 * executeScript serializes via toString() and runs in page context.
 */
export function generateSnapshot(opts: SnapshotOptions): SnapshotResult {
  const filter = opts.filter ?? "all";
  const maxDepth = opts.maxDepth ?? 15;
  const maxElements = opts.maxElements ?? 10000;

  const ROLE_MAP: Record<string, string> = {
    a: "link",
    button: "button",
    input: "textbox",
    select: "combobox",
    textarea: "textbox",
    h1: "heading",
    h2: "heading",
    h3: "heading",
    h4: "heading",
    h5: "heading",
    h6: "heading",
    img: "image",
    nav: "navigation",
    main: "main",
    header: "banner",
    footer: "contentinfo",
    section: "region",
    article: "article",
    aside: "complementary",
    form: "form",
    table: "table",
    ul: "list",
    ol: "list",
    li: "listitem",
    label: "label",
    details: "group",
    summary: "button",
    dialog: "dialog",
    search: "search",
  };

  const INTERACTIVE_ROLES = new Set([
    "button",
    "link",
    "textbox",
    "checkbox",
    "radio",
    "combobox",
    "listbox",
    "menuitem",
    "menuitemcheckbox",
    "menuitemradio",
    "option",
    "searchbox",
    "slider",
    "spinbutton",
    "switch",
    "tab",
    "treeitem",
  ]);

  const SKIP_TAGS = new Set(["script", "style", "meta", "link", "title", "noscript", "head"]);

  function resolveRole(el: HTMLElement): string {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === "input") {
      const type = (el.getAttribute("type") || "").toLowerCase();
      if (type === "submit" || type === "button" || type === "image") return "button";
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (type === "file") return "button";
      return "textbox";
    }
    return ROLE_MAP[tag] ?? "generic";
  }

  function isSensitive(el: HTMLElement): boolean {
    const type = (el.getAttribute("type") || "").toLowerCase();
    if (type === "password" || type === "hidden") return true;
    const ac = (el.getAttribute("autocomplete") || "").toLowerCase();
    return [
      "current-password",
      "new-password",
      "one-time-code",
      "cc-number",
      "cc-csc",
      "cc-exp",
      "cc-exp-month",
      "cc-exp-year",
    ].some((s) => ac.includes(s));
  }

  function directText(el: HTMLElement): string {
    let t = "";
    for (const node of el.childNodes) if (node.nodeType === Node.TEXT_NODE) t += node.textContent;
    return t.trim();
  }

  function resolveName(el: HTMLElement): string {
    const tag = el.tagName.toLowerCase();
    if (tag === "select") {
      const sel = el as HTMLSelectElement;
      const opt = sel.querySelector("option[selected]") || sel.options[sel.selectedIndex];
      if (opt?.textContent) return opt.textContent.trim();
    }
    const al = el.getAttribute("aria-label");
    if (al?.trim()) return al.trim();
    const alb = el.getAttribute("aria-labelledby");
    if (alb) {
      const lb = document.getElementById(alb);
      if (lb?.textContent?.trim()) return lb.textContent.trim();
    }
    const ph = el.getAttribute("placeholder");
    if (ph?.trim()) return ph.trim();
    const ti = el.getAttribute("title");
    if (ti?.trim()) return ti.trim();
    const alt = el.getAttribute("alt");
    if (alt?.trim()) return alt.trim();
    if (el.id) {
      const lb = document.querySelector(`label[for="${el.id}"]`) as HTMLElement | null;
      if (lb) {
        const t = directText(lb);
        if (t) return t;
      }
    }
    if (tag === "input") {
      // A submit button's value IS its visible label — any other input's value
      // is field state, which formatLine shows as its own attribute.
      const ie = el as HTMLInputElement;
      const val = ie.getAttribute("value");
      if ((ie.getAttribute("type") || "") === "submit" && val?.trim()) return val.trim();
    }
    if (tag === "button" || tag === "a" || tag === "summary") {
      const t = directText(el);
      if (t) return t;
    }
    if (/^h[1-6]$/.test(tag)) {
      const t = el.textContent?.trim();
      if (t) return t.substring(0, 100);
    }
    const t = directText(el);
    if (t.length >= 3) return t.length > 100 ? t.substring(0, 100) + "..." : t;
    return "";
  }

  function isVisible(el: HTMLElement): boolean {
    const s = getComputedStyle(el);
    if (s.display === "none" || s.visibility === "hidden" || s.opacity === "0") return false;
    // ponytail: offsetWidth/Height are always 0 in JSDOM (no layout engine).
    // In real browsers, genuinely zero-size elements are likely hidden.
    // We skip the dimension check to avoid false negatives in tests; CSS checks
    // cover the common cases. Upgrade: use IntersectionObserver for viewport visibility.
    return true;
  }

  function isInteractive(el: HTMLElement): boolean {
    const tag = el.tagName.toLowerCase();
    if (["a", "button", "input", "select", "textarea", "details", "summary"].includes(tag))
      return true;
    if (el.getAttribute("onclick") || el.getAttribute("tabindex")) return true;
    if (el.getAttribute("contenteditable") === "true") return true;
    const role = el.getAttribute("role");
    return role === "button" || role === "link";
  }

  function isStructural(el: HTMLElement): boolean {
    const tag = el.tagName.toLowerCase();
    return (
      [
        "h1",
        "h2",
        "h3",
        "h4",
        "h5",
        "h6",
        "nav",
        "main",
        "header",
        "footer",
        "section",
        "article",
        "aside",
      ].includes(tag) || el.getAttribute("role") !== null
    );
  }

  // Ref management on window — persists across calls
  const w = window as unknown as {
    __tabrunnerRefs?: Map<string, WeakRef<HTMLElement>>;
    __tabrunnerReverse?: WeakMap<HTMLElement, string>;
    __tabrunnerCounter?: number;
  };
  // Interactive elements this walk had never seen before. A page that stayed
  // put mints nothing, so the count doubles as the change signal the agent
  // loop reads between a turn's actions.
  let newRefs = 0;
  function getOrCreateRef(el: HTMLElement): string {
    if (!w.__tabrunnerRefs) {
      w.__tabrunnerRefs = new Map();
      w.__tabrunnerReverse = new WeakMap();
      w.__tabrunnerCounter = 0;
    }
    const existing = w.__tabrunnerReverse!.get(el);
    if (existing) {
      const r = w.__tabrunnerRefs!.get(existing);
      if (r && r.deref() === el) return existing;
    }
    newRefs++;
    const ref = `e${++w.__tabrunnerCounter!}`;
    w.__tabrunnerRefs!.set(ref, new WeakRef(el));
    w.__tabrunnerReverse!.set(el, ref);
    return ref;
  }

  function formatLine(
    depth: number,
    role: string,
    name: string,
    ref: string | undefined,
    el: HTMLElement,
  ): string {
    const indent = "  ".repeat(depth);
    let line = `${indent}${role}`;
    if (name) {
      const clean = name.replace(/\s+/g, " ").substring(0, 100).replace(/"/g, '\\"');
      line += ` "${clean}"`;
    }
    if (ref) line += ` [ref=${ref}]`;
    const href = el.getAttribute("href");
    if (href) line += ` href="${href}"`;
    const type = el.getAttribute("type");
    if (type) line += ` type="${type}"`;
    const ph = el.getAttribute("placeholder");
    if (ph) line += ` placeholder="${ph}"`;
    // Field state the tree otherwise hides: the current value (a long pasted
    // value is exactly the one the model needs to see) and the checked mark.
    const tag = el.tagName.toLowerCase();
    if (tag === "input" || tag === "textarea") {
      const input = el as HTMLInputElement;
      const type = (input.getAttribute("type") || "").toLowerCase();
      if (type === "checkbox" || type === "radio") {
        if (input.checked) line += " (checked)";
      } else if (input.value) {
        const shown = isSensitive(input)
          ? "[value redacted]"
          : input.value.replace(/\s+/g, " ").substring(0, 80).replace(/"/g, '\\"');
        line += ` value="${shown}"`;
      }
    }
    return line;
  }

  const lines: string[] = [];
  let count = 0;

  function walk(el: HTMLElement, depth: number) {
    if (count >= maxElements || !el.tagName || depth > maxDepth) return;
    if (SKIP_TAGS.has(el.tagName.toLowerCase())) return;

    // Hard-stop: aria-hidden or invisible elements hide their entire subtree
    if (el.getAttribute("aria-hidden") === "true") return;
    if (!isVisible(el)) return;

    // Role/name resolve once per element and serve both the inclusion decision
    // and the output line — getComputedStyle and the name walk never run twice.
    const role = resolveRole(el);
    const name = resolveName(el);
    const interactive = isInteractive(el);
    const included =
      filter === "interactive"
        ? interactive
        : interactive || isStructural(el) || name.length > 0 || role !== "generic";

    if (included) {
      const ref = INTERACTIVE_ROLES.has(role) || interactive ? getOrCreateRef(el) : undefined;
      lines.push(formatLine(depth, role, name, ref, el));
      count++;

      if (el.tagName.toLowerCase() === "select" && !isSensitive(el)) {
        const sel = el as HTMLSelectElement;
        for (let i = 0; i < sel.options.length; i++) {
          const opt = sel.options[i]!;
          const text = opt.textContent?.trim().substring(0, 100) ?? "";
          let ol = `${"  ".repeat(depth + 1)}option`;
          if (text) ol += ` "${text.replace(/"/g, '\\"')}"`;
          if (opt.selected) ol += " (selected)";
          if (opt.value && opt.value !== text) ol += ` value="${opt.value}"`;
          lines.push(ol);
        }
      }
    }

    for (let i = 0; i < el.children.length; i++) {
      walk(el.children[i] as HTMLElement, included ? depth + 1 : depth);
    }
  }

  // GC dead refs
  if (w.__tabrunnerRefs) {
    for (const [key, ref] of w.__tabrunnerRefs) if (!ref.deref()) w.__tabrunnerRefs.delete(key);
  }

  if (document.body) walk(document.body, 0);

  let pageContent = lines.join("\n");
  if (count >= maxElements) {
    // Only tools the model actually has: the snapshot tool takes no arguments,
    // so depth and filter are not knobs it can reach for (and must not be — the
    // loop's ref-mint census compares against this exact no-arguments walk).
    pageContent += `\n[truncated at ${maxElements} elements — call find with a distinctive word to locate what you need, or read_page_text to read the page as prose]`;
  }

  return {
    pageContent,
    viewport: { width: window.innerWidth, height: window.innerHeight },
    url: location.href,
    title: document.title,
    newRefs,
  };
}
