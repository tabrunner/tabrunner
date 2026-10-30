#!/usr/bin/env bun
/**
 * i18n consistency checker (ported from olhary).
 *
 * Runs two independent checks over the locale catalogs:
 *
 *   1. Locale parity   — every leaf key present in ANY locale must exist and be
 *                        non-empty in EVERY locale. Catches keys added to one
 *                        language but forgotten in the others.
 *   2. Code ↔ catalog  — every statically-referenced key in the source must
 *                        exist in the canonical locale (the i18next `fallbackLng`,
 *                        English). Keys built from template literals are checked at
 *                        the static-prefix level only and listed for manual review;
 *                        the catalog is also scanned for keys no reference touches.
 *
 * What it references:
 *   - `t("a.b")` / `i18n.t("a.b")` / `t(`a.${x}`)` calls and `<Trans i18nKey="a.b">`,
 *   - key-bearing fields (`nameKey`/`labelKey`/…) whose value's first segment is a
 *     real top-level catalog section.
 *
 * i18next idioms it understands so it does not cry wolf:
 *   - pluralization — `t("x.count", { count })` resolves to `x.count_one` /
 *     `x.count_other`, so a base key counts as present if any plural form exists;
 *   - returnObjects — a key may resolve to an array/object subtree;
 *   - keyPrefix — a bare `t("leaf")` inside a `keyPrefix` scope marks
 *     `<prefix>.leaf` used.
 *
 * Hard failures (exit 1, so it can gate CI) are limited to what it can PROVE
 * wrong: a parity gap, or a fully-static key absent from the canonical locale
 * with no inline `defaultValue`. Everything dynamic is advisory.
 *
 *   Run:  bun run i18n:check
 */

import { Glob } from "bun";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");

// ── Bundle configuration ──────────────────────────────────────────────────────

interface LocaleSource {
  /** Path (relative to repo root) of the JSON catalog. */
  file: string;
}

interface Bundle {
  name: string;
  canonical: string;
  locales: Record<string, LocaleSource>;
  /** Globs (relative to repo root) of source files that reference keys. Empty
   *  means parity only. */
  code: string[];
}

const BUNDLES: Bundle[] = [
  {
    name: "tabrunner",
    canonical: "en",
    locales: {
      en: { file: "src/i18n/locales/en.json" },
      "pt-BR": { file: "src/i18n/locales/pt-BR.json" },
      es: { file: "src/i18n/locales/es.json" },
    },
    code: ["src/**/*.{ts,tsx}"],
  },
  {
    // Chrome's own catalogs: the manifest's __MSG_*__ and the side panel's boot
    // cover (read before the app's catalogs load). Parity only — their keys are
    // referenced as chrome.i18n.getMessage / __MSG_ strings, not t() calls.
    name: "extension (_locales)",
    canonical: "en",
    locales: {
      en: { file: "public/_locales/en/messages.json" },
      pt_BR: { file: "public/_locales/pt_BR/messages.json" },
      es: { file: "public/_locales/es/messages.json" },
    },
    code: [],
  },
];

/** Source files we never scan for key usage (tests, the i18n module itself). */
const ignored = (rel: string): boolean =>
  /(?:^|\/)__tests__\//.test(rel) ||
  /\.(test|spec)\.[tj]sx?$/.test(rel) ||
  /(?:^|\/)i18n\//.test(rel);

const PLURAL_SUFFIXES = ["zero", "one", "two", "few", "many", "other"];

// ── Catalog helpers ───────────────────────────────────────────────────────────

type Catalog = { [key: string]: string | Catalog };

/** Collect every leaf (string-valued) key in dot notation. */
function collectLeafKeys(obj: Catalog, prefix = ""): string[] {
  const keys: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    const full = prefix ? `${prefix}.${k}` : k;
    if (typeof v === "string") keys.push(full);
    else if (v && typeof v === "object") keys.push(...collectLeafKeys(v, full));
  }
  return keys;
}

/** Resolve a dot key to its leaf string, or undefined if absent / not a leaf. */
function resolveLeaf(obj: Catalog, key: string): string | undefined {
  let cur: Catalog | string | undefined = obj;
  for (const part of key.split(".")) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = cur[part];
  }
  return typeof cur === "string" ? cur : undefined;
}

