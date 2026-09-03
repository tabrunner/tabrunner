import { describe, it, expect, vi, afterEach } from "vitest";
import {
  discoverRepoSkills,
  fetchSkillMarkdown,
  resolveGithubRepo,
  resolveSkillSource,
} from "../import-url";

function urlOf(input: string): string {
  const source = resolveSkillSource(input);
  if (!source.ok) throw new Error(`expected ok for ${input}, got ${source.reason}`);
  return source.url;
}

describe("resolveSkillSource", () => {
  it("rewrites GitHub blob and tree URLs to the raw file", () => {
    expect(urlOf("https://github.com/acme/skills/blob/main/pay-rent/SKILL.md")).toBe(
      "https://raw.githubusercontent.com/acme/skills/main/pay-rent/SKILL.md",
    );
    // A tree URL names a directory — the canonical file name is appended.
    expect(urlOf("https://github.com/acme/skills/tree/main/pay-rent")).toBe(
      "https://raw.githubusercontent.com/acme/skills/main/pay-rent/SKILL.md",
    );
  });

  it("expands the owner/repo shorthand, with and without a path", () => {
    expect(urlOf("acme/skills")).toBe(
      "https://raw.githubusercontent.com/acme/skills/HEAD/SKILL.md",
    );
    expect(urlOf("acme/skills/pay-rent")).toBe(
      "https://raw.githubusercontent.com/acme/skills/HEAD/pay-rent/SKILL.md",
    );
    expect(urlOf("acme/skills/pay-rent/SKILL.md")).toBe(
      "https://raw.githubusercontent.com/acme/skills/HEAD/pay-rent/SKILL.md",
    );
  });

  it("passes any other https URL through verbatim", () => {
    expect(urlOf("https://example.com/my/skill.md?x=1")).toBe(
      "https://example.com/my/skill.md?x=1",
    );
  });

  it("refuses http and anything unparseable, each with its reason", () => {
    expect(resolveSkillSource("http://example.com/skill.md")).toEqual({
      ok: false,
      reason: "http",
    });
    expect(resolveSkillSource("not a url at all")).toEqual({ ok: false, reason: "unparseable" });
    expect(resolveSkillSource("")).toEqual({ ok: false, reason: "unparseable" });
  });
});

describe("resolveGithubRepo", () => {
  it("accepts repo-shaped inputs: bare shorthand, dir subtree, and tree URLs", () => {
    expect(resolveGithubRepo("acme/skills")).toEqual({
      ok: true,
      repo: { owner: "acme", repo: "skills", ref: "HEAD", dir: "" },
    });
    expect(resolveGithubRepo("acme/skills/pay-rent")).toEqual({
      ok: true,
      repo: { owner: "acme", repo: "skills", ref: "HEAD", dir: "pay-rent" },
    });
    expect(resolveGithubRepo("https://github.com/acme/skills/tree/main/library")).toEqual({
      ok: true,
      repo: { owner: "acme", repo: "skills", ref: "main", dir: "library" },
    });
  });

  it("rejects anything that names one file — those stay on the single-fetch path", () => {
    expect(resolveGithubRepo("acme/skills/pay-rent/SKILL.md")).toEqual({ ok: false });
    expect(resolveGithubRepo("https://github.com/acme/skills/blob/main/a.md")).toEqual({
      ok: false,
    });
    expect(resolveGithubRepo("https://example.com/whatever")).toEqual({ ok: false });
    expect(resolveGithubRepo("")).toEqual({ ok: false });
  });
});

describe("discoverRepoSkills", () => {
  afterEach(() => vi.unstubAllGlobals());

  const tree = (paths: string[], truncated = false) =>
    Response.json({
      truncated,
      tree: paths.map((p) => ({ path: p, type: p === "docs" ? "tree" : "blob" })),
    });

  it("keeps only SKILL.md blobs under the directory, as raw fetch URLs, capped", async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValue(
        tree([
          "SKILL.md",
          "pay-rent/SKILL.md",
          "library/billing/pay-rent/SKILL.md",
          "README.md",
          "notes",
        ]),
      );
    vi.stubGlobal("fetch", fetchSpy);
    const found = await discoverRepoSkills({
      owner: "acme",
      repo: "skills",
      ref: "HEAD",
      dir: "library",
    });
    expect(found).toEqual({
      ok: true,
      files: [
        {
          path: "library/billing/pay-rent/SKILL.md",
          url: "https://raw.githubusercontent.com/acme/skills/HEAD/library/billing/pay-rent/SKILL.md",
        },
      ],
      truncated: false,
    });
  });

  it("surfaces truncation from the response or its own cap", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(tree(["a/SKILL.md"], true)));
    const marked = await discoverRepoSkills({ owner: "a", repo: "b", ref: "HEAD", dir: "" });
    expect(marked.ok && marked.truncated).toBe(true);
  });

  it("maps rate limiting and junk payloads to typed failures, never a throw", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 403 })));
    await expect(
      discoverRepoSkills({ owner: "a", repo: "b", ref: "HEAD", dir: "" }),
    ).resolves.toEqual({ ok: false, reason: "rate-limit", status: 403 });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("not json at all", { status: 200 })),
    );
    await expect(
      discoverRepoSkills({ owner: "a", repo: "b", ref: "HEAD", dir: "" }),
    ).resolves.toEqual({ ok: false, reason: "status", status: 200 });
  });

  it("an empty tree counts as a failed scan so the caller falls back to one file", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(tree([])));
    await expect(
      discoverRepoSkills({ owner: "a", repo: "b", ref: "HEAD", dir: "" }),
    ).resolves.toEqual({ ok: false, reason: "status", status: 200 });
  });
});

describe("fetchSkillMarkdown", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns a body within the cap", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("---\nname: a\n---\nsteps")));
    await expect(fetchSkillMarkdown("https://example.com/SKILL.md")).resolves.toContain("steps");
  });

  it("caps the streamed body — a server that lies about size can't fill memory", async () => {
    // No content-length header, so only the capped read can catch it.
    const big = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array(200_000));
        c.enqueue(new Uint8Array(200_000));
        c.close();
      },
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(big)));
    await expect(fetchSkillMarkdown("https://example.com/SKILL.md")).rejects.toThrow();
  });
});
