import { describe, it, expect } from "vitest";
import en from "../locales/en.json";
import ptBR from "../locales/pt-BR.json";
import es from "../locales/es.json";

type Catalog = { [key: string]: unknown };

const LOCALES: Record<string, Catalog> = { en, "pt-BR": ptBR, es };

/** Flatten to dot keys; arrays (returnObjects) flatten by index. */
function flatten(obj: Catalog, prefix = ""): Map<string, string> {
  const out = new Map<string, string>();
  for (const [k, v] of Object.entries(obj)) {
    const full = prefix ? `${prefix}.${k}` : k;
    if (typeof v === "string") out.set(full, v);
    else if (v && typeof v === "object") {
      for (const [fk, fv] of flatten(v as Catalog, full)) out.set(fk, fv);
    }
  }
  return out;
}

function placeholders(s: string): string[] {
  return [...s.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]!).sort();
}

// Key-set parity and empty values are gated by `bun run i18n:check`
// (scripts/check-i18n.ts) — this test covers only what the script can't:
// placeholder agreement between translations.
describe("locale catalogs", () => {
  const flat = Object.fromEntries(Object.entries(LOCALES).map(([l, c]) => [l, flatten(c)]));

  it("use the same {{placeholders}} per key", () => {
    for (const [k, enValue] of flat.en!) {
      for (const loc of ["pt-BR", "es"] as const) {
        const other = flat[loc]!.get(k);
        if (other === undefined) continue; // covered by the key-set test
        expect(placeholders(other), `${loc}:${k} placeholders`).toEqual(placeholders(enValue));
      }
    }
  });
});
