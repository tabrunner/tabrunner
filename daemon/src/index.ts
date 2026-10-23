#!/usr/bin/env bun
import { runBroker } from "./broker";
import { runProxy } from "./proxy";

try {
  if (process.argv.includes("--broker")) await runBroker();
  else await runProxy();
} catch (error) {
  console.error(`[tabrunner] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
