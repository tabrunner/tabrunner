import { describe, it, expect, beforeEach } from "vitest";
import { issueDraft, issueUrl, type IssueDraft, type ReportProvider } from "../report";

/** The manifest is the only chrome surface report.ts touches. */
beforeEach(() => {
  (globalThis as Record<string, unknown>).chrome = {
    runtime: { getManifest: () => ({ version: "9.9.9" }) },
  };
});

/** Shaped like a real ProviderConfig — the secret-bearing fields included. */
const config = {
  id: "p1",
  name: "Anthropic",
  shape: "anthropic",
  baseUrl: "https://gateway.corp.internal/v1/proxy?tenant=acme",
  apiKey: "sk-ant-SUPERSECRET",
  model: "claude-sonnet-4-5",
  createdAt: 0,
};

/** What the review dialog would send untouched: the draft, straight into the URL. */
const urlFor = (opts: Parameters<typeof issueDraft>[0] = {}) => issueUrl(issueDraft(opts));
const bodyOf = (url: string) => new URL(url).searchParams.get("body") ?? "";

/** Gone from what the dialog shows, and from the address Open GitHub sends, decoded or not. */
function expectHidden(draft: IssueDraft, leaks: string[]) {
  const shown = `${draft.title}\n${draft.details}`;
  const url = issueUrl(draft);
  const sent = `${url}\n${[...new URL(url).searchParams.values()].join("\n")}`;
  for (const leak of leaks) {
    expect(shown, leak).not.toContain(leak);
    expect(sent, leak).not.toContain(leak);
  }
}

