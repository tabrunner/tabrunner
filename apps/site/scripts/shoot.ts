/**
 * Visual inspection harness: screenshots the site at desktop/mobile sizes and
 * reports any element causing horizontal overflow. Uses the installed Chrome
 * via puppeteer-core (no browser download).
 *
 *   bun run scripts/shoot.ts [url]
 */
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const url = process.argv[2] ?? "http://localhost:5199";
const outDir = join(dirname(fileURLToPath(import.meta.url)), "..", "preview", "shots");
mkdirSync(outDir, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
});

async function shoot(name: string, width: number, height: number, lang?: string) {
  const page = await browser.newPage();
  await page.setViewport({ width, height });
  await page.goto(lang ? `${url}?lang=${lang}` : url, { waitUntil: "networkidle0" });
  await page.evaluate(() => void document.fonts.ready);
  // fullPage capture never scrolls, so anything gated on scroll position or lazy
  // loading stays blank — walk the page once, then return to the top.
  const pageHeight = await page.evaluate(() => document.documentElement.scrollHeight);
  for (let y = 0; y < pageHeight; y += height * 0.8) {
    await page.evaluate((to) => window.scrollTo(0, to), y);
    await new Promise((r) => setTimeout(r, 150));
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  await new Promise((r) => setTimeout(r, 1200));
  await page.screenshot({ path: join(outDir, `${name}.png`), fullPage: true });

  const overflowers = await page.evaluate((vw) => {
    const bad: string[] = [];
    for (const el of document.querySelectorAll("*")) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.right > vw + 1) {
        const cls = typeof el.className === "string" ? el.className.slice(0, 80) : "";
        bad.push(`${el.tagName.toLowerCase()}.${cls} right=${Math.round(r.right)}`);
      }
    }
    return {
      scrollWidth: document.documentElement.scrollWidth,
      bad: bad.slice(0, 12),
    };
  }, width);
  console.log(
    `${name}: ${width}px viewport, scrollWidth=${overflowers.scrollWidth}` +
      (overflowers.bad.length
        ? `\n  OVERFLOW:\n  ${overflowers.bad.join("\n  ")}`
        : ". No overflow"),
  );
  await page.close();
}

await shoot("desktop-hero", 1440, 900, "en-US");
await shoot("desktop-full", 1440, 900);
await shoot("mobile-full", 390, 844, "es-ES");
await browser.close();
