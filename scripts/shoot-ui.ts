/**
 * Visual inspection harness: loads the built extension (dist/chrome-mv3 — run
 * `bun run build` first) into Chrome for Testing and screenshots the options
 * page and side panel in light and dark. Output is gitignored (preview/).
 * For the store set use `bun run shots` instead.
 *
 *   bun run shots:ui
 */
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer, { type Page } from "puppeteer-core";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const extPath = join(root, "dist", "chrome-mv3");
const outDir = join(root, "preview", "shots");
mkdirSync(outDir, { recursive: true });

/**
 * Branded Chrome ignores --load-extension in headless; Chrome for Testing
 * doesn't. Resolve the newest CfT from the puppeteer cache, fall back to the
 * system Chrome.
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

const browser = await puppeteer.launch({
  executablePath: findChrome(),
  headless: true,
  args: [`--disable-extensions-except=${extPath}`, `--load-extension=${extPath}`],
});

// The extension id falls out of its service worker target.
let extId = "";
for (let i = 0; i < 50 && !extId; i++) {
  const sw = browser.targets().find((t) => t.type() === "service_worker");
  const match = sw?.url().match(/^chrome-extension:\/\/([^/]+)\//);
  if (match) extId = match[1];
  else await new Promise((r) => setTimeout(r, 100));
}
if (!extId) {
  console.error("extension service worker never appeared — is the build current?");
  process.exit(1);
}
console.log(`extension id: ${extId}`);

/**
 * Chrome's side panel opens around 400px and the options page is a wide
 * document — shooting both at 1280 made every panel review a lie, all the
 * whitespace in the world and no line ever wrapping where it really wraps.
 */
const SIDEPANEL_WIDTH = 400;

async function shoot(
  page_: string,
  name: string,
  dark: boolean,
  { width = 1280, prepare }: { width?: number; prepare?: (page: Page) => Promise<void> } = {},
) {
  const page = await browser.newPage();
  await page.setViewport({ width, height: 800 });
  await page.emulateMediaFeatures([
    { name: "prefers-color-scheme", value: dark ? "dark" : "light" },
  ]);
  await page.goto(`chrome-extension://${extId}/${page_}`, { waitUntil: "networkidle0" });
  await page.evaluate(() => void document.fonts.ready);
  await new Promise((r) => setTimeout(r, 600));
  // Surfaces a click or a scroll away — history, the folded top of a long
  // transcript — are as worth reviewing as the one the panel opens on.
  if (prepare) {
    await prepare(page);
    await new Promise((r) => setTimeout(r, 400));
  }
  await page.screenshot({ path: join(outDir, `${name}.png`) });
  console.log(`${name}: shot`);
  await page.close();
}

/**
 * A stand-in transcript, so the review sees the surface people actually live
 * in — plan card, step rows, bubbles, an error — instead of the empty state
 * the panel shows for about ten seconds of its life. Written straight to the
 * storage keys `defineItem` builds ("local:tabrunner:<key>").
 */
async function seedConversation() {
  const page = await browser.newPage();
  await page.goto(`chrome-extension://${extId}/sidepanel.html`);
  await page.evaluate(() => {
    const id = "shots-demo";
    const t = 1_700_000_000_000;
    let n = 0;
    const msg = (m: Record<string, unknown>) => ({ id: `m${++n}`, timestamp: t + n * 1000, ...m });
    return chrome.storage.local.set({
      // Without a provider the panel shows onboarding, transcript or not.
      "tabrunner:active-provider": "shots-provider",
      "tabrunner:providers": [
        {
          id: "shots-provider",
          name: "Anthropic",
          shape: "anthropic",
          baseUrl: "https://api.anthropic.com",
          apiKey: "sk-ant-preview",
          model: "claude-sonnet-4-5",
          reasoningEffort: "medium",
          createdAt: t,
        },
      ],
      "tabrunner:active-conversation": id,
      "tabrunner:conversations": [
        {
          id,
          title: "Pull the latest invoice from my inbox into the expense report",
          createdAt: t,
          updatedAt: t + 60_000,
          taskCount: 1,
        },
      ],
      [`tabrunner:conversation:${id}`]: [
        msg({
          role: "user",
          content: "Pull the latest invoice from my inbox into the expense report",
          tab: { title: "Inbox — webmail", url: "https://mail.example.com/inbox" },
        }),
        msg({
          role: "plan",
          content: "",
          steps: [
            "Open the inbox",
            "Find the latest invoice",
            "Open the expense report",
            "Attach it and fill the fields",
          ],
          current: 1,
        }),
        msg({ role: "reasoning", content: "Checking which tab is in front…", elapsed: 4200 }),
        // The shape a run really has: what the model says between two calls
        // sits between their rows. Runs of calls with nothing said fold; a
        // lone call stays a row of its own.
        msg({ role: "assistant", content: "The inbox is already open — starting there." }),
        msg({
          role: "step",
          tool: "navigate",
          ok: true,
          content: "",
          args: { url: "https://mail.example.com/inbox" },
        }),
        msg({
          role: "step",
          tool: "snapshot",
          ok: true,
          content: "",
          detail: "Read 214 elements",
        }),
        msg({
          role: "assistant",
          content: "Found the March invoice at the top. Opening the expense report.",
        }),
        msg({ role: "step", tool: "click", ok: true, content: "", args: { ref: "e42" } }),
        msg({
          role: "error",
          content:
            "The tab this task was driving (Inbox — webmail) was closed, so the task stopped. TabRunner needs the tab to stay open — reopen the page and send the task again.",
          kind: "network",
        }),
        msg({
          role: "assistant",
          content:
            "I found the **March invoice** (`INV-2291`, $412.60) and attached it to the expense report. The vendor and date fields are filled; the category is still blank because the form offers no match for “cloud hosting”.",
        }),
      ],
    });
  });
  await page.close();
}

