import { describe, it, expect } from "vitest";
import { hostMatches, normalizeHost, scopeHostOf } from "../host";

describe("normalizeHost", () => {
  it("canonicalizes case, www, ports, and trailing dots", () => {
    expect(normalizeHost("WWW.Acme.COM")).toBe("acme.com");
    expect(normalizeHost("acme.com:8080")).toBe("acme.com");
    expect(normalizeHost("acme.com.")).toBe("acme.com");
    expect(normalizeHost("  mail.google.com  ")).toBe("mail.google.com");
  });

  it("accepts a full URL — models send them no matter what the schema says", () => {
    expect(normalizeHost("https://www.acme.com/billing?x=1")).toBe("acme.com");
  });

  it("keeps localhost and IP literals usable", () => {
    expect(normalizeHost("localhost:3000")).toBe("localhost");
    expect(normalizeHost("192.168.1.10")).toBe("192.168.1.10");
    expect(normalizeHost("[::1]:8080")).toBe("::1");
  });

  it("rejects what is not a host", () => {
    expect(normalizeHost("")).toBeNull();
    expect(normalizeHost("   ")).toBeNull();
    expect(normalizeHost("not a host!")).toBeNull();
    expect(normalizeHost("acme.com/path")).toBeNull();
    expect(normalizeHost("user@acme.com")).toBeNull();
  });
});

describe("hostMatches", () => {
  it("matches exactly and by subdomain suffix", () => {
    expect(hostMatches("google.com", "google.com")).toBe(true);
    expect(hostMatches("google.com", "mail.google.com")).toBe(true);
    expect(hostMatches("google.com", "deep.mail.google.com")).toBe(true);
    expect(hostMatches("mail.google.com", "mail.google.com")).toBe(true);
  });

  it("never matches a sibling or a lookalike", () => {
    expect(hostMatches("mail.google.com", "docs.google.com")).toBe(false);
    expect(hostMatches("google.com", "notgoogle.com")).toBe(false);
    expect(hostMatches("mail.google.com", "google.com")).toBe(false);
  });

  it("matches IP literals exactly only — their labels are not subdomains", () => {
    expect(hostMatches("192.168.1.10", "192.168.1.10")).toBe(true);
    expect(hostMatches("1.10", "192.168.1.10")).toBe(false);
  });
});

describe("scopeHostOf", () => {
  it("scopes web pages by their normalized host", () => {
    expect(scopeHostOf("https://www.acme.com/billing")).toBe("acme.com");
    expect(scopeHostOf("http://mail.google.com/mail/u/0/")).toBe("mail.google.com");
  });

  it("gives no scope to anything that is not a web page", () => {
    // The protocol check is load-bearing: new URL("chrome://extensions").hostname
    // is the junk string "extensions".
    expect(scopeHostOf("chrome://extensions")).toBeNull();
    expect(scopeHostOf("about:blank")).toBeNull();
    expect(scopeHostOf("file:///tmp/report.pdf")).toBeNull();
    expect(scopeHostOf(undefined)).toBeNull();
    expect(scopeHostOf("not a url")).toBeNull();
  });
});
