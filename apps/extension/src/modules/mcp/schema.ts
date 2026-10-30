import type { ExternalJsonSchema, ToolDef } from "@/modules/providers/types";
import { exposedPrefix, exposedToolName } from "./names";
import {
  MAX_TOOL_DESC_CHARS,
  MAX_TOOL_SCHEMA_CHARS,
  MAX_TOOLS_PER_SERVER,
  MAX_TOTAL_DESC_CHARS,
  type McpAdvertisedTool,
  type McpServerConfig,
  type McpToolRef,
} from "./types";

/**
 * Turns what servers advertise into what the model sees. Pure: budgets are
 * enforced HERE rather than at call sites so the run snapshot, the test
 * connection probe and any future caller share one version of the rules.
 */

export interface CatalogInput {
  config: McpServerConfig;
  advertised: McpAdvertisedTool[];
}

export interface ServerCatalog {
  /** Exposed defs in stored order — appended to the model's tool array as-is. */
  defs: ToolDef[];
  /** This server's slice of exposedName → wire identity. */
  refs: Map<string, McpToolRef>;
  /** Tools not ingested: bad/duplicate schema or name. */
  rejected: number;
  /** Tools that fit every rule except the global description budget. */
  droppedForBudget: number;
}

export interface Catalog {
  servers: Map<string, ServerCatalog>;
  entries: Array<{ def: ToolDef; ref: McpToolRef }>;
}

/**
 * Builds every server's slice of the run catalog. Servers process in stored
 * order against ONE global description budget — an early chatty server can
 * starve later ones; deterministic, visible in the status row, and the upgrade
 * path (per-server shares) only matters past the first real complaint.
 */
export function buildCatalog(inputs: CatalogInput[]): Catalog {
  const catalog: Catalog = { servers: new Map(), entries: [] };
  const usedNames = new Set<string>();
  const usedTokens = new Set<string>();
  let budgetLeft = MAX_TOTAL_DESC_CHARS;

  for (const { config, advertised } of inputs) {
    const slice: ServerCatalog = { defs: [], refs: new Map(), rejected: 0, droppedForBudget: 0 };

    // The prefix a server contributes rides inside every exposed name, so two
    // servers that sanitize identically cannot both exist — later yields whole.
    const prefix = exposedPrefix(config.name);
    if (usedTokens.has(prefix)) {
      slice.rejected = advertised.length;
      catalog.servers.set(config.id, slice);
      continue;
    }
    usedTokens.add(prefix);

    for (const tool of advertised.slice(0, MAX_TOOLS_PER_SERVER)) {
      const schema = externalSchema(tool.inputSchema);
      if (!schema) {
        slice.rejected++;
        continue;
      }
      const exposed = exposedToolName(config.name, tool.name);
      if (usedNames.has(exposed)) {
        // Within one server: a misbehaving duplicate; across servers: a
        // truncation collision. First wins either way.
        slice.rejected++;
        continue;
      }
      // The schema rides every turn just like the description, so it gets the
      // same kind of ceiling — enforced before any budget is spent on the tool.
      if (JSON.stringify(schema).length > MAX_TOOL_SCHEMA_CHARS) {
        slice.rejected++;
        continue;
      }
      const description = (tool.description ?? "").slice(0, MAX_TOOL_DESC_CHARS);
      if (description.length > budgetLeft) {
        slice.droppedForBudget++;
        continue;
      }
      budgetLeft -= description.length;
      usedNames.add(exposed);
      const def: ToolDef = { name: exposed, description, params: schema };
      const ref: McpToolRef = { serverId: config.id, serverName: config.name, toolName: tool.name };
      slice.defs.push(def);
      slice.refs.set(exposed, ref);
      catalog.entries.push({ def, ref });
    }

    catalog.servers.set(config.id, slice);
  }

  return catalog;
}

/**
 * The single guarded ingestion site for remote schemas: full JSON Schema rides
 * into ToolDef.params verbatim (adapters assign it straight onto the wire), so
 * the only promise needed is "an object schema". Absent schemas become the
 * empty object schema — lenient where a no-argument tool would otherwise drop.
 */
function externalSchema(raw: unknown): ExternalJsonSchema | undefined {
  if (raw === undefined || raw === null) return { type: "object" };
  if (typeof raw !== "object") return undefined;
  const s = raw as Record<string, unknown>;
  return s.type === "object" ? (s as ExternalJsonSchema) : undefined;
}
