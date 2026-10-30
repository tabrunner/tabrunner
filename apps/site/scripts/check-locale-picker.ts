// Run directly with bun scripts/check-locale-picker.ts, not through CI.
import { strict as assert } from "node:assert";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Nav } from "../src/components/Nav";
import { localePath, SUPPORTED_LANGUAGES } from "../src/config/locale";

const nav = renderToStaticMarkup(createElement(Nav));
for (const language of SUPPORTED_LANGUAGES) {
  assert.ok(nav.includes(`href="${localePath(language, "/")}?lang=${language}"`));
}

// A context-menu choice replaces old lang values and keeps other values and the fragment.
Object.defineProperty(globalThis, "window", {
  configurable: true,
  value: {
    location: new URL("https://tabrunner.app/es?lang=pt-BR&lang=es-ES&tag=a&tag=b#install"),
  },
});
try {
  const currentNav = renderToStaticMarkup(createElement(Nav));
  for (const language of SUPPORTED_LANGUAGES) {
    assert.ok(
      currentNav.includes(
        `href="${localePath(language, "/")}?lang=${language}&amp;tag=a&amp;tag=b#install"`,
      ),
    );
  }
} finally {
  Reflect.deleteProperty(globalThis, "window");
}
console.log("Locale picker check passed.");
