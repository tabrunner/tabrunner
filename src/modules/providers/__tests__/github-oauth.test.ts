import { describe, it, expect, vi, afterEach } from "vitest";
import { copilotHeaders, GITHUB_DEVICE, refreshCredential, withAccount } from "../github-oauth";
import { providerHeaders } from "../http";
import type { ChatMessage } from "../types";

// The device-code protocol GitHub signs in with is shared, and tested in
// device-code.test.ts. What's left here is the second hop — trading the GitHub
// token for a Copilot one — and the base URL that hop pins.
// Storage stand-in and i18n come from src/test-setup.ts (vitest setupFiles).

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** A Copilot token is a `;`-joined field list; only `proxy-ep` is read. */
const tokenFor = (proxy: string) => `tid=abc;exp=123;proxy-ep=${proxy};ssc=1`;

const IN_AN_HOUR = Math.floor(Date.now() / 1000) + 3600;

afterEach(() => vi.restoreAllMocks());

describe("withAccount", () => {
  it("keeps the GitHub token as the refresh token and the Copilot one as the bearer", async () => {
    // The two slots hold things that are not an OAuth pair: only the GitHub
    // token can mint another Copilot token, so losing it means signing in again.
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(json({ token: "copilot-tok", expires_at: IN_AN_HOUR }))
      .mockResolvedValueOnce(json({ login: "gus" }));

    const credential = await withAccount({ access_token: "gho_github" });
    expect(credential).toMatchObject({
      accessToken: "copilot-tok",
      refreshToken: "gho_github",
      account: "gus",
    });
    // Skewed early, so the seam renews before the server's own expiry.
    expect(credential.expiresAt).toBeLessThan(IN_AN_HOUR * 1000);
  });

  it("pins the host the account's own plan is served from", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        json({
          token: "t",
          expires_at: IN_AN_HOUR,
          endpoints: { api: "https://api.business.githubcopilot.com" },
        }),
      )
      .mockResolvedValueOnce(json({ login: "gus" }));

    const credential = await withAccount({ access_token: "gho" });
    expect(credential.baseUrl).toBe("https://api.business.githubcopilot.com");
  });

  it("reads that host off the token when the response ships no endpoint map", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        json({ token: tokenFor("proxy.enterprise.githubcopilot.com"), expires_at: IN_AN_HOUR }),
      )
      .mockResolvedValueOnce(json({ login: "gus" }));

    const credential = await withAccount({ access_token: "gho" });
    expect(credential.baseUrl).toBe("https://api.enterprise.githubcopilot.com");
  });

  it("falls back to the individual host when neither names one", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(json({ token: "opaque", expires_at: IN_AN_HOUR }))
      .mockResolvedValueOnce(json({ login: "gus" }));

    const credential = await withAccount({ access_token: "gho" });
    expect(credential.baseUrl).toBe("https://api.individual.githubcopilot.com");
  });

  it("signs in anyway when the account name can't be read", async () => {
    // The name is decoration on the connected card. A sign-in that worked must
    // not be reported as failed because a second, optional call didn't.
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(json({ token: "t", expires_at: IN_AN_HOUR }))
      .mockRejectedValueOnce(new TypeError("Failed to fetch"));

    const credential = await withAccount({ access_token: "gho" });
    expect(credential.accessToken).toBe("t");
    expect(credential.account).toBeUndefined();
  });

  it("surfaces a refused mint with its status, so the seam can clear the credential", async () => {
    // 401 here means the GitHub token was revoked, or the account has no
    // Copilot seat — either way there is nothing left to renew.
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(json({ message: "no seat" }, 401));
    await expect(withAccount({ access_token: "gho" })).rejects.toMatchObject({ status: 401 });
  });

  it("refuses a poll body with no GitHub token rather than minting from undefined", async () => {
    await expect(withAccount({})).rejects.toThrow();
  });
});

describe("refreshCredential", () => {
  it("re-mints from the GitHub token and keeps the name already on screen", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      json({ token: "copilot-2", expires_at: IN_AN_HOUR }),
    );

    const next = await refreshCredential({
      accessToken: "copilot-1",
      refreshToken: "gho_github",
      expiresAt: 0,
      account: "gus",
    });
    expect(next).toMatchObject({
      accessToken: "copilot-2",
      refreshToken: "gho_github",
      account: "gus",
    });
  });
});

describe("copilotHeaders", () => {
  it("declares who started the turn, which is what GitHub bills on", () => {
    // A run's own follow-ups ride inside the turn the user paid for; calling
    // every one of them "user" would spend a premium request per tool call.
    expect(copilotHeaders("user")["X-Initiator"]).toBe("user");
    expect(copilotHeaders("agent")["X-Initiator"]).toBe("agent");
  });

  it("names the integration GitHub allowlists, and us as the editor", () => {
    const headers = copilotHeaders("user");
    expect(headers["Copilot-Integration-Id"]).toBe("vscode-chat");
    expect(headers["Editor-Version"]).toBe("TabRunner/0.0.0-test");
    // A browser refuses to set User-Agent — sending one would silently do nothing.
    expect(headers["User-Agent"]).toBeUndefined();
  });
});

describe("GITHUB_DEVICE", () => {
  it("asks only for the scope the connected card needs", () => {
    expect(GITHUB_DEVICE.scope).toBe("read:user");
    expect(GITHUB_DEVICE.deviceUrl).toBe("https://github.com/login/device/code");
  });
});

// `providerHeaders` lives in http.ts, but the turn it infers exists for exactly
// one provider and is what GitHub bills on — so the rule is checked here, next
// to the header it feeds.
describe("providerHeaders", () => {
  const user: ChatMessage = { role: "user", content: "open the inbox" };
  const results: ChatMessage = { role: "tool_results", content: "", toolResults: [] };

  it("calls the person's own turn theirs", () => {
    expect(providerHeaders("github-copilot", [user])["X-Initiator"]).toBe("user");
  });

  it("calls the run's follow-up after tool results the agent's", () => {
    // This is the whole point: a thirty-step task must bill as one premium
    // request, not thirty.
    expect(providerHeaders("github-copilot", [user, results])["X-Initiator"]).toBe("agent");
  });

  it("leaves every other provider's request alone", () => {
    expect(providerHeaders("openai", [user])).toEqual({});
  });
});
