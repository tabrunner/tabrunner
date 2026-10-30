import { homedir } from "node:os";
import { join } from "node:path";
import pkg from "../package.json" with { type: "json" };
import { BRIDGE_PROTOCOL_VERSION } from "./protocol";

function positiveInteger(name: string, fallback: number, max = Number.MAX_SAFE_INTEGER): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new Error(
      `${name} must be a whole number from 1 to ${max}. Fix it and restart the MCP client.`,
    );
  }
  return value;
}

export const config = {
  version: pkg.version,
  protocolVersion: BRIDGE_PROTOCOL_VERSION,
  port: positiveInteger("TABRUNNER_BRIDGE_PORT", 17_836, 65_535),
  expectedExtensionId:
    process.env.TABRUNNER_BRIDGE_EXPECTED_EXTENSION_ID ?? "ilnohobdcigbmlikjbkdpbkhciephdle",
  runtimeDir: process.env.TABRUNNER_BRIDGE_RUNTIME_DIR ?? join(homedir(), ".tabrunner", "mcp"),
  pingMs: positiveInteger("TABRUNNER_BRIDGE_PING_MS", 20_000),
  leaseMs: positiveInteger("TABRUNNER_BRIDGE_LEASE_MS", 60_000),
  idleMs: positiveInteger("TABRUNNER_BRIDGE_IDLE_MS", 10_000),
};
