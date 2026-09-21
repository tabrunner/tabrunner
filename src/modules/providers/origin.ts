import { PRESETS } from "./presets";
import { createLogger } from "@/lib/logger";

const log = createLogger("provider-origin");

/**
 * Subscription OAuth tokens refuse to work from a browser Origin.
 *
 * Anthropic's per-organization CORS gate answers 401 — "CORS requests are not
 * allowed for this Organization because of its settings" — for an OAuth access
 * token that arrives with any `Origin:` header. The agent's own fetch sends
 * one: an MV3 service worker is a document context (the way the DOM defines a
 * fetch), so Chrome stamps every worker-initiated provider call with
 * `Origin: chrome-extension://<id>` — even with `<all_urls>` host permission,
 * which makes CORS *bypassable*, not absent. A CLI has no Origin at all, which
 * is why the same credential succeeds in opencodex and fails here.
 *
 * The fix is to stop asking for one: a declarativeNetRequest rule strips
 * `Origin` (and the companion `Referer`) from our own provider calls before
 * they leave the browser. The request then presents exactly the way a CLI's
 * does, and the credential is honored. This replaces the old
 * `anthropic-dangerous-direct-browser-access` header, which asked Anthropic to
 * allow CORS for the token instead — it was never honored at an extension
 * Origin, only at a first-party web one.
 */

const RULE_ID = 1;

/**
 * `chrome.tabs.TAB_ID_NONE` as a literal. A request that belongs to no tab is
 * one our service worker made — see the condition below for why that matters.
 * Spelled out rather than read off `chrome.tabs`, which isn't stubbed in the
 * contexts that only need the rule's shape.
 */
const TAB_ID_NONE = -1;

/**
 * Hosts no preset's `baseUrl` names: where vendors issue tokens, and where a
 * vendor serves inference from a host it picks per account. Same entitlement
 * question as the preset hosts — these are ours to call because a preset signs
 * in through them. A domain here covers its subdomains, which is what makes
 * one `githubcopilot.com` entry enough for every Copilot plan's own proxy.
 */
const EXTRA_HOSTS = [
  "claude.ai",
  "auth.openai.com",
  "auth.kimi.ai",
  "auth.x.ai",
  "auth.meta.com",
  "api.meta.ai",
  "github.com",
  "githubcopilot.com",
];

/**
 * Provider hosts we are entitled to call — every preset's own, plus the
 * hosts above. Derived, not hand-listed: a preset whose host was
 * forgotten here would sign in fine and then fail its first real call with a
 * CORS 401, which reads as a broken account rather than a missing line in a
 * constant. Local endpoints (Ollama) drop out — nothing to strip, and a
 * bare `localhost` is not a domain this rule can name.
 *
 * A custom endpoint the user typed in is deliberately NOT here, so the rule
 * can never be a way to hide who we are from a host we were never going to
 * talk to anyway.
 */
export function providerHosts(): string[] {
  const hosts = new Set(EXTRA_HOSTS);
  for (const preset of PRESETS) {
    try {
      const { hostname } = new URL(preset.baseUrl);
      if (hostname.includes(".")) hosts.add(hostname);
    } catch {
      // A preset with an unparseable baseUrl is a wiring bug the form would
      // catch first; it must not take the whole rule down with it.
    }
  }
  return [...hosts];
}

/** Install once per service-worker boot; Chrome dedupes the same rule id. */
export function initProviderOriginStrip(): void {
  const hosts = providerHosts();
  void chrome.declarativeNetRequest
    .updateSessionRules({
      removeRuleIds: [RULE_ID],
      addRules: [
        {
          id: RULE_ID,
          priority: 1,
          action: {
            type: "modifyHeaders",
            requestHeaders: [
              { header: "origin", operation: "remove" },
              { header: "referer", operation: "remove" },
            ],
          },
          condition: {
            requestDomains: hosts,
            resourceTypes: ["xmlhttprequest"],
            // OUR fetches only. A rule matched on host alone also strips the
            // Origin off requests the user's own tabs make to these hosts —
            // and Origin is half of how a site checks a request came from
            // itself, so browsing github.com with the extension installed
            // would be handing pages a broken CSRF defence. Requests from the
            // service worker belong to no tab, which is exactly the set we
            // want and the one thing a page request can never look like.
            tabIds: [TAB_ID_NONE],
          },
        },
      ],
    })
    .then(() => log.info("provider origin strip armed", { hosts: hosts.length }))
    .catch((e: unknown) => log.error("provider origin strip failed:", e));
}
