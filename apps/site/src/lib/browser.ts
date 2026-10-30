/**
 * Which browser the visitor is on, so the download CTA can name it
 * ("Baixar para Brave") instead of the jargon-y "Chromium" — which only
 * stays when the browser really is an unbranded Chromium (Helium & co.
 * ride a plain Chrome UA, so "Chromium" IS the honest answer for them).
 *
 * No package: the UA tokens below plus Brave's own API. Brave hides from
 * the UA by design, so `navigator.brave.isBrave()` is the only signal —
 * every detection library ends up calling it too.
 */
export interface BrowserGuess {
  /** Display name for the CTA — "Chromium" when the fork doesn't identify itself. */
  name: string;
  chromium: boolean;
}

/** Order matters: every fork's UA also carries the Chrome token. */
const UA_TOKENS: Array<[RegExp, string]> = [
  [/Edg(?:A)?\//, "Edge"],
  [/OPR\/|Opera/, "Opera"],
  [/Vivaldi\//, "Vivaldi"],
  [/SamsungBrowser\//, "Samsung Internet"],
  [/Arc\//, "Arc"],
  // Helium ships a vanilla Chrome UA today (privacy fork — branding would
  // fingerprint); the token is here for the day it identifies itself.
  [/Helium\//, "Helium"],
  [/YaBrowser\//, "Yandex"],
  [/Whale\//, "Whale"],
  [/Chrome\//, "Chrome"],
  [/Chromium\//, "Chromium"],
];

export async function detectBrowser(): Promise<BrowserGuess> {
  const ua = navigator.userAgent;
  // iOS browsers are all WebKit and none take extensions; desktop Firefox and
  // Safari have no trusted-input API. Both get the explanation, not a button.
  if (/FxiOS|CriOS|EdgiOS|Firefox\//.test(ua)) return { name: "Firefox", chromium: false };
  if (/Safari\//.test(ua) && !/Chrom(e|ium)\//.test(ua)) return { name: "Safari", chromium: false };
  const brave = (navigator as { brave?: { isBrave?: () => Promise<unknown> } }).brave;
  try {
    if (await brave?.isBrave?.()) return { name: "Brave", chromium: true };
  } catch {
    // Not Brave — the UA tokens decide.
  }
  for (const [token, name] of UA_TOKENS) {
    if (token.test(ua)) return { name, chromium: true };
  }
  return { name: "Chromium", chromium: true };
}