describe("issueDraft and issueUrl", () => {
  it("opens a new issue on the project repo", () => {
    const url = new URL(urlFor());
    expect(url.origin + url.pathname).toBe("https://github.com/tabrunner/tabrunner/issues/new");
  });

  it("carries the version and the provider, and never the key", () => {
    const body = bodyOf(urlFor({ provider: config }));
    expect(body).toContain("TabRunner 9.9.9");
    expect(body).toContain("Anthropic");
    expect(body).toContain("claude-sonnet-4-5");
    expect(body).not.toContain("SUPERSECRET");
  });

  it("reports the endpoint host without its path", () => {
    const body = bodyOf(urlFor({ provider: config }));
    expect(body).toContain("gateway.corp.internal");
    expect(body).not.toContain("tenant=acme");
  });

  it("says so when no provider is configured", () => {
    expect(bodyOf(urlFor())).toContain("none configured");
  });

  it("names a malformed base URL as one instead of echoing it", () => {
    for (const baseUrl of ["gateway.corp.internal/t/acme?token=abc", "localhost:11434/v1"]) {
      const broken: ReportProvider = { name: "Local", shape: "openai", baseUrl };
      const { details } = issueDraft({ provider: broken });
      expect(details).toContain("- Endpoint: `not a valid URL`");
      expect(details).not.toContain(baseUrl);
    }
  });

  it("titles the issue from the error's first line only", () => {
    const url = new URL(urlFor({ error: "Anthropic API error 400\n{...}" }));
    expect(url.searchParams.get("title")).toBe("Anthropic API error 400");
    expect(bodyOf(url.toString())).toContain("Anthropic API error 400");
  });

  it("leaves the title to the user when there is no error", () => {
    expect(issueDraft().title).toBe("");
    expect(new URL(urlFor()).searchParams.get("title")).toBeNull();
  });

  it("truncates a huge error so the URL stays under GitHub's ceiling", () => {
    const url = urlFor({ provider: config, error: "x".repeat(50_000) });
    expect(url.length).toBeLessThan(8192);
  });

  it("sends what the reader edited, and nothing of what they left out", () => {
    const draft = issueDraft({ provider: config, error: "boom" });
    const edited = new URL(issueUrl({ title: "Clicks miss the button", details: "Chrome 140" }));
    expect(edited.searchParams.get("title")).toBe("Clicks miss the button");
    expect(edited.searchParams.get("body")).toContain("Chrome 140");
    expect(edited.searchParams.get("body")).not.toContain("boom");

    const omitted = bodyOf(issueUrl({ ...draft, details: "" }));
    expect(omitted).toContain("### What happened");
    expect(omitted).not.toContain("### Environment");
    expect(omitted).not.toContain("gateway.corp.internal");
  });

  // The check this module exists to pass: what the dialog shows and what the
  // URL carries, for an error holding a credential, a home-folder path and a
  // private URL, from a provider whose endpoint does not parse.
  it("keeps a credential, an identifying path and a malformed endpoint out of both", () => {
    const secret = "sk-ant-api03-Synthetic0Secret1Value2For3Tests4Only";
    const error = [
      `Anthropic API error 401: {"error":{"message":"invalid x-api-key ${secret} for jane.doe@example.com"}}`,
      "while reading /Users/janedoe/Clients/AcmeCorp/brief.pdf",
      `via https://gateway.corp.internal/tenant/acme-corp/v1?key=${secret}#access_token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJqYW5lIn0.c2lnbmF0dXJlLXNpZw`,
      "Authorization: Bearer 7f3c9e1d2b4a6f8e0d1c3b5a7e9f1d3c",
      'C:\\Users\\JaneDoe\\AppData\\Local\\tabrunner\\log.txt "password": "hunter2hunter2"',
    ].join("\n");
    const provider: ReportProvider = {
      name: "Gateway",
      shape: "openai",
      baseUrl: "gateway.corp.internal/tenant/acme-corp?token=tok_Synthetic9Endpoint",
    };

    const draft = issueDraft({ provider, error });
    expectHidden(draft, [
      secret,
      "Synthetic0Secret",
      "jane.doe@example.com",
      "janedoe",
      "JaneDoe",
      "AcmeCorp",
      "acme-corp",
      "eyJhbGci",
      "7f3c9e1d2b4a",
      "hunter2",
      "tok_Synthetic9Endpoint",
    ]);
    // Still a report worth reading: the status, which host failed, and that
    // the endpoint was the problem.
    expect(draft.title).toContain("Anthropic API error 401");
    expect(draft.details).toContain("https://gateway.corp.internal/[hidden]");
    expect(draft.details).toContain("- Endpoint: `not a valid URL`");
  });

  // The error bubble reports `${summary}\n\n${detail}`, and the detail is the
  // provider's raw JSON body: every backslash doubled, a `/` sometimes sent as
  // `\/`, and a gateway that wraps the upstream body escapes all of it again.
  it("hides a path, a URL and a secret field inside a raw JSON body", () => {
    const secret = "sk-ant-api03-Synthetic0Secret1Value2For3Tests4Only";
    const windows = "C:\\Users\\JaneDoe\\AppData\\Local\\AcmeCorp\\models\\blob";
    const upstream = JSON.stringify({
      error: `open ${windows}: The system cannot find the file specified.`,
    });
    const gateway = JSON.stringify({
      message: JSON.stringify({
        error: { message: `load ${windows}`, password: "hunter2hunter2" },
      }),
    });
    const phpSlashes = JSON.stringify({
      url: `https://gateway.corp.internal/tenant/acme-corp?key=${secret}`,
    }).replace(/\//g, "\\/");
    const error = [
      `Ollama API error 500 — open ${windows}: The system cannot find the file specified.`,
      "",
      upstream,
      gateway,
      phpSlashes,
      "reading /Users/janedoe/Library/Application Support/AcmeCorp/brief.pdf failed",
      "reading C:\\Users\\Jane Doe\\Documents\\AcmeCorp\\brief.pdf failed",
      "reading /Volumes/JaneDoe/AcmeCorp/brief.pdf and /media/janedoe/AcmeCorp/brief.pdf",
    ].join("\n");

    const draft = issueDraft({ error });
    expectHidden(draft, [
      secret,
      "Synthetic0Secret",
      "JaneDoe",
      "janedoe",
      "Doe",
      "AcmeCorp",
      "acme-corp",
      "hunter2",
    ]);
    // The diagnosis survives: what went wrong, which host, and the words
    // after a path, which a person reads as the reason.
    expect(draft.title).toContain("The system cannot find the file specified.");
    expect(draft.details).toContain("The system cannot find the file specified.");
    expect(draft.details).toContain("https://gateway.corp.internal/[hidden]");
    expect(draft.details.match(/ failed/g)).toHaveLength(2);
  });
});
