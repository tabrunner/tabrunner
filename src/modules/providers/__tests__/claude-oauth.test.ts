import { describe, it, expect } from "vitest";
import type { AuthHost } from "@providerkit/core/auth";
import { buildAuthorizeUrl, claudeFlow } from "../claude-oauth";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** A host whose fetch answers once and records the request. */
function hostAnswering(body: unknown) {
  const calls: { url: string; body: Record<string, string> }[] = [];
  const host: AuthHost = {
    appName: "TabRunner/test",
    openUrl: () => {},
    captureRedirect: () => Promise.resolve("code-1"),
    fetchImpl: (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return Promise.resolve(json(body));
    },
  };
  return { host, calls };
}

const TOKENS = { access_token: "at", refresh_token: "rt", expires_in: 3600 };

describe("buildAuthorizeUrl", () => {
  it("carries the OAuth + PKCE params on the claude.ai authorize endpoint", () => {
    const url = new URL(buildAuthorizeUrl("challenge-x", "state-y"));
    expect(`${url.origin}${url.pathname}`).toBe("https://claude.ai/oauth/authorize");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      code: "true",
      client_id: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
      response_type: "code",
      redirect_uri: "http://localhost:54545/callback",
      // No org:create_api_key — a token that can mint durable API keys on the
      // user's org is a liability we would never spend.
      scope: "user:profile user:inference",
      code_challenge: "challenge-x",
      code_challenge_method: "S256",
      state: "state-y",
    });
  });
});

describe("claudeFlow", () => {
  it("signs in against the API host and names the account from the response", async () => {
    // platform.claude.com is a web frontend behind bot protection: an extension
    // fetch lands there with a chrome-extension:// Origin and comes back 429.
    const { host, calls } = hostAnswering({
      ...TOKENS,
      account: { email_address: "Gus@Example.com" },
    });
    const prompts: string[] = [];
    const credential = await claudeFlow(host).signIn(new AbortController().signal, ({ url }) =>
      prompts.push(url),
    );
    expect(calls[0]?.url).toBe("https://api.anthropic.com/v1/oauth/token");
    expect(calls[0]?.body).toMatchObject({ grant_type: "authorization_code", code: "code-1" });
    expect(prompts[0]).toContain("https://claude.ai/oauth/authorize");
    expect(credential).toMatchObject({ accessToken: "at", account: "gus@example.com" });
  });

  it("keeps the old refresh token when the refresh response omits a new one", async () => {
    const { host } = hostAnswering({ access_token: "at-2", expires_in: 3600 });
    const next = await claudeFlow(host).refresh({
      accessToken: "at-1",
      refreshToken: "rt-1",
      expiresAt: 0,
    });
    expect(next).toMatchObject({ accessToken: "at-2", refreshToken: "rt-1" });
  });
});
