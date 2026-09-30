import { i18n } from "@/i18n";
import { LINKS } from "./links";
import { truncate } from "./logger";

/**
 * The provider facts a bug report needs, structurally satisfied by
 * `ProviderConfig` — declared here so `lib/` never imports a module.
 */
export interface ReportProvider {
  name: string;
  shape: string;
  /** Absent = auto; the endpoint picks the model, which is itself a fact worth reporting. */
  model?: string;
  baseUrl: string;
}

/**
 * What the person reviews before anything leaves TabRunner. The review dialog
 * edits both fields; `issueUrl` sends whatever they hold at that moment, so an
 * emptied `details` is a report with no diagnostics at all.
 */
export interface IssueDraft {
  /** The error's first line, or empty — a report opened from a menu is titled by the person filing it. */
  title: string;
  /** The error and the environment, one labeled line per fact, already scrubbed. */
  details: string;
}

/** Room for a provider body without risking GitHub's ~8 KB URL ceiling. */
const ERROR_LIMIT = 800;
const TITLE_LIMIT = 90;
const HIDDEN = "[hidden]";

/**
 * The facts a bug report carries, assembled locally for the review dialog.
 * The product's only feedback path, and the one that keeps the no-telemetry
 * promise: nothing is collected, and nothing goes anywhere until the person
 * has seen this text and pressed Open GitHub.
 *
 * Deliberately absent: the API key, the conversation, and anything read off a
 * page. The endpoint's HOST only, never the path — a custom gateway is the
 * usual reason a provider bug won't reproduce, so it earns its line, but the
 * path can carry a tenant or a token. The error is the one raw input, so it
 * is scrubbed here, before truncation: cutting a string short removes the
 * end of it, not the private parts.
 *
 * English on purpose: the headings are the repo's language, not the UI's. Only
 * the dialog around it is translated — a pt-BR user writes their report in
 * whatever language they like, into an English skeleton the maintainer reads.
 */
export function issueDraft(opts: { provider?: ReportProvider; error?: string } = {}): IssueDraft {
  const { provider, error } = opts;
  const clean = error ? scrub(error) : "";
  const lines: string[] = [];

  if (clean) lines.push("### Error", "", "```text", truncate(clean, ERROR_LIMIT), "```", "");

  lines.push(
    "### Environment",
    "",
    `- TabRunner ${chrome.runtime.getManifest().version} · UI language \`${i18n.language}\``,
    `- \`${navigator.userAgent}\``,
    provider
      ? `- Provider: ${provider.name} (\`${provider.shape}\`) · model \`${provider.model ?? "auto"}\``
      : "- Provider: none configured",
  );
  if (provider) lines.push(`- Endpoint: \`${hostOf(provider.baseUrl)}\``);

  // Only the error path names the issue: it has the one sentence that belongs
  // in a title. A report opened from the menu is titled by the person filing it.
  return {
    title: clean ? truncate(firstLine(clean), TITLE_LIMIT) : "",
    details: lines.join("\n"),
  };
}

/**
 * GitHub's "new issue" form, pre-filled with a reviewed draft. Opening it IS
 * sending: the title and body ride in the address, so GitHub receives them —
 * and the browser's history keeps them — before anyone presses Submit there.
 * The issue itself exists only once they do, which is why the edit-or-omit
 * step lives in TabRunner and not on GitHub's page.
 */
export function issueUrl({ title, details }: IssueDraft): string {
  const lines = ["### What happened", "", "", "### What you expected", "", ""];
  if (details.trim()) lines.push(details);

  const url = new URL(`${LINKS.repo}/issues/new`);
  url.searchParams.set("body", lines.join("\n"));
  if (title.trim()) url.searchParams.set("title", title.trim());
  return url.toString();
}

/**
 * Strip what a raw error can carry that a public issue must not. Provider
 * bodies echo request URLs (Gemini authenticates with `?key=` in the query),
 * account emails, and the occasional credential; a crash can name a file in
 * someone's home folder. Blocking beats leaking: a false positive costs the
 * maintainer one detail, and the person sees `[hidden]` in the review and
 * can put the fact back by hand.
 */
function scrub(text: string): string {
  return (
    text
      // A URL keeps its origin — which host failed IS the diagnosis — and loses
      // the rest: userinfo, path, query and fragment can each hold a secret.
      // Every pattern that opens on a character run starts only where the run
      // does (the lookbehinds): starting at each position inside it re-scans
      // the rest, and a 50 KB provider body turns that into a hang.
      .replace(/(?<![\w+.-])[a-z][\w+.-]*:\/\/[^\s"'`<>]+/gi, originOnly)
      .replace(/(?<![\w.+-])[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, HIDDEN)
      // A home folder is named after its owner, and so is what sits inside it.
      .replace(/(?:\/(?:Users|home)\/|\b[a-z]:\\Users\\)[^\s"'`<>]+/gi, `~/${HIDDEN}`)
      .replace(/\b(Bearer|Basic)\s+[\w.~+/=-]+/gi, `$1 ${HIDDEN}`)
      .replace(
        /\b((?:x-)?(?:api[_-]?key|(?:access|refresh|id)[_-]?token|token|secret|password|authorization)["']?\s*[:=]\s*["']?)[^\s"'&,;}]+/gi,
        `$1${HIDDEN}`,
      )
      // Key shapes that carry no label: vendor `sk-` keys, JWTs, and any long
      // mixed run of letters and digits. 32 characters clears model ids like
      // `claude-3-5-sonnet-20241022`, which are the diagnosis.
      .replace(
        /\b(?:sk|pk|rk)-[\w-]{8,}|\beyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]+|(?<![\w-])(?=[\w-]*\d)(?=[\w-]*[a-z])[\w-]{32,}/gi,
        HIDDEN,
      )
  );
}

function originOnly(match: string): string {
  // Prose punctuation after a URL is not part of it: "(see https://x.io/a)."
  const [, raw = match, tail = ""] = /^(.*?)([).,;:!?\]}]*)$/.exec(match) ?? [];
  try {
    const url = new URL(raw);
    const origin = url.host ? `${url.protocol}//${url.host}` : `${url.protocol}//`;
    return `${origin}${raw.length > origin.length + 1 ? `/${HIDDEN}` : ""}${tail}`;
  } catch {
    return `${HIDDEN}${tail}`;
  }
}

/**
 * Host alone, and never a throw — a malformed base URL must not cost the user
 * the button. Nor its text: whatever failed to parse is exactly what the
 * user typed, path and token included, so it never becomes the fallback.
 */
function hostOf(baseUrl: string): string {
  try {
    const url = new URL(baseUrl);
    // `localhost:11434/v1` parses — as the scheme `localhost:` with no host.
    if ((url.protocol === "http:" || url.protocol === "https:") && url.host) return url.host;
  } catch {
    // Fall through to the placeholder.
  }
  return "not a valid URL";
}

function firstLine(text: string): string {
  const line = text.split("\n", 1)[0] ?? text;
  return line.trim();
}
