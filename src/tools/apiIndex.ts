// Builds the tools.db entries (kind "api") for the request tools of the vault: the packages (mcp.db) and the
// tool notes. They are never registered one by one in MCP tools/list; AI Ecosystem finds them with tools_find
// and runs them with tools_run, which calls the `tool-runner:environment-variables` service.

import { ToolIndexEntry, ToolEffect } from "../ecosystem/moduleConnector";
import { inputSchema } from "./definition";
import { ToolEntry } from "./types";

export interface ApiEndpoint {
  method: string;
  path: string;
}

const MAX_RESUMO = 100;
const MAX_DESCRIPTION = 4000;
const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** POST endpoints that only read: JQL searches and parsing. */
const POST_READ_PATH = /\/(search(\/jql)?|jql\/(parse|autocompletedata\/suggestions|match))(\/|\?|$)/i;

/** GET is a read; POST/PUT/PATCH/DELETE write, except JQL searches by POST. Unknown method: falls back to `writes`. */
export function effectOf(entry: Pick<ToolEntry, "writes">, endpoint?: ApiEndpoint): ToolEffect {
  if (!endpoint) return entry.writes ? "externo" : "leitura";
  const method = endpoint.method.toUpperCase();
  if (READ_METHODS.has(method)) return "leitura";
  if (method === "POST" && POST_READ_PATH.test(endpoint.path)) return "leitura";
  return "externo";
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

/** Example arguments: the required parameters with their default, first enum value or a <name> marker. */
export function exampleOf(entry: Pick<ToolEntry, "params">): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, spec] of Object.entries(entry.params)) {
    if (!spec.required) continue;
    if (spec.default !== undefined) out[name] = spec.default;
    else if (spec.enum?.length) out[name] = spec.enum[0];
    else if (spec.type === "number" || spec.type === "integer") out[name] = 1;
    else if (spec.type === "boolean") out[name] = true;
    else if (spec.type === "object") out[name] = {};
    else if (spec.type === "array") out[name] = [];
    else out[name] = `<${name}>`;
  }
  return out;
}

/** Every request tool accepts max_chars (see takeMaxChars), so the index advertises it next to the tool's own parameters. */
export function withMaxChars(schema: Record<string, unknown>): Record<string, unknown> {
  const properties = { ...((schema.properties as Record<string, unknown> | undefined) ?? {}) };
  if (!("max_chars" in properties)) {
    properties.max_chars = { type: "integer", description: "Cut the response after this many characters (1 to 1000000); the answer then has truncated and total_chars." };
  }
  return { ...schema, properties };
}

export function toApiIndexEntry(entry: ToolEntry, endpoint?: ApiEndpoint): ToolIndexEntry {
  const efeito = effectOf(entry, endpoint);
  const categoria = entry.mcpName?.trim() || "Vault";
  const description = oneLine(entry.description || entry.title || entry.name, MAX_DESCRIPTION);
  const tags = ["api", ...(endpoint ? [endpoint.method.toLowerCase()] : []), ...(entry.mcpKeys ?? [])];
  return {
    name: entry.name,
    title: entry.title,
    description: endpoint ? `${endpoint.method.toUpperCase()} ${endpoint.path}. ${description}` : description,
    inputSchema: withMaxChars(inputSchema(entry.params)),
    kind: "api",
    categoria,
    tags: [...new Set(tags)],
    resumo: oneLine(entry.title || description, MAX_RESUMO),
    efeito,
    exposicao: "indice",
    exemplo: exampleOf(entry),
  };
}

/** Drops the tools of a package database (notePath ending in .db): AI Ecosystem indexes those in its own tools.db. */
export function withoutPackageDbTools(entries: ToolEntry[]): ToolEntry[] {
  return entries.filter((entry) => !entry.notePath.toLowerCase().endsWith(".db"));
}

/** One entry per ready request tool. `endpointOf` gives the method and path (it may be async: notes are read). */
export async function buildApiIndexEntries(
  entries: ToolEntry[],
  endpointOf: (entry: ToolEntry) => Promise<ApiEndpoint | undefined> | ApiEndpoint | undefined,
): Promise<ToolIndexEntry[]> {
  const out: ToolIndexEntry[] = [];
  for (const entry of entries) {
    if (entry.kind !== "request" || entry.status !== "ready") continue;
    let endpoint: ApiEndpoint | undefined;
    try {
      endpoint = await endpointOf(entry);
    } catch {
      endpoint = undefined;
    }
    out.push(toApiIndexEntry(entry, endpoint));
  }
  return out;
}
