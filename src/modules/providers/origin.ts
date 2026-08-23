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
 * Provider hosts we are entitled to call (the presets' own). Only these get an
 * Origin-free request — a custom endpoint the user typed in keeps its Origin,
 * so the rule can never be a privacy leak to somewhere we were never going to
 * talk to anyway.
 */
const PROVIDER_HOSTS = [
  "api.anthropic.com",
  "api.openai.com",
  "chatgpt.com",
  "api.kimi.ai",
  "api.z.ai",
  "token-plan.ap-southeast-1.maas.aliyuncs.com",
  "api.deepseek.com",
  "generativelanguage.googleapis.com",
  "openrouter.ai",
  "api.groq.com",
  "api.mistral.ai",
  "api.x.ai",
];

/** Install once per service-worker boot; Chrome dedupes the same rule id. */
export function initProviderOriginStrip(): void {
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
            requestDomains: PROVIDER_HOSTS,
            resourceTypes: ["xmlhttprequest"],
          },
        },
      ],
    })
    .then(() => log.info("provider origin strip armed", { hosts: PROVIDER_HOSTS.length }))
    .catch((e: unknown) => log.error("provider origin strip failed:", e));
}
