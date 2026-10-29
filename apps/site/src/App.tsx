/**
 * DIRECTION CONTRACT — tabrunner.app, "The Comet Field" (see DESIGN.md)
 *
 * THESIS: Tabs are comets — the browser's tab strip is a night sky, and every
 * task launches a tab that streaks across it with an emerald burn trail.
 * Refuses the category default (glowing orb hero + uniform bento of icon cards).
 * OWN-WORLD: deep-field indigo ground (#070b16 family); only two lights —
 * burn emerald (#10b981 family) for motion, telemetry amber (#fbbf24) for
 * measurement; Unbounded display / Figtree body / JetBrains Mono telemetry;
 * the comet-tab glyph recurs from favicon to canvas to screenshot frame.
 * STORY: a visitor sees a task enter the mission line, a comet leave it, and
 * a (labelled, simulated) run tick beside them — they understand in seconds
 * that an AI drives *their* browser, visibly, under their control — and they
 * install it from the store.
 * FIRST VIEWPORT: the page's own browser-chrome bar (comet favicon, omnibox,
 * glowing Download action); headline left with mission line and CTAs; live
 * run console right; comet field canvas behind everything.
 * FORM: browser chrome as compositional material, fused with the
 * user-pinned dark-cosmic energy and the comet-burn palette (it replaced the
 * retired royal purple, and the extension wears the same palette).
 */

import { CometField } from "./components/CometField";
import { DocsPage } from "./components/DocsPage";
import { Features } from "./components/Features";
import { Footer } from "./components/Footer";
import { Hero } from "./components/Hero";
import { Install } from "./components/Install";
import { LegalPage } from "./components/LegalPage";
import { Nav } from "./components/Nav";
import { Privacy } from "./components/Privacy";
import { Screenshots } from "./components/Screenshots";

/**
 * No router, and now no `window` either: the route is passed in.
 *
 * The build renders this file to real HTML for every page in every language, where there is no
 * address to read — and the caller that DOES have one (`main.tsx`) already had to strip the
 * language segment off it, so reading `location` here would have been a second, disagreeing
 * answer to the same question.
 */
export function App({ route }: { route: string }) {
  if (route === "/privacy") return <LegalPage doc="privacy" />;
  if (route === "/terms") return <LegalPage doc="terms" />;
  if (route === "/docs") return <DocsPage />;

  return (
    <>
      <CometField />
      <Nav route={route} />
      <main id="main">
        <Hero />
        <Features />
        <Screenshots />
        <Install />
        <Privacy />
      </main>
      <Footer route={route} />
    </>
  );
}
