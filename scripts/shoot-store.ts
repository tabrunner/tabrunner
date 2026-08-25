/**
 * Store screenshots (CWS: exactly 1280×800 PNG, docs/store-listing.md §4).
 * Seeds the built extension with demo providers + conversations, then shoots
 * the four captured set into docs/screenshots/.
 *
 * No extension API can raster the side panel — captureVisibleTab sees only the
 * tab's web contents and the panel is a separate view — so the panel is shot
 * as its own page (400×800) and composited over the page shot (880×800), which
 * is the same layout a real panel-over-page window shows. The on-page badge and
 * status widget are injected with the same markup/colors as
 * src/modules/browser/indicator.ts and status-widget.ts (shadow-DOM CSS
 * duplicated here — keep in sync).
 *
 *   bun run shots   (after `bun run build`)
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer, { type Browser, type Page } from "puppeteer-core";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const extPath = join(root, "dist", "chrome-mv3");
const outDir = join(root, "docs", "screenshots");
mkdirSync(outDir, { recursive: true });

/**
 * Branded Chrome ignores --load-extension in headless; Chrome for Testing
 * doesn't. Resolve the newest CfT from the puppeteer cache, fall back to the
 * system Chrome (headed mode would still work there).
 */
function findChrome(): string {
  const cache = join(homedir(), ".cache", "puppeteer", "chrome");
  if (existsSync(cache)) {
    for (const version of readdirSync(cache).sort().reverse()) {
      const dir = join(cache, version);
      for (const arch of existsSync(dir) ? readdirSync(dir) : []) {
        const bin = join(
          dir,
          arch,
          "Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
        );
        if (existsSync(bin)) return bin;
      }
    }
  }
  return "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
}
const executablePath = findChrome();

const W = 1280;
const H = 800;
const PANEL_W = 400;

// ── seed data ────────────────────────────────────────────────────────────────
const now = Date.now();
const DAY = 86_400_000;

const oauth = {
  accessToken: "demo",
  refreshToken: "demo",
  expiresAt: now + 3_600_000,
  account: "you@example.com",
};
const providers = [
  {
    // Ids are the preset ids — credential status and the vendor icon key off them.
    id: "claude",
    name: "Anthropic",
    shape: "anthropic",
    baseUrl: "https://api.anthropic.com",
    apiKey: "",
    auth: oauth,
    model: "claude-sonnet-5",
    createdAt: now - 9 * DAY,
  },
  {
    id: "chatgpt",
    name: "OpenAI",
    shape: "responses",
    baseUrl: "https://chatgpt.com/backend-api/codex",
    apiKey: "",
    auth: oauth,
    model: "gpt-5.5",
    createdAt: now - 6 * DAY,
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    shape: "openai",
    baseUrl: "https://api.deepseek.com",
    apiKey: "sk-demo",
    model: "deepseek-v4-flash",
    createdAt: now - 2 * DAY,
  },
];

let t = now - 3_600_000;
const stamp = () => (t += 4_000);
let n = 0;
const id = () => `m${++n}`;

const chat1 = [
  {
    id: id(),
    role: "user",
    content: "search for LLM browser agents and summarize for me",
    tab: {
      title: "Web browser - Wikipedia",
      url: "https://en.wikipedia.org/wiki/Web_browser",
    },
    timestamp: stamp(),
  },
  {
    id: id(),
    role: "reasoning",
    content:
      "The user wants a current comparison of LLM browser agents. I'll search, open the strongest result, and condense it.",
    elapsed: 3000,
    timestamp: stamp(),
  },
  {
    id: id(),
    role: "plan",
    content: "",
    steps: [
      'Search the web for "LLM browser agents"',
      "Review the top results",
      "Summarize the findings",
    ],
    current: 3,
    timestamp: stamp(),
  },
  {
    id: id(),
    role: "step",
    content: "",
    tool: "navigate",
    args: { url: "https://en.wikipedia.org/wiki/Intelligent_agent" },
    ok: true,
    timestamp: stamp(),
  },
  { id: id(), role: "step", content: "", tool: "snapshot", ok: true, timestamp: stamp() },
  { id: id(), role: "step", content: "", tool: "screenshot", ok: true, timestamp: stamp() },
  {
    id: id(),
    role: "assistant",
    content:
      "Here's the short version of what's out there:\n\n" +
      "- **Sandboxed agents** (Browser Use, Skyvern, Stagehand) drive a cloud browser — easy to start, but logged out of everything.\n" +
      "- **In-browser agents** like TabRunner drive *your* browser — your sessions, your logins — so they can act on the sites you actually use.\n\n" +
      "If the task touches an account you're signed into, in-browser wins; for stateless scraping, a sandbox is enough.",
    timestamp: stamp(),
  },
  { id: id(), role: "step", content: "", tool: "done", ok: true, timestamp: stamp() },
];

