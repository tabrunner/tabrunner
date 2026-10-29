// One page, in one language, as markup — the build-time half of `main.tsx`.
import { StrictMode } from "react";
import { prerender } from "react-dom/static.browser";
import { I18nextProvider } from "react-i18next";
import { App } from "./App";
import type { SupportedLanguage } from "./config/locale";
import { createI18n } from "./i18n";

/**
 * `prerender` from `react-dom/static`, never `renderToString`: the latter renders a Suspense
 * FALLBACK instead of waiting for it, so the first component that gets code-split would silently
 * start shipping a loading state as the whole indexable body with every gate still green.
 *
 * @public — imported by `scripts/prerender.ts` out of the BUILT bundle, so no source file
 * references it.
 */
export async function renderPage(language: SupportedLanguage, route: string): Promise<string> {
  // React treats most render errors as recoverable and logs them. A build must not: a page that
  // threw is a page whose markup is wrong, and shipping it silently is the failure this whole
  // script exists to prevent.
  let failure: unknown;

  const { prelude } = await prerender(
    <StrictMode>
      <I18nextProvider i18n={createI18n(language)}>
        <App route={route} />
      </I18nextProvider>
    </StrictMode>,
    {
      onError(error: unknown) {
        failure ??= error;
      },
    },
  );

  const html = await new Response(prelude).text();
  if (failure !== undefined) throw failure;
  return html;
}
