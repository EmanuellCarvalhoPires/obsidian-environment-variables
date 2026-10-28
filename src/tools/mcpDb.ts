// Manages SQLite databases (mcp.db) for MCP packages.
// Uses node:sqlite DatabaseSync for zero-overhead, sub-millisecond queries.

import { DatabaseSync } from "node:sqlite";
import { App, FileSystemAdapter, normalizePath, TFile } from "obsidian";
import { normalizeMcpKey, packageFolder } from "./toolSearch";
import { ToolEntry, VaultNote } from "./types";

export interface McpDbToolRow {
  id: string;
  title: string;
  kind: string;
  request_id: string | null;
  description: string;
  service_tag: string | null;
  service_param: string | null;
  service_exclude_tag: string | null;
  response_fields?: string | null;
  params_schema: string | null;
  tags: string | null;
}

export interface McpDbRequestRow {
  id: string;
  title: string;
  method: string;
  path: string;
  category: string | null;
  writes_data: number;
  doc_url: string | null;
  description: string;
  parameters_schema: string | null;
  body_schema: string | null;
  tags: string | null;
}

export interface McpDbPackageRow {
  id: string;
  name: string;
  version: string;
  app: string;
  tag: string;
  logo: string | null;
  service_tag: string | null;
  service_param: string | null;
  service_template: string | null;
  group_id: string | null;
  tool_count: number;
  request_count: number;
  updated_at: string;
}

export class McpDbManager {
  private dbs = new Map<string, DatabaseSync>();
  private toolsCache: ToolEntry[] = [];
  private toolsByName = new Map<string, { tool: ToolEntry; dbPath: string; requestId: string | null }>();
  private requestsByTool = new Map<string, McpDbRequestRow>();
  private isLoaded = false;

  constructor(private readonly app: App) {}

  /** Closes all open SQLite database handles. */
  close(): void {
    for (const db of this.dbs.values()) {
      try {
        db.close();
      } catch {
        // Ignore close errors
      }
    }
    this.dbs.clear();
    this.toolsCache = [];
    this.toolsByName.clear();
    this.requestsByTool.clear();
    this.isLoaded = false;
  }

  /** Reloads all mcp.db files discovered in the vault. */
  refresh(): ToolEntry[] {
    this.close();
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) {
      return [];
    }

    const basePath = adapter.getBasePath();
    const dbFiles: TFile[] = [];

    for (const file of this.app.vault.getFiles()) {
      if (file.extension === "db" || file.name.endsWith(".db")) {
        dbFiles.push(file);
      }
    }

    for (const file of dbFiles) {
      const fullPath = normalizePath(`${basePath}/${file.path}`);
      try {
        const db = new DatabaseSync(fullPath, { readOnly: true });
        this.dbs.set(file.path, db);

        // Package identity, used by the `mcp` filter of search_vault_tools.
        const pkg = readPackage(db);
        const folder = packageFolder(file.path);
        const mcpName = pkg?.name || pkg?.app || folder || file.basename;
        const mcpKeys = packageKeys(pkg, folder, file.basename);

        // Read all tools
        const toolRows = db.prepare("SELECT * FROM tools").all() as unknown as McpDbToolRow[];
        for (const row of toolRows) {
          if (this.toolsByName.has(row.id)) continue;
          const tags = row.tags ? (JSON.parse(row.tags) as string[]) : [];
          const params = (row.params_schema ? JSON.parse(row.params_schema) : {}) as ToolEntry["params"];
          const writes = tags.some((t) => t.includes("write") || t.includes("create") || t.includes("delete") || t.includes("update"));

          const entry: ToolEntry = {
            name: row.id,
            title: row.title,
            description: row.description,
            kind: row.kind === "script" ? "script" : "request",
            params,
            writes,
            // Package tools stay out of the client's tool list (there are hundreds of them):
            // the AI finds them with search_vault_tools and runs them with run_vault_tool.
            expose: false,
            notePath: file.path,
            noteName: row.title,
            request: row.request_id ?? undefined,
            serviceTag: row.service_tag ?? undefined,
            serviceParam: row.service_param ?? undefined,
            serviceExcludeTag: row.service_exclude_tag ?? undefined,
            mcpName,
            mcpKeys,
            responseFields: parseResponseFields(row.response_fields),
            status: "ready",
            problems: [],
            warnings: [],
          };

          this.toolsCache.push(entry);
          this.toolsByName.set(row.id, { tool: entry, dbPath: file.path, requestId: row.request_id });
        }
      } catch (err) {
        console.warn(`Environment Keys: could not open database ${file.path}`, err);
      }
    }

