import { StrictMode } from "react";
import { createRoot, hydrateRoot } from "react-dom/client";
import { App } from "./App";
import { splitLocalePath } from "./config/locale";
import { PRERENDERED_ROUTE_ATTR } from "./config/publicPages";
import { redirectTarget } from "./i18n";
import "./index.css";

// The one hop the old language detector still gets: an unprefixed address may send a reader to
// their own language BEFORE anything renders, so nothing flashes and no history entry is left
// behind. A reader who followed a link to /pt or /es is never moved off it, and a crawler never
// takes this at all — which is the whole point, since the address is what carries the language now.
const hop = redirectTarget(location.pathname, location.search, location.hash);
if (hop) {
  location.replace(hop);
} else {
  // `/privacy/` and `/privacy` are one page; the root stays `/`.
  const here = location.pathname.replace(/\/+$/, "") || "/";
  const rootEl = document.getElementById("root")!;
  const tree = (
    <StrictMode>
      <App route={splitLocalePath(location.pathname).path} />
    </StrictMode>
  );

  // Hydrate the render this file IS, and mount fresh over anything else.
  //
  // "Does the root have children" is not the question: an unpublished address is answered by a 404
  // shell, which has a page rendered into it — so it arrives at a full root holding somebody else's
  // markup. Hydrating that is React reconciling two different pages; it recovers by throwing the
  // tree away and logging, which is a page that works and a bug nobody sees. The file names its own
  // route, so we can ask.
  if (rootEl.getAttribute(PRERENDERED_ROUTE_ATTR) === here) {
    hydrateRoot(rootEl, tree);
  } else {
    createRoot(rootEl).render(tree);
  }
}
