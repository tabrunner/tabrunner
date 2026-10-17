/**
 * Bundles the MCP daemon into the one file releases ship — deps baked in, so
 * the setup a ZIP-install user copies is one curl and one `claude mcp add`,
 * with no repo checkout and no placeholder path. CI attaches it to the GitHub
 * Release as `tabrunner-<version>-mcp.js` plus the `tabrunner-latest-mcp.js`
 * alias docs/mcp.md's manual setup fetches. The npm package (`tabrunner-mcp`)
 * builds the same bundle in daemon/'s own `prepack`.
 *
 *   bun run bridge:bundle
 */
import { $ } from "bun";
import { fileURLToPath } from "node:url";

// Anchor the build and the dist write to the package root, from anywhere.
process.chdir(fileURLToPath(new URL("..", import.meta.url)));

const pkg = (await Bun.file("package.json").json()) as { version: string };
const out = `dist/tabrunner-${pkg.version}-mcp.js`;
await $`bun build --target=bun daemon/src/index.ts --outfile ${out}`;
console.log(`✔ ${out}`);