/** True if the dot path resolves to an existing node (leaf OR subtree). */
function pathExists(obj: Catalog, key: string): boolean {
  let cur: Catalog | string | undefined = obj;
  for (const part of key.split(".")) {
    if (!cur || typeof cur !== "object") return false;
    cur = cur[part];
  }
  return cur !== undefined;
}

/** Present = exists as leaf/subtree (returnObjects) OR has a plural variant. */
function isPresent(obj: Catalog, key: string): boolean {
  if (pathExists(obj, key)) return true;
  return PLURAL_SUFFIXES.some((s) => resolveLeaf(obj, `${key}_${s}`) !== undefined);
}

async function loadCatalog(src: LocaleSource): Promise<Catalog> {
  return (await Bun.file(resolve(ROOT, src.file)).json()) as Catalog;
}

// ── Code scanning ─────────────────────────────────────────────────────────────

interface StaticRef {
  key: string;
  file: string;
  line: number;
  hasDefault: boolean;
}

interface DynamicRef {
  display: string; // e.g. "run.tool.*"
  checkPath: string | null; // catalog node that must exist, or null if undecidable
  matchPrefix: string; // prefix used to mark catalog keys as used
  partial: boolean; // dynamic var sits mid-segment (matchPrefix has no trailing dot)
  file: string;
  line: number;
}

interface ScanResult {
  staticRefs: StaticRef[];
  dynamics: Map<string, DynamicRef>;
  seenStatic: Set<string>;
  /** Bare key-path string literals (e.g. lookup-map values fed to t(key)). */
  prefixLiterals: Set<string>;
  /** i18next `keyPrefix` values — bare t("leaf") refs under them count as used. */
  keyPrefixes: Set<string>;
}

