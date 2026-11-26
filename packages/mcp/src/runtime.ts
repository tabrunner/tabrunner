import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { lock } from "proper-lockfile";
import { z } from "zod";
import { config } from "./config";
import { bridgePorts } from "./protocol";

const metadataSchema = z.object({
  url: z.string().url(),
  token: z.string().min(32),
  version: z.string(),
  protocolVersion: z.number().int(),
  readyHandshake: z.literal(true).optional(),
  port: z.number().int(),
  pid: z.number().int().positive(),
});
export type BrokerMetadata = z.infer<typeof metadataSchema>;
const metadataPath = (port: number) => join(config.runtimeDir, `${port}.json`);

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

async function readMetadata(port: number): Promise<BrokerMetadata | null> {
  let file;
  try {
    file = await open(metadataPath(port), constants.O_RDONLY | constants.O_NOFOLLOW);
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
      metadata.port !== port
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
  const path = metadataPath(metadata.port);
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(JSON.stringify(metadata));
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporary, path);
}

export async function removeMetadata(port: number, token: string): Promise<void> {
  const metadata = await readMetadata(port);
  if (metadata?.token === token) await unlink(metadataPath(port));
}

/** Confirm the owner through the existing authenticated HTTP endpoint, not just its file. */
async function liveBroker(port: number): Promise<BrokerMetadata | null> {
  const metadata = await readMetadata(port);
  if (!metadata) return null;
  try {
    const response = await fetch(new URL("/health", metadata.url), {
      headers: { authorization: `Bearer ${metadata.token}` },
      redirect: "error",
      signal: AbortSignal.timeout(500),
    });
    if (!response.ok) return null;
    const parsed = metadataSchema.safeParse(await response.json());
    if (
      parsed.success &&
      parsed.data.token === metadata.token &&
      parsed.data.url === metadata.url &&
      parsed.data.port === port &&
      parsed.data.pid === metadata.pid &&
      parsed.data.protocolVersion === metadata.protocolVersion
    )
      return parsed.data;
  } catch {
    // The previous owner can stop between reading the file and reaching it.
  }
  return null;
}

function compatible(broker: BrokerMetadata | null): broker is BrokerMetadata {
  // The old broker confirms hello with a ping, which Chrome only accepts on the preferred port.
  return (
    broker?.protocolVersion === config.protocolVersion &&
    (broker.port === config.port || broker.readyHandshake === true)
  );
}

async function readSlots() {
  return Promise.all(
    bridgePorts(config.port).map(async (port) => {
      try {
        return { port, broker: await liveBroker(port) };
      } catch (error) {
        // This file must not be trusted or replaced, but a different slot can still work.
        return { port, error: error instanceof Error ? error.message : String(error) };
      }
    }),
  );
}

function unavailable(slots: Awaited<ReturnType<typeof readSlots>>): Error {
  const ports = slots.map((slot) => slot.port);
  const unsafe = slots.find((slot) => slot.error);
  const detail = unsafe ? ` Port ${unsafe.port}: ${unsafe.error}` : "";
  return new Error(
    `TabRunner could not connect: none of its local ports (${ports.join(", ")}) are available. Close old TabRunner sessions or other programs using those ports, then call health. No process was stopped.${detail}`,
  );
}

/** The broker child holds the private lease until it publishes or fails to bind. */
export async function electBroker(start: (port: number) => Promise<boolean>): Promise<void> {
  await prepareRuntimeDir();
  // Binding elects one owner per socket. The lease elects one per range, even
  // if the preferred socket becomes available while a peer is starting elsewhere.
  const release = await lock(
    join(config.runtimeDir, `elect-${config.port}-v${config.protocolVersion}`),
    {
      realpath: false,
      stale: 5_000,
      retries: { retries: 30, factor: 1, minTimeout: 200, maxTimeout: 200 },
    },
  );
  try {
    const slots = await readSlots();
    if (slots.some((slot) => compatible(slot.broker ?? null))) return;
    for (const { port, broker, error } of slots) {
      if (!broker && !error && (await start(port))) return;
    }
  } finally {
    await release();
  }
}

export async function discoverBroker(): Promise<BrokerMetadata> {
  await prepareRuntimeDir();
  let slots = await readSlots();
  // Reuse a listener on an alternate port even if an earlier port just freed up.
  const existing = slots.map((slot) => slot.broker ?? null).find(compatible);
  if (existing) return existing;

  const entry = process.argv[1];
  if (!entry)
    throw new Error("The MCP entry file is missing. Reinstall tabrunner-mcp and reconnect.");
  const child = spawn(process.execPath, [resolve(entry), "--broker"], {
    env: process.env,
    detached: true,
    stdio: "ignore",
  });
  let exited = false;
  let launchError: Error | undefined;
  child.once("error", (error) => {
    launchError = error;
  });
  child.once("exit", (code) => {
    exited = true;
    if (code !== 0)
      launchError = new Error(
        "The local TabRunner bridge exited before starting. Call health to try again. If it keeps failing, restart the MCP client.",
      );
  });
  child.unref();
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (launchError) throw launchError;
    slots = await readSlots();
    const broker = slots.map((slot) => slot.broker ?? null).find(compatible);
    if (broker) return broker;
    if (exited) throw unavailable(slots);
    await Bun.sleep(50);
  }
  throw new Error(
    "The local TabRunner bridge did not finish starting within 8 seconds. Call health to check it again. If it keeps failing, restart the MCP client.",
  );
}
