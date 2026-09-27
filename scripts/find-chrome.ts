import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Branded Chrome ignores --load-extension in headless; Chrome for Testing
 * doesn't. Resolve the newest CfT from the puppeteer cache, fall back to the
 * system Chrome (headed mode would still work there).
 */
export function findChrome(): string {
  const cache = join(homedir(), ".cache", "puppeteer", "chrome");
  if (existsSync(cache)) {
    for (const version of readdirSync(cache).sort().reverse()) {
      const dir = join(cache, version);
      for (const arch of existsSync(dir) ? readdirSync(dir) : []) {
        const bin = join(
          dir,
          arch,
          "Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
        );
        if (existsSync(bin)) return bin;
      }
    }
  }
  return "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
}
