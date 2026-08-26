import { i18n } from "@/i18n";

/**
 * What the import field accepts, resolved to one https URL to fetch:
 *
 * - a raw https URL to a markdown file — used verbatim
 * - a GitHub blob/tree URL — rewritten to raw.githubusercontent.com
 * - the `owner/repo[/path]` shorthand — the way skill repos are passed around
 *
 * Pure string logic; the fetch itself is `fetchSkillMarkdown` below.
 */
export type SkillSource = { ok: true; url: string } | { ok: false; reason: "http" | "unparseable" };

const RAW_HOST = "https://raw.githubusercontent.com";
/** `owner/repo` or `owner/repo/path/to/skill` — no scheme, no spaces. */
const SHORTHAND = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(\/\S+)?$/;

/** A path that names a directory gets the canonical file name appended. */
function withSkillFile(path: string): string {
  return path.endsWith(".md") ? path : `${path.replace(/\/+$/, "")}/SKILL.md`;
}

export function resolveSkillSource(input: string): SkillSource {
  const raw = input.trim();
  if (!raw) return { ok: false, reason: "unparseable" };
  if (/^http:\/\//i.test(raw)) return { ok: false, reason: "http" };

  if (/^https:\/\//i.test(raw)) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return { ok: false, reason: "unparseable" };
    }
    if (url.hostname !== "github.com") return { ok: true, url: url.toString() };
    // github.com/<owner>/<repo>[/blob|tree/<ref>/<path>] → the raw file behind it.
    const [owner, repo, kind, ref, ...rest] = url.pathname.split("/").filter(Boolean);
    if (!owner || !repo) return { ok: false, reason: "unparseable" };
    if ((kind === "blob" || kind === "tree") && ref) {
      return {
        ok: true,
        url: `${RAW_HOST}/${owner}/${repo}/${ref}/${withSkillFile(rest.join("/"))}`,
      };
    }
    if (!kind) return { ok: true, url: `${RAW_HOST}/${owner}/${repo}/HEAD/SKILL.md` };
    return { ok: false, reason: "unparseable" };
  }

  if (SHORTHAND.test(raw)) {
    const [owner, repo, ...rest] = raw.split("/");
    const path = rest.length ? withSkillFile(rest.join("/")) : "SKILL.md";
    return { ok: true, url: `${RAW_HOST}/${owner}/${repo}/HEAD/${path}` };
  }
  return { ok: false, reason: "unparseable" };
}

/** A skill is prose — anything bigger than this is not a skill file. */
const MAX_SKILL_FETCH_BYTES = 262_144;