    this.isLoaded = true;
    return this.toolsCache;
  }

  /** Gets all loaded tools from SQLite MCPs. */
  getTools(): ToolEntry[] {
    if (!this.isLoaded) return this.refresh();
    return this.toolsCache;
  }

  /** Finds a tool definition by name. */
  findTool(name: string): ToolEntry | undefined {
    if (!this.isLoaded) this.refresh();
    return this.toolsByName.get(name)?.tool;
  }

  /** Gets the request row for a given tool name. */
  getRequestForTool(toolName: string): McpDbRequestRow | undefined {
    if (!this.isLoaded) this.refresh();
    const hit = this.toolsByName.get(toolName);
    if (!hit || !hit.requestId) return undefined;

    const db = this.dbs.get(hit.dbPath);
    if (!db) return undefined;

    try {
      const row = db.prepare("SELECT * FROM requests WHERE id = ?").get(hit.requestId) as unknown as McpDbRequestRow | undefined;
      return row;
    } catch {
      return undefined;
    }
  }

  /** Gets response_fields projection paths for a given tool name, or undefined. */
  getResponseFieldsForTool(toolName: string): string[] | undefined {
    if (!this.isLoaded) this.refresh();
    return this.toolsByName.get(toolName)?.tool.responseFields;
  }

  /** Gets a synthesized VaultNote and markdown body for a request tool. */
  getRequestNote(toolName: string): { note: VaultNote; body: string } | undefined {
    const row = this.getRequestForTool(toolName);
    if (!row) return undefined;
    const hit = this.toolsByName.get(toolName);
    const tags = row.tags ? (JSON.parse(row.tags) as string[]) : [];
    const note: VaultNote = {
      path: hit?.dbPath ?? "mcp.db",
      name: row.id,
      frontmatter: {
        method: row.method,
        path: row.path,
        writes_data: row.writes_data === 1,
        tags,
      },
      tags,
    };
    return { note, body: row.description };
  }

  /** Searches tools using FTS5 where available. */
  search(query: string, limit = 10): ToolEntry[] {
    if (!this.isLoaded) this.refresh();
    if (!query.trim()) return this.toolsCache.slice(0, limit);

    const results: ToolEntry[] = [];
    const sanitized = query.replace(/[^\w\s]/g, " ").trim();
    if (!sanitized) return [];

    for (const db of this.dbs.values()) {
      try {
        const rows = db.prepare("SELECT id FROM tools_fts WHERE tools_fts MATCH ? LIMIT ?").all(sanitized, limit) as unknown as Array<{ id: string }>;
        for (const r of rows) {
          const entry = this.toolsByName.get(r.id);
          if (entry && !results.some((existing) => existing.name === entry.tool.name)) {
            results.push(entry.tool);
            if (results.length >= limit) return results;
          }
        }
      } catch {
        // Fallback or ignore FTS query syntax error
      }
    }

    // Fallback: substring match on description/title if FTS produced few results
    if (results.length < limit) {
      const lower = query.toLowerCase();
      for (const t of this.toolsCache) {
        if (results.some((r) => r.name === t.name)) continue;
        if (t.name.toLowerCase().includes(lower) || t.title.toLowerCase().includes(lower) || t.description.toLowerCase().includes(lower)) {
          results.push(t);
          if (results.length >= limit) break;
        }
      }
    }

    return results;
  }
}

interface PackageIdentity {
  id: string;
  name: string;
  app: string;
  tag: string;
}

/** The mcp_package row of a database, or undefined for databases without one. */
function readPackage(db: DatabaseSync): PackageIdentity | undefined {
  try {
    const row = db.prepare("SELECT id, name, app, tag FROM mcp_package LIMIT 1").get() as Record<string, unknown> | undefined;
    if (!row) return undefined;
    const text = (v: unknown) => (typeof v === "string" ? v : "");
    return { id: text(row.id), name: text(row.name), app: text(row.app), tag: text(row.tag) };
  } catch {
    return undefined;
  }
}

/** Every name the package answers to, normalized: id, name, app, last segment of the tag, folder, file name. */
function packageKeys(pkg: PackageIdentity | undefined, folder: string | undefined, basename: string): string[] {
  const raw = [pkg?.id, pkg?.name, pkg?.app, pkg?.tag ? pkg.tag.split("/").pop() : undefined, folder, basename === "mcp" ? undefined : basename];
  return [...new Set(raw.filter((k): k is string => !!k).map(normalizeMcpKey).filter(Boolean))];
}

/** Parses response_fields column (JSON array or comma-separated string) into a list of field paths. */
function parseResponseFields(raw: unknown): string[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (Array.isArray(raw)) {
    const list = raw.map(String).map((s) => s.trim()).filter(Boolean);
    return list.length > 0 ? list : undefined;
  }
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        const list = parsed.map(String).map((s) => s.trim()).filter(Boolean);
        return list.length > 0 ? list : undefined;
      }
    } catch {
      // Fall through to comma split
    }
  }
  const parts = trimmed.split(",").map((s) => s.trim()).filter(Boolean);
  return parts.length > 0 ? parts : undefined;
}
