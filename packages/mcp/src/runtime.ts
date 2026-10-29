import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import { config } from "./config";

const metadataSchema = z.object({
  url: z.string().url(),
  token: z.string().min(32),
  version: z.string(),
  protocolVersion: z.number().int(),
  port: z.number().int(),
  pid: z.number().int().positive(),
});
export type BrokerMetadata = z.infer<typeof metadataSchema>;
export const metadataPath = join(config.runtimeDir, `${config.port}.json`);

export async function prepareRuntimeDir(): Promise<void> {
  await mkdir(config.runtimeDir, { recursive: true, mode: 0o700 });
  const stat = await lstat(config.runtimeDir);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (process.getuid && stat.uid !== process.getuid())
  ) {
    throw new Error(
      "The MCP runtime folder is not a private folder owned by you. Set TABRUNNER_BRIDGE_RUNTIME_DIR to a private folder and restart the client.",
    );
  }
  await chmod(config.runtimeDir, 0o700);
}

export async function readMetadata(): Promise<BrokerMetadata | null> {
  let file;
  try {
    file = await open(metadataPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.mode & 0o077 || (process.getuid && stat.uid !== process.getuid())) {
      throw new Error(
        "The MCP runtime file is not private. Remove access for other users, then restart the client.",
      );
    }
    let body: unknown;
    try {
      body = JSON.parse(await file.readFile("utf8"));
    } catch {
      throw new Error(
        "The MCP runtime file is not valid JSON. Check TABRUNNER_BRIDGE_RUNTIME_DIR and restart the client.",
      );
    }
    const result = metadataSchema.safeParse(body);
    if (!result.success)
      throw new Error(
        "The MCP runtime file is invalid. Check TABRUNNER_BRIDGE_RUNTIME_DIR and restart the client.",
      );
    const metadata = result.data;
    const url = new URL(metadata.url);
    if (
      url.hostname !== "127.0.0.1" ||
      url.protocol !== "http:" ||
      url.pathname !== "/mcp" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !url.port ||
      metadata.port !== config.port
    ) {
      throw new Error(
        "The MCP runtime file points outside this local bridge. Check TABRUNNER_BRIDGE_RUNTIME_DIR and restart the client.",
      );
    }
    return metadata;
  } finally {
    await file.close();
  }
}

export async function publishMetadata(metadata: BrokerMetadata): Promise<void> {
  const temporary = `${metadataPath}.${crypto.randomUUID()}.tmp`;
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(JSON.stringify(metadata));
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporary, metadataPath);
}

export async function removeMetadata(token: string): Promise<void> {
  const metadata = await readMetadata();
  if (metadata?.token === token) await unlink(metadataPath);
}

async function ready(metadata: BrokerMetadata): Promise<boolean> {
  let response: Response;
  try {
    response = await fetch(new URL("/health", metadata.url), {
      headers: { authorization: `Bearer ${metadata.token}` },
      redirect: "error",
      signal: AbortSignal.timeout(500),
    });
  } catch {
    return false;
  }
  if (!response.ok) return false;
  const body: unknown = await response.json();
  const parsed = metadataSchema.safeParse(body);
  if (!parsed.success || parsed.data.token !== metadata.token || parsed.data.url !== metadata.url)
    return false;
  if (
    metadata.version !== config.version ||
    metadata.protocolVersion !== config.protocolVersion ||
    parsed.data.version !== config.version ||
    parsed.data.protocolVersion !== config.protocolVersion
  ) {
    throw new Error(
      `A different TabRunner MCP version is already using port ${config.port}. This client is ${config.version} (protocol ${config.protocolVersion}); the broker is ${metadata.version} (protocol ${metadata.protocolVersion}). Update all MCP clients to the same version, close them and reconnect. The running broker was left alone.`,
    );
  }
  return true;
}

export async function discoverBroker(): Promise<BrokerMetadata> {
  await prepareRuntimeDir();
  const existing = await readMetadata();
  if (existing && (await ready(existing))) return existing;
  const entry = process.argv[1];
  if (!entry)
    throw new Error("The MCP entry file is missing. Reinstall tabrunner-mcp and reconnect.");
  const child = spawn(process.execPath, [resolve(entry), "--broker"], {
    env: process.env,
    detached: true,
    stdio: "ignore",
  });
  let launchError: Error | null = null;
  child.on("error", (error) => {
    launchError = error;
  });
  child.unref();
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (launchError) throw launchError;
    const metadata = await readMetadata();
    if (metadata && (await ready(metadata))) return metadata;
    await Bun.sleep(50);
  }
  throw new Error(
    `TabRunner could not start or find its shared MCP bridge on port ${config.port}. Another program may own that port, or the broker could not start. Close the other program or use a free TABRUNNER_BRIDGE_PORT that matches the extension's MCP setting, then reconnect. No listener was stopped.`,
  );
}