const chat2 = [
  {
    id: id(),
    role: "user",
    content: "what are the top stories on Hacker News right now?",
    tab: { title: "Hacker News", url: "https://news.ycombinator.com" },
    timestamp: stamp(),
  },
  {
    id: id(),
    role: "plan",
    content: "",
    steps: ["Open Hacker News", "Read the front page", "List the top 5 stories"],
    current: 3,
    timestamp: stamp(),
  },
  {
    id: id(),
    role: "step",
    content: "",
    tool: "navigate",
    args: { url: "https://news.ycombinator.com" },
    ok: true,
    timestamp: stamp(),
  },
  { id: id(), role: "step", content: "", tool: "snapshot", ok: true, timestamp: stamp() },
  {
    id: id(),
    role: "assistant",
    content:
      "Top of the front page right now:\n\n" +
      "1. Show HN: an agent that drives your real browser\n" +
      "2. Why local-first sync is winning\n" +
      "3. The end of the CAPTCHA arms race\n" +
      "4. Postgres 18 released\n" +
      "5. A terminal UI for everything",
    timestamp: stamp(),
  },
  { id: id(), role: "step", content: "", tool: "done", ok: true, timestamp: stamp() },
];

const conversations = [
  {
    id: "c-hn",
    title: "what are the top stories on Hacker News right now?",
    createdAt: now - 3_000_000,
    updatedAt: t,
    messageCount: chat2.length,
  },
  {
    id: "c-agents",
    title: "search for LLM browser agents and summarize for me",
    createdAt: now - 3_600_000,
    updatedAt: now - 600_000,
    messageCount: chat1.length,
  },
];

// ── browser ─────────────────────────────────────────────────────────────────
const browser: Browser = await puppeteer.launch({
  executablePath,
  headless: true,
  args: [`--disable-extensions-except=${extPath}`, `--load-extension=${extPath}`, "--lang=en-US"],
});