/** Read the body no further than the cap — a chunked or lying server must not fill memory. */
async function readCapped(body: ReadableStream<Uint8Array>): Promise<string> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > MAX_SKILL_FETCH_BYTES) {
      void reader.cancel();
      throw new Error(i18n.t("skills.import.errorTooLarge"));
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/**
 * Fetch the resolved URL, bounded in time and size. Runs from the dialog's own
 * page context (the `/usage` precedent) — user-initiated, one URL the user
 * typed, never from the worker. Throws i18n'd messages the dialog shows as-is;
 * the caller's own abort (dialog closed) passes through untouched.
 */
export async function fetchSkillMarkdown(url: string, signal?: AbortSignal): Promise<string> {
  const timeout = AbortSignal.timeout(10_000);
  let res: Response;
  try {
    res = await fetch(url, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
  } catch (e) {
    throw new Error(
      i18n.t(timeout.aborted ? "skills.import.errorTimeout" : "skills.import.errorNetwork"),
      { cause: e },
    );
  }
  if (!res.ok) throw new Error(i18n.t("skills.import.errorStatus", { status: res.status }));
  const length = Number(res.headers.get("content-length") ?? 0);
  if (length > MAX_SKILL_FETCH_BYTES) throw new Error(i18n.t("skills.import.errorTooLarge"));
  const text = res.body ? await readCapped(res.body) : "";
  if (!text.trim()) throw new Error(i18n.t("skills.import.errorEmpty"));
  return text;
}

// ---------------------------------------------------------------------------
// Repo discovery: "is a skill file" resolves one URL; "has skill files" scans
// a whole repo via the GitHub tree API. Same page-context fetch discipline.

/** A repo-shaped input: which repo, at which ref, restricted to which directory. */
export interface GithubRepoRef {
  owner: string;
  repo: string;
  ref: string;
  /** Subdirectory to search under — empty means the whole repo. */
  dir: string;
}

export type RepoRefResult = { ok: true; repo: GithubRepoRef } | { ok: false };

/**
 * Does this input name a REPO to scan rather than a file to fetch? A `.md`
 * path is always one file (`resolveSkillSource`'s flow); `owner/repo`,
 * `owner/repo/<dir>`, and github.com tree URLs are repos. Blob URLs stay
 * single-file: they point at one thing the user was looking at.
 */
export function resolveGithubRepo(input: string): RepoRefResult {
  const raw = input.trim();
  if (/^http:\/\//i.test(raw)) return { ok: false };

  if (/^https:\/\//i.test(raw)) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return { ok: false };
    }
    if (url.hostname !== "github.com") return { ok: false };
    const [owner, repo, kind, ref, ...rest] = url.pathname.split("/").filter(Boolean);
    if (!owner || !repo || kind === "blob") return { ok: false };
    if (kind === "tree" && ref) {
      return { ok: true, repo: { owner, repo, ref, dir: rest.join("/") } };
    }
    // Bare github.com/o/r with no ref — but only when nothing else matched it:
    // an .md-suffixed path is still one file.
    if (!kind && !rest.join("/").endsWith(".md")) {
      return { ok: true, repo: { owner, repo, ref: "HEAD", dir: rest.join("/") } };
    }
    return { ok: false };
  }

  if (SHORTHAND.test(raw)) {
    const parts = raw.split("/");
    const owner = parts[0];
    const repo = parts[1];
    if (!owner || !repo) return { ok: false };
    const dir = parts.slice(2).join("/");
    if (dir.endsWith(".md")) return { ok: false };
    return { ok: true, repo: { owner, repo, ref: "HEAD", dir } };
  }
  return { ok: false };
}

export type DiscoveredSkills =
  | { ok: true; files: { path: string; url: string }[]; truncated: boolean }
  | { ok: false; reason: "rate-limit" | "network" | "status"; status?: number };

/**
 * Above this, the checklist stops being a review and becomes a dump — the
 * response is imported as truncated so nothing is silently missing.
 */
const MAX_DISCOVERED = 25;

const DISCOVER_TIMEOUT_MS = 10_000;

/**
 * Every SKILL.md in the repo (or its subtree), as raw fetch URLs. Unauthenticated,
 * CORS-enabled, from the same page-context fetch the single-file path uses;
 * one call per import attempt against the 60/hr anonymous budget. Failures are
 * typed, never thrown — the caller degrades to the single-file flow instead of
 * dead-ending on a repo the API could not see.
 */
export async function discoverRepoSkills(
  ref: GithubRepoRef,
  signal?: AbortSignal,
): Promise<DiscoveredSkills> {
  const api = `https://api.github.com/repos/${ref.owner}/${ref.repo}/git/trees/${encodeURIComponent(ref.ref)}?recursive=1`;
  const timeout = AbortSignal.timeout(DISCOVER_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(api, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
  } catch {
    return { ok: false, reason: "network" };
  }
  if (res.status === 403 || res.status === 429) {
    return { ok: false, reason: "rate-limit", status: res.status };
  }
  if (!res.ok) return { ok: false, reason: "status", status: res.status };

  type TreeEntry = { path?: unknown; type?: unknown };
  try {
    const json = (await res.json()) as { tree?: TreeEntry[]; truncated?: boolean };
    const entries = Array.isArray(json.tree) ? json.tree : [];
    if (entries.length === 0 && !json.truncated) {
      // An empty or malformed tree answers as a status failure so the caller
      // falls back to the single-file path instead of reporting success with
      // nothing found.
      return { ok: false, reason: "status", status: res.status };
    }

    const prefix = ref.dir ? `${ref.dir.replace(/\/+$/, "")}/` : "";
    const files: { path: string; url: string }[] = [];
    let hitCap = false;
    for (const entry of entries) {
      const path = typeof entry.path === "string" ? entry.path : "";
      if (entry.type !== "blob") continue;
      if (!path.endsWith("/SKILL.md") && path !== "SKILL.md") continue;
      if (prefix && !path.startsWith(prefix)) continue;
      if (files.length >= MAX_DISCOVERED) {
        hitCap = true;
        break;
      }
      files.push({
        path,
        url: `${RAW_HOST}/${ref.owner}/${ref.repo}/${ref.ref}/${path}`,
      });
    }
    return { ok: true, files, truncated: hitCap || json.truncated === true };
  } catch {
    return { ok: false, reason: "status", status: res.status };
  }
}
