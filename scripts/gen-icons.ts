#!/usr/bin/env bun
// Generate the extension icon set and the social OG card from the brand mark
// in src/shared/logo.ts (same pattern as olhary/featury gen-icons).
//
//   bun run icons          # or: bun run scripts/gen-icons.ts
//
// resvg rasterizes the SVGs; everything else is Bun-native. Chrome extensions
// want plain PNGs (no .ico), so the olhary png-to-ico step doesn't apply here.
//
// The OG card is the same comet-ice composition as the site's
// (site/scripts/gen-og.ts) — deep-field ground, star field, comet-tab mark,
// the tagline in Unbounded. The two cards must not drift.
import { Resvg } from "@resvg/resvg-js";
import { cometSvg, tileIconSvg } from "../src/shared/logo.ts";

const ROOT = `${import.meta.dir}/..`;
// OFL-licensed TTFs vendored in assets/fonts/ (resvg's fontdb needs TTF, not woff2).
const FONTS = ["Unbounded.ttf", "Figtree.ttf", "JetBrainsMono.ttf"].map(
  (f) => `${ROOT}/assets/fonts/${f}`,
);

function renderPng(svg: string, width: number, withText = false): Buffer {
  const r = new Resvg(svg, {
    fitTo: { mode: "width", value: width },
    font: withText ? { fontFiles: FONTS, loadSystemFonts: false } : { loadSystemFonts: true },
  });
  return Buffer.from(r.render().asPng());
}

// ── social OG image (1200×630) — upload manually as the GitHub repo's social preview ──
function ogSvg(): string {
  const W = 1200;
  const H = 630;

  // deterministic star field (seeded pseudo-random, so the card is reproducible)
  let seed = 42;
  const rand = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  const stars = Array.from({ length: 90 }, () => {
    const x = rand() * W;
    const y = rand() * H;
    const r = 0.4 + rand() * 1.1;
    const o = 0.15 + rand() * 0.5;
    return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r.toFixed(2)}" fill="#e8eefb" opacity="${o.toFixed(2)}" />`;
  }).join("\n  ");

  // The hero comet flies with a long ion trail instead of the mark's two bars,
  // so its tab silhouette repeats the logo.ts geometry inline (scale 4.4).
  const heroComet = `
  <g transform="translate(920, 105) rotate(18) scale(4.4)">
    <path d="M 23 19.5 L 5 16 L 23 23 Z" fill="#6ee7b7" opacity="0.85" />
    <path d="M 23 24 L 8 30.5 L 23 27.5 Z" fill="#34d399" opacity="0.55" />
    <path d="M 23 30 L 23 20.5 Q 23 17 26.5 17 L 37.5 17 Q 41 17 41 20.5 L 41 30 Z" fill="#e8eefb" />
    <circle cx="27" cy="21.5" r="1.8" fill="#10b981" />
  </g>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <linearGradient id="ground" x1="0" y1="0" x2="${W}" y2="${H}" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#0b1224" />
      <stop offset="1" stop-color="#04060d" />
    </linearGradient>
    <linearGradient id="trail" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#34d399" stop-opacity="0" />
      <stop offset="1" stop-color="#34d399" stop-opacity="0.8" />
    </linearGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#ground)" />
  ${stars}
  <path d="M 150 520 L 960 220" stroke="url(#trail)" stroke-width="3" stroke-linecap="round" opacity="0.5" />
  ${heroComet}
  <g transform="translate(96, 108) scale(0.8)">${cometSvg()}</g>
  <text x="146" y="140" font-family="JetBrains Mono" font-size="21" letter-spacing="6" fill="#e8eefb">TABRUNNER</text>
  <text x="96" y="196" font-family="JetBrains Mono" font-size="21" letter-spacing="6" fill="#6ee7b7">BROWSER AGENT · ANY PROVIDER</text>
  <text x="92" y="330" font-family="Unbounded" font-weight="600" font-size="76" letter-spacing="-1" fill="#e8eefb">You give the goal.</text>
  <text x="92" y="426" font-family="Unbounded" font-weight="600" font-size="76" letter-spacing="-1" fill="#34d399">It runs the tabs.</text>
  <text x="96" y="500" font-family="Figtree" font-size="27" fill="#b9c6de">An AI agent uses your browser tabs, sessions and logins</text>
  <text x="96" y="538" font-family="Figtree" font-size="27" fill="#b9c6de">with any provider you choose.</text>
  <text x="96" y="586" font-family="JetBrains Mono" font-size="19" fill="#8797ba">tabrunner.app</text>
  <rect x="0" y="${H - 8}" width="${W}" height="8" fill="#34d399" />
</svg>`;
}

// ── emit ──────────────────────────────────────────────────────────────────────
console.log("tabrunner · generating brand assets → public/icon, docs/\n");

let bytes = 0;
let count = 0;
const write = async (file: string, data: string | Buffer) => {
  bytes += await Bun.write(`${ROOT}/${file}`, data);
  count += 1;
  console.log(`   ✓ ${file}`);
};

const TILE = tileIconSvg();
await write("public/icon.svg", TILE + "\n");
for (const size of [16, 32, 48, 96, 128]) {
  // 16px gets the trail-less small variant — trails dissolve below that size.
  await write(
    `public/icon/${size}.png`,
    renderPng(size === 16 ? tileIconSvg("small") : TILE, size),
  );
}
await write("docs/og.png", renderPng(ogSvg(), 1200, true));

console.log(`\ndone — ${count} files, ${(bytes / 1024).toFixed(1)} KB.`);
