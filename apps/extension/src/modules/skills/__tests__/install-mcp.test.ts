import { describe, it, expect } from "vitest";
import { installSkillServers } from "../install-mcp";
import { listMcpServers } from "@/modules/mcp/store";

// Storage stand-in and i18n come from src/test-setup.ts (vitest setupFiles).

const ref = (name: string, url = `https://${name}.example.com/mcp`) => ({
  name,
  url,
  ...(name === "with-header" ? { headers: { Authorization: "Bearer t" } } : {}),
});

describe("installSkillServers", () => {
  it("installs enabled, keeps order, and never overwrites an existing name", async () => {
    const outcomes = await installSkillServers([ref("acme"), ref("acme")]);
    expect(outcomes).toEqual(["installed", "duplicate"]);
    const servers = await listMcpServers();
    expect(servers.filter((s) => s.name === "acme")).toHaveLength(1);
    expect(servers.find((s) => s.name === "acme")?.enabled).toBe(true);
    // Case-insensitive: the name is a tool-name token.
    await expect(installSkillServers([ref("ACME")])).resolves.toEqual(["duplicate"]);
  });

  it("rejects what the registry rejects — a bad URL fails without killing the batch", async () => {
    const outcomes = await installSkillServers([
      ref("good-one"),
      { name: "bad-url", url: "ftp://nope" },
      ref("good-two"),
    ]);
    expect(outcomes).toEqual(["installed", "failed", "installed"]);
    const names = (await listMcpServers()).map((s) => s.name);
    expect(names).toContain("good-one");
    expect(names).toContain("good-two");
    expect(names).not.toContain("bad-url");
  });

  it("carries headers through verbatim — they are credentials, not ours to edit", async () => {
    const outcomes = await installSkillServers([
      { ...ref("with-header"), headers: { Authorization: "Bearer t" } },
    ]);
    expect(outcomes).toEqual(["installed"]);
    expect(
      await listMcpServers().then((s) => s.find((x) => x.name === "with-header")?.headers),
    ).toEqual({ Authorization: "Bearer t" });
  });
});
