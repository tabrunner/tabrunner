import { describe, it, expect, vi } from "vitest";
import { ProviderError as CoreProviderError } from "@providerkit/core";
import type { AuthFlow, Credential } from "@providerkit/core/auth";
import { ensureProviderCredential } from "../credential";
import { getProvider, saveProvider } from "../storage";
import type { ProviderConfig } from "../types";

// Storage stand-in and i18n come from src/test-setup.ts (vitest setupFiles).

let refreshImpl: AuthFlow["refresh"] = () => Promise.reject(new Error("unset"));
const refresh = (credential: Credential) => refreshImpl(credential);
vi.mock("../oauth-flows", () => ({
  authFlowFor: (id: string) => (id === "claude" ? { signIn: vi.fn(), refresh } : undefined),
}));

const FRESH: Credential = {
  accessToken: "at-1",
  refreshToken: "rt-1",
  expiresAt: Date.now() + 3_600_000,
};
const EXPIRED: Credential = { ...FRESH, expiresAt: Date.now() - 1 };

const provider = (auth: Credential): ProviderConfig => ({
  id: "claude",
  name: "Claude",
  shape: "anthropic",
  baseUrl: "https://api.anthropic.com",
  apiKey: "",
  auth,
  createdAt: 0,
});

describe("ensureProviderCredential", () => {
  it("returns a keyed provider untouched", async () => {
    const keyed: ProviderConfig = { ...provider(FRESH), apiKey: "sk-1" };
    delete keyed.auth;
    expect(await ensureProviderCredential(keyed)).toBe(keyed);
  });

  it("reads the stored credential on every call, never a cached copy", async () => {
    // The refresh token rotates: a copy kept from the first call would spend one already used.
    await saveProvider(provider(FRESH));
    const first = await ensureProviderCredential(provider(FRESH));
    expect(first.apiKey).toBe("at-1");

    await saveProvider(provider({ ...FRESH, accessToken: "at-2", refreshToken: "rt-2" }));
    const second = await ensureProviderCredential(provider(FRESH));
    expect(second.apiKey).toBe("at-2");
  });

  it("renews an expired token, saves the new pair, and applies its pinned base URL", async () => {
    await saveProvider(provider(EXPIRED));
    refreshImpl = () =>
      Promise.resolve({ ...FRESH, accessToken: "at-new", baseUrl: "https://pinned.test" });

    const config = await ensureProviderCredential(provider(EXPIRED));

    expect(config).toMatchObject({ apiKey: "at-new", baseUrl: "https://pinned.test" });
    expect((await getProvider("claude"))?.auth?.accessToken).toBe("at-new");
  });

  it("drops a credential the server rejected and says to sign in again", async () => {
    await saveProvider(provider(EXPIRED));
    refreshImpl = async () => {
      throw new CoreProviderError("auth", "auth", "refused", {
        status: 400,
        code: "token_refused",
      });
    };

    await expect(ensureProviderCredential(provider(EXPIRED))).rejects.toMatchObject({
      status: 401,
      kind: "auth",
    });
    expect((await getProvider("claude"))?.auth).toBeUndefined();
  });

  it("keeps the credential when the refresh never reached the server", async () => {
    await saveProvider(provider(EXPIRED));
    refreshImpl = async () => {
      throw Object.assign(new Error("offline"), { code: "ECONNRESET" });
    };

    await expect(ensureProviderCredential(provider(EXPIRED))).rejects.toMatchObject({
      kind: "network",
    });
    expect((await getProvider("claude"))?.auth?.refreshToken).toBe("rt-1");
  });
});
