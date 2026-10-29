/**
 * Generates public/og.png (1200×630 social card) in the comet-burn brand:
 * deep-field ground, star field, the comet-tab mark with its burn trail,
 * the tagline in Unbounded, details in Figtree. Run after brand changes:
 *   bun run scripts/gen-og.ts
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// OFL-licensed TTFs vendored in assets/fonts/ (resvg's fontdb needs TTF, not woff2).
const font = (name: string) => join(root, "assets", "fonts", name);

// deterministic star field (seeded pseudo-random, so the card is reproducible)
let seed = 42;
const rand = () => {
  seed = (seed * 16807) % 2147483647;
  return seed / 2147483647;
};
const stars = Array.from({ length: 90 }, () => {
  const x = rand() * 1200;
  const y = rand() * 630;
  const r = 0.4 + rand() * 1.1;
  const o = 0.15 + rand() * 0.5;
  return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r.toFixed(2)}" fill="#e8eefb" opacity="${o.toFixed(2)}" />`;
}).join("\n  ");

// the comet-tab mark, scaled up, mid-flight with a long burn trail
const cometTab = `
  <g transform="translate(920, 105) rotate(18) scale(4.4)">
    <path d="M 23 19.5 L 5 16 L 23 23 Z" fill="#6ee7b7" opacity="0.85" />
    <path d="M 23 24 L 8 30.5 L 23 27.5 Z" fill="#34d399" opacity="0.55" />
    <path d="M 23 30 L 23 20.5 Q 23 17 26.5 17 L 37.5 17 Q 41 17 41 20.5 L 41 30 Z" fill="#e8eefb" />
    <circle cx="27" cy="21.5" r="1.8" fill="#10b981" />
  </g>`;

// small mark + wordmark, top-left
const wordmark = `
  <g transform="translate(96, 108) scale(0.8)">
    <path d="M 23 30 L 23 20.5 Q 23 17 26.5 17 L 37.5 17 Q 41 17 41 20.5 L 41 30 Z" fill="#e8eefb" />
    <circle cx="27" cy="21.5" r="1.8" fill="#10b981" />
    <rect x="7" y="19.5" width="12" height="3.25" rx="1.625" fill="#34d399" />
    <rect x="10" y="26.25" width="9" height="3.25" rx="1.625" fill="#6ee7b7" />
  </g>
  <text x="146" y="140" font-family="JetBrains Mono" font-size="21" letter-spacing="6" fill="#e8eefb">TABRUNNER</text>`;

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <defs>
    <linearGradient id="ground" x1="0" y1="0" x2="1200" y2="630" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#0b1224" />
      <stop offset="1" stop-color="#04060d" />
    </linearGradient>
    <linearGradient id="trail" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#34d399" stop-opacity="0" />
      <stop offset="1" stop-color="#34d399" stop-opacity="0.8" />
    </linearGradient>
  </defs>
  <rect width="1200" height="630" fill="url(#ground)" />
  ${stars}
  <path d="M 150 520 L 960 220" stroke="url(#trail)" stroke-width="3" stroke-linecap="round" opacity="0.5" />
  ${cometTab}
  ${wordmark}
  <text x="96" y="196" font-family="JetBrains Mono" font-size="21" letter-spacing="6" fill="#6ee7b7">BROWSER AGENT · ANY PROVIDER</text>
  <text x="92" y="330" font-family="Unbounded" font-weight="600" font-size="76" letter-spacing="-1" fill="#e8eefb">You give the goal.</text>
  <text x="92" y="426" font-family="Unbounded" font-weight="600" font-size="76" letter-spacing="-1" fill="#34d399">It runs the tabs.</text>
  <text x="96" y="500" font-family="Figtree" font-size="27" fill="#b9c6de">An AI agent drives your real browser, with your tabs, sessions</text>
  <text x="96" y="538" font-family="Figtree" font-size="27" fill="#b9c6de">and logins, through any provider you choose.</text>
  <text x="96" y="586" font-family="JetBrains Mono" font-size="19" fill="#8797ba">tabrunner.app</text>
  <rect x="0" y="622" width="1200" height="8" fill="#34d399" />
</svg>`;

const resvg = new Resvg(svg, {
  fitTo: { mode: "width", value: 1200 },
  font: {
    fontFiles: [font("Unbounded.ttf"), font("Figtree.ttf"), font("JetBrainsMono.ttf")],
    loadSystemFonts: false,
  },
});
writeFileSync(join(root, "public", "og.png"), resvg.render().asPng());
console.log("wrote public/og.png");