/**
 * A thread long enough to fold, plus the neighbours that make a history list a
 * list. Seeded after the chat shots so those keep showing the demo transcript.
 */
async function seedLongThread() {
  const page = await browser.newPage();
  await page.goto(`chrome-extension://${extId}/sidepanel.html`);
  await page.evaluate(() => {
    const id = "shots-long";
    const t = 1_700_000_000_000;
    let n = 0;
    const msg = (m: Record<string, unknown>) => ({ id: `l${++n}`, timestamp: t + n * 1000, ...m });
    const messages = Array.from({ length: 12 }, (_, i) => [
      msg({ role: "user", content: `Check order #${1000 + i} and note its ship date` }),
      msg({
        role: "step",
        tool: "navigate",
        ok: true,
        content: "",
        args: { url: `https://shop.example.com/orders/${1000 + i}` },
      }),
      msg({
        role: "step",
        tool: "snapshot",
        ok: true,
        content: "",
        detail: "Read 118 elements",
      }),
      msg({ role: "assistant", content: "Order page is up — opening the shipping panel." }),
      msg({ role: "step", tool: "click", ok: true, content: "", args: { ref: "e12" } }),
      msg({ role: "assistant", content: `Order #${1000 + i} ships on the 12th.` }),
    ]).flat();
    return chrome.storage.local.set({
      "tabrunner:active-conversation": id,
      "tabrunner:conversations": [
        {
          id,
          title: "Check every open order and note the ship dates",
          createdAt: t,
          updatedAt: t + 600_000,
          taskCount: 12,
        },
        {
          id: "shots-demo",
          title: "Pull the latest invoice from my inbox into the expense report",
          createdAt: t,
          updatedAt: t - 3_600_000,
          taskCount: 1,
        },
        {
          id: "shots-agent",
          title: "Read the release notes and summarize what changed",
          createdAt: t,
          updatedAt: t - 86_400_000,
          taskCount: 4,
          agent: "Claude Code",
        },
      ],
      [`tabrunner:conversation:${id}`]: messages,
    });
  });
  await page.close();
}

for (const dark of [false, true]) {
  const mode = dark ? "dark" : "light";
  await shoot("options.html", `ext-options-${mode}`, dark);
  await shoot("sidepanel.html", `ext-sidepanel-${mode}`, dark, { width: SIDEPANEL_WIDTH });
}
await seedConversation();
for (const dark of [false, true]) {
  const mode = dark ? "dark" : "light";
  await shoot("sidepanel.html", `ext-chat-${mode}`, dark, { width: SIDEPANEL_WIDTH });
}
await seedLongThread();
for (const dark of [false, true]) {
  const mode = dark ? "dark" : "light";
  await shoot("sidepanel.html", `ext-fold-${mode}`, dark, {
    width: SIDEPANEL_WIDTH,
    prepare: (page) =>
      page.evaluate(() =>
        document.querySelector('[data-slot="message-scroller-viewport"]')?.scrollTo({ top: 0 }),
      ),
  });
  await shoot("sidepanel.html", `ext-history-${mode}`, dark, {
    width: SIDEPANEL_WIDTH,
    // The history toggle by shape, not by label — the panel speaks whatever
    // language the shooting browser is set to.
    prepare: (page) => page.click("button[aria-pressed]"),
  });
}
await browser.close();
