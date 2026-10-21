import { antigravityUserAgent, OPENCODE_CLI_USER_AGENT } from "@providerkit/core";
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
const ZEN_UA_RULE_ID = 2;
const ANTIGRAVITY_UA_RULE_ID = 3;

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
  // Antigravity: the token endpoint, and the production Cloud Code Assist host
  // that sign-in discovers the project on and inference falls back to (the daily
  // host is the preset's own).
  "oauth2.googleapis.com",
  "cloudcode-pa.googleapis.com",
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

/**
 * A rule that sets `User-Agent` on OUR calls to one endpoint.
 *
 * Chromium ignores a `User-Agent` set on fetch (checked in headless Chrome 155:
 * the server saw the stock one), so a client an endpoint recognises by that
 * header has to be stamped here, on the way out. Same `tabIds` boundary as the
 * Origin rule, for the same reason: the user's own browsing keeps its own UA.
 */
function userAgentRule(
  id: number,
  userAgent: string,
  match: { urlFilter: string } | { requestDomains: string[] },
): chrome.declarativeNetRequest.Rule {
  return {
    id,
    priority: 1,
    action: {
      type: "modifyHeaders",
      requestHeaders: [{ header: "user-agent", operation: "set", value: userAgent }],
    },
    condition: { ...match, resourceTypes: ["xmlhttprequest"], tabIds: [TAB_ID_NONE] },
  };
}

/**
 * OpenCode Zen's free tier only answers OpenCode's own User-Agent. Scoped to
 * `/zen/v1/`, so OpenCode Go (`/zen/go/v1/`) keeps asking as itself.
 */
function zenUserAgentRule(): chrome.declarativeNetRequest.Rule {
  return userAgentRule(ZEN_UA_RULE_ID, OPENCODE_CLI_USER_AGENT, {
    urlFilter: "||opencode.ai/zen/v1/",
  });
}

/**
 * Cloud Code Assist serves `gemini-4-argon` to the Antigravity CLI and the rest
 * to its IDE, and tells them apart by User-Agent. A model is known per run, so
 * a run restamps this before it streams; until then it holds the IDE one, which
 * is what sign-in sends.
 */
function antigravityUserAgentRule(model: string): chrome.declarativeNetRequest.Rule {
  return userAgentRule(ANTIGRAVITY_UA_RULE_ID, antigravityUserAgent(model), {
    requestDomains: ["cloudcode-pa.googleapis.com", "daily-cloudcode-pa.googleapis.com"],
  });
}

/**
 * Stamp the User-Agent Antigravity expects for `model` on the next calls.
 *
 * ponytail: one rule for the whole worker, so two runs on Antigravity models of
 * different clients, started within the same moment, can send each other's UA.
 * A run settles on the right one at its next turn. The upgrade path is a rule
 * per run, keyed by tab, if that ever shows up in practice.
 */
export async function stampAntigravityUserAgent(model: string): Promise<void> {
  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [ANTIGRAVITY_UA_RULE_ID],
      addRules: [antigravityUserAgentRule(model)],
    });
  } catch (e) {
    // The call still goes out with Chrome's own UA; the endpoint decides.
    log.warn("could not stamp the Antigravity user agent:", e);
  }
}

/** Install once per service-worker boot; Chrome dedupes the same rule id. */
export function initProviderOriginStrip(): void {
  const hosts = providerHosts();
  void chrome.declarativeNetRequest
    .updateSessionRules({
      removeRuleIds: [RULE_ID, ZEN_UA_RULE_ID, ANTIGRAVITY_UA_RULE_ID],
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
        zenUserAgentRule(),
        antigravityUserAgentRule(""),
      ],
    })
    .then(() => log.info("provider origin strip armed", { hosts: hosts.length }))
    .catch((e: unknown) => log.error("provider origin strip failed:", e));
}
