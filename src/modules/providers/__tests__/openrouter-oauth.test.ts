import { describe, it, expect, vi, afterEach } from "vitest";
import { buildAuthorizeUrl, exchangeCode, refreshCredential } from "../openrouter-oauth";

// Storage stand-in and i18n come from src/test-setup.ts (vitest setupFiles).

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

afterEach(() => vi.restoreAllMocks());

describe("buildAuthorizeUrl", () => {
  it("carries the callback and the PKCE challenge, and no client id", () => {
    // OpenRouter registers no client: the callback URL is ours to name and
    // PKCE is the entire proof.
    const url = new URL(buildAuthorizeUrl("challenge-123"));
    expect(url.origin + url.pathname).toBe("https://openrouter.ai/auth");
    expect(url.searchParams.get("callback_url")).toBe("http://localhost:54546/callback");
    expect(url.searchParams.get("code_challenge")).toBe("challenge-123");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("client_id")).toBeNull();
  });
});

describe("exchangeCode", () => {
  it("stores the minted key as a credential that never expires", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(json({ key: "sk-or-v1-abc" }));

    const credential = await exchangeCode("code-1", "verifier-1");
    expect(credential.accessToken).toBe("sk-or-v1-abc");
    // ensureProviderCredential compares against now(); a key with no expiry
    // must always take the "still valid" branch rather than try to renew.
    expect(credential.expiresAt).toBeGreaterThan(Date.now() + 365 * 24 * 60 * 60_000);
  });

  it("sends the verifier, so a code captured by anyone else is useless", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(json({ key: "k" }));

    await exchangeCode("code-1", "verifier-1");
    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]!.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      code: "code-1",
      code_verifier: "verifier-1",
      code_challenge_method: "S256",
    });
  });

  it("surfaces the vendor's reason when no key comes back", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      json({ message: "code already used" }, 400),
    );
    await expect(exchangeCode("code-1", "verifier-1")).rejects.toMatchObject({ status: 400 });
  });

  it("treats a 200 with no key as a failure — an empty success is not one", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(json({}));
    await expect(exchangeCode("code-1", "verifier-1")).rejects.toThrow();
  });
});

describe("refreshCredential", () => {
  it("hands the key straight back — there is nothing to renew", async () => {
    const credential = { accessToken: "k", refreshToken: "", expiresAt: 1 };
    await expect(refreshCredential(credential)).resolves.toBe(credential);
  });
});