let extId = "";
for (let i = 0; i < 50 && !extId; i++) {
  const sw = browser.targets().find((t) => t.type() === "service_worker");
  const match = sw?.url().match(/^chrome-extension:\/\/([^/]+)\//);
  if (match) extId = match[1];
  else await new Promise((r) => setTimeout(r, 100));
}
if (!extId)
  throw new Error("extension service worker never appeared — run `bun run build` in ../chrome");
console.log(`extension id: ${extId}`);

async function seed(active: string | null) {
  const page = await browser.newPage();
  await page.goto(`chrome-extension://${extId}/options.html`, { waitUntil: "domcontentloaded" });
  await page.evaluate(
    async (data) => {
      await (globalThis as unknown as { chrome: typeof chrome }).chrome.storage.local.set(data);
    },
    {
      "tabrunner:i18n:locale": "en",
      "tabrunner:themeMode": "dark",
      "tabrunner:providers": providers,
      "tabrunner:active-provider": "claude",
      "tabrunner:conversations": conversations,
      "tabrunner:conversation:c-agents": chat1,
      "tabrunner:conversation:c-hn": chat2,
      "tabrunner:active-conversation": active,
    } as Record<string, unknown>,
  );
  await page.close();
}

// ── on-page marks (markup mirrors indicator.ts / status-widget.ts) ───────────
// ponytail: a hand mirror, not the real paint functions — page.evaluate would
// need the built bundle's internals. When the marks' markup changes, change it
// here too (the "Open" button drifted invisible for a whole release cycle).
const BADGE_CSS = `
  display:flex;align-items:center;gap:6px;padding:6px 10px;border-radius:9999px;
  background:#0b1224ee;color:#e8eefb;font:500 12px/1.2 ui-sans-serif,system-ui,sans-serif;
  box-shadow:0 2px 12px #0000004d,0 0 0 1px #34d39966;`;
const AMBER_DOT = `width:6px;height:6px;border-radius:9999px;background:#fbbf24;flex:none;`;

async function injectBadge(page: Page) {
  await page.evaluate(
    (css, dot) => {
      const el = document.createElement("div");
      el.style.cssText = `position:fixed;top:12px;right:12px;z-index:2147483647;${css}`;
      el.innerHTML =
        `<span style="${dot}"></span>` +
        `<span>TabRunner is controlling this tab</span>` +
        `<span style="color:#6ee7b7;padding:3px 8px">Hide</span>`;
      document.body.appendChild(el);
    },
    BADGE_CSS,
    AMBER_DOT,
  );
}

async function injectWidget(page: Page, task: string, queued: string) {
  await page.evaluate(
    (css, dot, t, q) => {
      const el = document.createElement("div");
      // One mark, one corner: the ambient pill lives top-right with the badge.
      el.style.cssText = `position:fixed;top:12px;right:12px;z-index:2147483647;${css}`;
      // The pill's content IS the open control — there is no Open button.
      el.innerHTML =
        `<span style="${dot}"></span>` +
        `<span style="color:#6ee7b7">TabRunner ·</span>` +
        `<span style="max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${t}</span>` +
        (q
          ? `<span style="padding:1px 6px;border-radius:9999px;background:#fbbf2426;color:#fcd34d;font-size:11px">${q}</span>`
          : "") +
        `<span style="color:#6ee7b7;padding:3px 8px">Hide</span>`;
      document.body.appendChild(el);
    },
    BADGE_CSS,
    AMBER_DOT,
    task,
    queued,
  );
}

// ── shooting ────────────────────────────────────────────────────────────────
async function shootPage(url: string, mark?: "badge" | "widget"): Promise<string> {
  const page = await browser.newPage();
  await page.setViewport({ width: W - PANEL_W, height: H });
  await page.goto(url, { waitUntil: "networkidle2", timeout: 45_000 });
  // Wikipedia's fundraiser notices dominate the frame — they rotate and geo-target,
  // so hide them rather than hope a shoot day has none.
  await page.addStyleTag({
    content: "#siteNotice, .frb-inline, #frb-inline, .centralNotice { display: none !important; }",
  });
  await new Promise((r) => setTimeout(r, 800));
  if (mark === "badge") await injectBadge(page);
  if (mark === "widget")
    await injectWidget(page, "what are the top stories on Hacker N…", "+1 queued");
  const buf = await page.screenshot({ encoding: "base64" });
  await page.close();
  return String(buf);
}

/**
 * The panel half of a composite — `stageUrl` is the page it will be pasted
 * beside.
 *
 * That argument is load-bearing, not cosmetic. The composer asks whether the
 * *active* tab is one Chrome blocks (`useRestrictedPage`), and a panel shot on
 * its own answers "yes" — because the only tab open is the panel's own
 * `chrome-extension://` page, which genuinely is blocked. The composite then
 * pasted that warning next to a Wikipedia article, so the store's lead image
 * said the product could not work on the page beside it, directly under a "This
 * page" chip saying it would. Parking the real page in front makes the panel
 * answer about the page the shot actually shows.
 */
async function shootPanel(stageUrl: string, typeIntoComposer?: string): Promise<string> {
  const page = await browser.newPage();
  await page.setViewport({ width: PANEL_W, height: H });
  await page.goto(`chrome-extension://${extId}/sidepanel.html`, { waitUntil: "networkidle0" });
  await new Promise((r) => setTimeout(r, 800));
  // Typed while the panel still holds focus; the stage comes forward after.
  if (typeIntoComposer) {
    await page.click("textarea");
    await page.type("textarea", typeIntoComposer, { delay: 8 });
    await new Promise((r) => setTimeout(r, 300));
  }
  const stage = await browser.newPage();
  await stage.goto(stageUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
  await stage.bringToFront();
  // The panel re-asks on chrome.tabs.onActivated — give that round trip a beat.
  await new Promise((r) => setTimeout(r, 600));
  const buf = await page.screenshot({ encoding: "base64" });
  await stage.close();
  await page.close();
  return String(buf);
}

async function composite(page64: string, panel64: string, out: string) {
  const page = await browser.newPage();
  await page.setViewport({ width: W, height: H });
  const dataUrl = await page.evaluate(
    async (p64, pan64, pw, w, h) => {
      const load = (src: string) =>
        new Promise<HTMLImageElement>((res) => {
          const i = new Image();
          i.onload = () => res(i);
          i.src = src;
        });
      const [p, pan] = await Promise.all([
        load(`data:image/png;base64,${p64}`),
        load(`data:image/png;base64,${pan64}`),
      ]);
      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      const ctx = c.getContext("2d")!;
      ctx.drawImage(p, 0, 0);
      ctx.fillStyle = "#25325c"; // the window's panel divider
      ctx.fillRect(w - pw - 1, 0, 1, h);
      ctx.drawImage(pan, w - pw, 0);
      return c.toDataURL("image/png");
    },
    page64,
    panel64,
    PANEL_W,
    W,
    H,
  );
  writeFileSync(out, Buffer.from(dataUrl.split(",")[1], "base64"));
  console.log(`✓ ${out.split("/").pop()}`);
  await page.close();
}

// ── the captured set (order matches store-listing.md §4) ─────────────────────
// Each composite's two halves must be looking at the SAME page — the panel asks
// the active tab what it is, so a mismatch shows up as the panel narrating a
// page that isn't the one beside it. One constant per shot, used twice.
const SHOT_01_URL = "https://en.wikipedia.org/wiki/Web_browser";
const SHOT_02_URL = "https://en.wikipedia.org/wiki/Intelligent_agent";
const SHOT_04_URL = "https://news.ycombinator.com";

await seed(null); // fresh conversation for the card shot
await composite(
  await shootPage(SHOT_01_URL),
  await shootPanel(SHOT_01_URL, "search for LLM browser agents and summarize for me"),
  join(outDir, "01-side-panel.png"),
);

await seed("c-agents");
await composite(
  await shootPage(SHOT_02_URL, "badge"),
  await shootPanel(SHOT_02_URL),
  join(outDir, "02-chat.png"),
);

{
  // 03 — options page, Providers tab, full frame (no panel composite)
  await seed("c-agents");
  const page = await browser.newPage();
  await page.setViewport({ width: W, height: H });
  await page.goto(`chrome-extension://${extId}/options.html`, { waitUntil: "networkidle0" });
  await new Promise((r) => setTimeout(r, 800));
  await page.evaluate(() => {
    const nav = [...document.querySelectorAll("button, a")].find(
      (el) => el.textContent?.trim() === "Providers",
    );
    if (nav instanceof HTMLElement) nav.click();
  });
  await new Promise((r) => setTimeout(r, 500));
  await page.screenshot({ path: join(outDir, "03-providers.png") });
  console.log("✓ 03-providers.png");
  await page.close();
}

await seed("c-hn");
await composite(
  await shootPage(SHOT_04_URL, "widget"),
  await shootPanel(SHOT_04_URL),
  join(outDir, "04-chat-2.png"),
);

await browser.close();
console.log("done — 4 shots in docs/screenshots/");

// The site serves webp derivatives of these — refresh them too when the
// sibling repo is checked out next to this one (`bun run sync` there).
const siteRoot = join(root, "..", "site");
if (existsSync(join(siteRoot, "scripts", "sync-assets.ts"))) {
  execFileSync("bun", ["run", "sync"], { cwd: siteRoot, stdio: "inherit" });
}