// [regex, qualify]. Qualified patterns only count when the key's first segment is
// a real catalog section — keeps `apiKey`/`cacheKey`/etc. out of the key-field pass.
const PATTERNS: ReadonlyArray<readonly [RegExp, boolean]> = [
  [/\bt\(\s*(["'`])((?:\\.|(?!\1).)*?)\1/g, false],
  [/\bi18nKey\s*=\s*\{?\s*(["'`])((?:\\.|(?!\1).)*?)\1/g, false],
  [/\b[a-zA-Z][a-zA-Z0-9]*[kK]ey\s*[:=]\s*\{?\s*(["'`])((?:\\.|(?!\1).)*?)\1/g, true],
];

// Bare i18n-key-shaped string literals (dotted paths, ≥2 segments). Catches keys
// referenced indirectly — e.g. `{ navigate: "run.tool.navigate" }` lookup maps
// whose values are later fed to `t(MAP[tool])`, which the patterns above miss.
const PREFIX_LITERAL = /(["'`])([a-zA-Z][a-zA-Z0-9]*(?:\.[a-zA-Z0-9_]+)+)\1/g;

// Template-literal key prefixes built outside a t() call, e.g.
// `const key = `chat.hint.${kind}`` then `t(key)`. Captures the static path
// before `.${`; treated like a prefix literal (covers the subtree).
const PREFIX_TEMPLATE = /`([a-zA-Z][a-zA-Z0-9_]*(?:\.[a-zA-Z0-9_]+)*)\.\$\{/g;

// i18next `keyPrefix` (hook option or Trans prop): `t("leaf")` in that scope
// resolves to `<prefix>.leaf`, so the bare ref marks the full key used.
const KEY_PREFIX = /\bkeyPrefix\s*[:=]\s*(["'`])([a-zA-Z][a-zA-Z0-9_.]*)\1/g;

function lineAt(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) if (source[i] === "\n") line++;
  return line;
}

function scanSource(source: string, file: string, namespaces: Set<string>, into: ScanResult): void {
  for (const [re, qualify] of PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(source))) {
      const raw = m[2]!;
      if (qualify && !namespaces.has(raw.split(/[.$]/, 1)[0]!)) continue;
      const line = lineAt(source, m.index);
      const dollar = raw.indexOf("${");

      if (dollar === -1) {
        const dedupe = `${file}:${line}:${raw}`;
        if (into.seenStatic.has(dedupe)) continue;
        into.seenStatic.add(dedupe);
        into.staticRefs.push({
          key: raw,
          file,
          line,
          // A nearby `defaultValue` means a missing key still renders a
          // fallback, so it is a warning rather than a hard failure.
          hasDefault: /defaultValue/.test(source.slice(m.index, m.index + 200)),
        });
        continue;
      }

      const rawPrefix = raw.slice(0, dollar); // "a.b." (whole segment) or "x.read_" (partial)
      let checkPath: string | null;
      let matchPrefix: string;
      let partial: boolean;
      if (rawPrefix.endsWith(".")) {
        checkPath = matchPrefix = rawPrefix.slice(0, -1);
        partial = false;
      } else {
        const lastDot = rawPrefix.lastIndexOf(".");
        checkPath = lastDot >= 0 ? rawPrefix.slice(0, lastDot) : null;
        matchPrefix = rawPrefix;
        partial = true;
      }
      const display = `${matchPrefix}${partial ? "" : "."}*`;
      if (!into.dynamics.has(display))
        into.dynamics.set(display, { display, checkPath, matchPrefix, partial, file, line });
    }
  }

  // Indirect references: namespaced key-path literals (see PREFIX_LITERAL).
  PREFIX_LITERAL.lastIndex = 0;
  let pm: RegExpExecArray | null;
  while ((pm = PREFIX_LITERAL.exec(source))) {
    const val = pm[2]!;
    if (namespaces.has(val.split(".", 1)[0]!)) into.prefixLiterals.add(val);
  }

  // Template-literal key prefixes built outside t() (see PREFIX_TEMPLATE).
  PREFIX_TEMPLATE.lastIndex = 0;
  let tm: RegExpExecArray | null;
  while ((tm = PREFIX_TEMPLATE.exec(source))) {
    const val = tm[1]!;
    if (namespaces.has(val.split(".", 1)[0]!)) into.prefixLiterals.add(val);
  }

  // keyPrefix scopes (see KEY_PREFIX).
  KEY_PREFIX.lastIndex = 0;
  let km: RegExpExecArray | null;
  while ((km = KEY_PREFIX.exec(source))) into.keyPrefixes.add(km[2]!);
}

// ── Runner ────────────────────────────────────────────────────────────────────

async function checkBundle(bundle: Bundle): Promise<number> {
  console.log(`\n══ ${bundle.name} ${"═".repeat(Math.max(0, 56 - bundle.name.length))}`);

  let catalogs: Record<string, Catalog>;
  try {
    catalogs = Object.fromEntries(
      await Promise.all(
        Object.entries(bundle.locales).map(
          async ([loc, src]) => [loc, await loadCatalog(src)] as const,
        ),
      ),
    );
  } catch (err) {
    console.log(`  ⚠ skipped — could not load catalogs: ${(err as Error).message}`);
    return 0;
  }

  const canonical = catalogs[bundle.canonical]!;
  const namespaces = new Set(Object.keys(canonical));
  let failures = 0;

  // 1. Locale parity (union-based, reference-agnostic).
  const perLocaleKeys = Object.fromEntries(
    Object.entries(catalogs).map(([loc, cat]) => [loc, new Set(collectLeafKeys(cat))] as const),
  );
  const union = new Set<string>(Object.values(perLocaleKeys).flatMap((s) => [...s]));

  console.log("\n  Locale parity");
  let parityGaps = 0;
  for (const [loc, keys] of Object.entries(perLocaleKeys)) {
    const missing = [...union].filter((k) => !keys.has(k)).sort();
    const empty = [...keys]
      .filter((k) => (resolveLeaf(catalogs[loc]!, k) ?? "").trim() === "")
      .sort();
    for (const k of missing) console.log(`    ✖ ${loc.padEnd(5)} missing  ${k}`);
    for (const k of empty) console.log(`    ✖ ${loc.padEnd(5)} empty    ${k}`);
    parityGaps += missing.length + empty.length;
  }
  if (parityGaps === 0) console.log("    ✔ all locales aligned");
  failures += parityGaps;
  // A parity-only bundle: its keys are read in a way no t() scan can see.
  if (bundle.code.length === 0) return failures;

  // 2. Code → catalog.
  const scan: ScanResult = {
    staticRefs: [],
    dynamics: new Map(),
    seenStatic: new Set(),
    prefixLiterals: new Set(),
    keyPrefixes: new Set(),
  };
  const seenFile = new Set<string>();
  for (const pattern of bundle.code) {
    for await (const rel of new Glob(pattern).scan({ cwd: ROOT })) {
      if (ignored(rel) || seenFile.has(rel)) continue;
      seenFile.add(rel);
      scanSource(await Bun.file(resolve(ROOT, rel)).text(), rel, namespaces, scan);
    }
  }

  console.log(`\n  Code → ${bundle.canonical} (static keys missing from catalog)`);
  const missingStatic = scan.staticRefs
    .filter((r) => !isPresent(canonical, r.key))
    .sort((a, b) => a.key.localeCompare(b.key));
  const hard = missingStatic.filter((r) => !r.hasDefault);
  const soft = missingStatic.filter((r) => r.hasDefault);
  for (const r of hard) console.log(`    ✖ ${r.key}\n        ${r.file}:${r.line}`);
  for (const r of soft) console.log(`    ⚠ ${r.key}  (has defaultValue)  ${r.file}:${r.line}`);
  if (hard.length === 0) console.log("    ✔ every static key resolves");
  failures += hard.length;

  // 3. Dynamic prefixes (advisory — enumerate values by hand).
  const leaves = collectLeafKeys(canonical);
  const dynOk = (d: DynamicRef): boolean =>
    d.matchPrefix === ""
      ? true
      : d.partial
        ? leaves.some((k) => k.startsWith(d.matchPrefix))
        : pathExists(canonical, d.checkPath!);

  console.log("\n  Dynamic keys (prefix-checked only — enumerate values by hand)");
  const dynamics = [...scan.dynamics.values()].sort((a, b) => a.display.localeCompare(b.display));
  if (dynamics.length === 0) console.log("    · none");
  for (const d of dynamics) {
    const label = d.matchPrefix === "" ? "(fully dynamic — uncheckable)" : d.display;
    const ok = dynOk(d);
    console.log(
      `    ${ok ? "·" : "⚠"} ${label}  ${ok ? "" : "(prefix absent!) "}${d.file}:${d.line}`,
    );
    if (!ok) failures += 1;
  }

  // 4. Possibly-unused (advisory — dynamic refs evade detection).
  const used = new Set(scan.staticRefs.map((r) => r.key));
  const litPrefixes = [...scan.prefixLiterals].filter((p) => isPresent(canonical, p));
  const coveredByDynamic = (k: string): boolean =>
    dynamics.some((d) =>
      d.matchPrefix === ""
        ? false
        : d.partial
          ? k.startsWith(d.matchPrefix)
          : k === d.matchPrefix || k.startsWith(`${d.matchPrefix}.`),
    );
  const coveredByLiteral = (k: string): boolean =>
    litPrefixes.some((p) => k === p || k.startsWith(`${p}.`));
  const coveredByKeyPrefix = (k: string): boolean =>
    [...scan.keyPrefixes].some((p) => k.startsWith(`${p}.`) && used.has(k.slice(p.length + 1)));
  // A plural leaf (`x_one`/`x_other`/…) is used when its base `x` is — i18next
  // resolves `t("x", { count })` to the variant, so the variant has no own ref.
  const pluralRe = new RegExp(`_(${PLURAL_SUFFIXES.join("|")})$`);
  const coveredByPlural = (k: string): boolean => {
    const m = k.match(pluralRe);
    if (!m) return false;
    const base = k.slice(0, -m[0].length);
    return used.has(base) || coveredByDynamic(base) || coveredByLiteral(base);
  };
  const unused = leaves
    .filter(
      (k) =>
        !used.has(k) &&
        !coveredByDynamic(k) &&
        !coveredByLiteral(k) &&
        !coveredByPlural(k) &&
        !coveredByKeyPrefix(k),
    )
    .sort();
  // Silent when clean — an advisory that always prints trains you to ignore it.
  if (unused.length > 0) {
    console.log(`\n  Possibly unused in ${bundle.canonical} (advisory)`);
    for (const k of unused) console.log(`    · ${k}`);
  }

  return failures;
}

let total = 0;
for (const bundle of BUNDLES) total += await checkBundle(bundle);

console.log(`\n${"─".repeat(60)}`);
if (total === 0) {
  console.log("✔ i18n check passed — no parity gaps or missing static keys.");
  process.exit(0);
}
console.log(`✖ i18n check failed — ${total} hard issue(s) above.`);
process.exit(1);
