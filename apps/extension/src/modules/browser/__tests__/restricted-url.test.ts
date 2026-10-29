import { describe, it, expect } from "vitest";
import { isRestrictedUrl } from "../restricted-url";

// Every entry here is a page a background run would otherwise try to open as
// its start page — a miss lands as a raw injection failure mid-run instead of
// a fallback the user never notices.
describe("isRestrictedUrl", () => {
  it("rejects the schemes Chrome forbids extensions on", () => {
    for (const url of [
      "chrome://settings/",
      "chrome-extension://abc/options.html",
      "chrome-untrusted://print",
      "devtools://devtools/bundled/inspector.html",
      "about:blank",
      "edge://settings",
      "view-source:https://example.com",
    ]) {
      expect(isRestrictedUrl(url), url).toBe(true);
    }
  });

  it("rejects the Web Store on both of its hostnames", () => {
    expect(isRestrictedUrl("https://chrome.google.com/webstore/category/extensions")).toBe(true);
    expect(isRestrictedUrl("https://chromewebstore.google.com/detail/tabrunner/abc")).toBe(true);
  });

  it("allows the ordinary pages a task actually runs on", () => {
    for (const url of [
      "https://mail.google.com/mail/u/0/",
      "https://chrome.google.com/", // the host alone is not the Web Store
      "http://localhost:3000/",
    ]) {
      expect(isRestrictedUrl(url), url).toBe(false);
    }
  });

  it("treats a missing url as unrestricted — the caller has its own no-tab path", () => {
    expect(isRestrictedUrl(undefined)).toBe(false);
  });
});
