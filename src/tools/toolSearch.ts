// search_vault_tools and the vault_tool_hint of http_request: finds the vault tools that cover an
// HTTP endpoint (method + URL) or match keywords, so an AI agent uses a vault tool, even one with
// expose: false, instead of a raw http_request. Pure functions; ToolsService feeds them the notes.

import { ToolEntry } from "./types";

/** The endpoint a request tool calls, compiled to match real URLs. */
export interface EndpointPattern {
  tool: ToolEntry;
  method: string;
  /** For display, e.g. /rest/api/3/issue/{issueIdOrKey}/changelog. */
  path: string;
  re: RegExp;
  /** Parameter names, in the order of the regex groups. */
  params: string[];
  /** Length of the fixed part of the path: the more fixed text, the more specific the match. */
  literal: number;
}

export interface EndpointMatch {
  pattern: EndpointPattern;
  /** Parameter values taken from the URL. */
  args: Record<string, string>;
}

/** How to call a tool: by name if it is in the client's list, otherwise through run_vault_tool. */
export interface RunHint {
  call: string;
  arguments: Record<string, unknown>;
}

export interface SearchInput {
  query?: unknown;
  method?: unknown;
  url?: unknown;
  /** MCP package: "Jira", "Jira Service Management", "Bitbucket", "jsm"... */
  mcp?: unknown;
  /** Exact tool name, e.g. "jira_get_issue". */
  name?: unknown;
  limit?: unknown;
  offset?: unknown;
}

export interface SearchResult {
  name: string;
  title: string;
  description: string;
  endpoint?: string;
  params: ToolEntry["params"];
  writes: boolean;
  exposed: boolean;
  mcp?: string;
  run: RunHint;
}

/** One line per tool when a whole MCP is listed (mcp filter without query, name or url). */
export interface ListedTool {
  name: string;
  title: string;
  writes: boolean;
}

/** An MCP package and how many usable tools it has. */
export interface McpSummary {
  mcp: string;
  tools: number;
}

export interface SearchOutput {
  results: Array<SearchResult | ListedTool>;
  /** How many tools matched before limit/offset. */
  total: number;
  /** The MCPs that matched the mcp filter, or every MCP when the search had no criteria. */
  mcps?: McpSummary[];
  note: string;
}

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;
const MAX_DESCRIPTION = 300;

/**
 * Method and path of a request note: the first line of its ```http block or, without one,
 * the `method` and `path` properties of its frontmatter.
 */
export function endpointOf(noteText: string, frontmatter: Record<string, unknown>): { method: string; path: string } | undefined {
  const block = /```http[^\n]*\n\s*([A-Za-z]+)\s+(\S+)/.exec(noteText);
  if (block) return { method: block[1].toUpperCase(), path: block[2] };
  if (typeof frontmatter.method === "string" && typeof frontmatter.path === "string") {
    return { method: frontmatter.method.toUpperCase(), path: frontmatter.path };
  }
  return undefined;
}

const PARAM_TOKEN = /(\{\{\s*param\s*:\s*[^}]+\}\}|\{[A-Za-z0-9_]+\})/;
const ANY_PLACEHOLDER = /\{\{[^}]*\}\}/g;
const escapeRegex = (text: string) => text.replace(/[.*+?^$()|[\]\\{}]/g, "\\$&");

/** Compiles a request's path (with {{service.*}}, {{param:x}} or {x}) into a URL matcher. */
export function compileEndpoint(tool: ToolEntry, method: string, rawPath: string): EndpointPattern | undefined {
  const path = rawPath
    .split("?")[0]
    .replace(/^\{\{[^}]*\}\}/, "") // {{service.url}} at the start: the base URL
    .replace(/^https?:\/\/[^/]+/i, "");
  const params: string[] = [];
  let literal = 0;
  const source = path
    .split(PARAM_TOKEN)
    .map((piece) => {
      const param = /^\{\{\s*param\s*:\s*([^}]+?)\s*\}\}$/.exec(piece) ?? /^\{([A-Za-z0-9_]+)\}$/.exec(piece);
      if (param) {
        params.push(param[1]);
        return "([^/]+)";
      }
      literal += piece.replace(ANY_PLACEHOLDER, "").length;
      return piece
        .split(ANY_PLACEHOLDER)
        .map(escapeRegex)
        .join("[^/]*");
    })
    .join("");
  if (!source.startsWith("/")) return undefined;
  return {
    tool,
    method: method.toUpperCase(),
    path: path.replace(/\{\{\s*param\s*:\s*([^}]+?)\s*\}\}/g, "{$1}"),
    // Matched at the end of the URL's path, so a base path in the service URL (e.g. /2.0) still matches.
    re: new RegExp(`${source.replace(/\/$/, "")}/?$`),
    params,
    literal,
  };
}

/** The patterns that match a method + URL, the most specific first. */
export function matchEndpoint(index: EndpointPattern[], method: unknown, url: string): EndpointMatch[] {
  let pathname: string;
  try {
    pathname = decodeURI(new URL(url, "https://x.invalid").pathname);
  } catch {
    return [];
  }
  const wanted = (typeof method === "string" && method ? method : "GET").toUpperCase();
  const out: EndpointMatch[] = [];
  for (const pattern of index) {
    if (pattern.method !== wanted) continue;
    const m = pattern.re.exec(pathname);
    if (!m) continue;
    const args: Record<string, string> = {};
    pattern.params.forEach((name, i) => (args[name] = m[i + 1]));
    out.push({ pattern, args });
  }
  return out.sort((a, b) => b.pattern.literal - a.pattern.literal);
}

export function howToRun(tool: ToolEntry, args: Record<string, unknown> = {}): RunHint {
  return tool.expose ? { call: tool.name, arguments: args } : { call: "tools_run", arguments: { id: tool.name, args } };
}

/** Lowercase, without accents and with "-", "_" and repeated spaces turned into one space. */
export function normalizeMcpKey(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[-_\s]+/g, " ")
    .trim();
}

/** The package folder of a file under ".../MCPs/<folder>/...", e.g. "Jira Cloud". */
export function packageFolder(path: string): string | undefined {
  const m = /(?:^|\/)MCPs\/([^/]+)\//.exec(path);
  return m ? m[1] : undefined;
}

/** The MCP a tool belongs to: its package (mcp.db) or the MCPs/<folder> of its note. */
export function mcpOf(tool: ToolEntry): { name: string; keys: string[] } | undefined {
  if (tool.mcpName) return { name: tool.mcpName, keys: tool.mcpKeys?.length ? tool.mcpKeys : [normalizeMcpKey(tool.mcpName)] };
  const folder = packageFolder(tool.notePath);
  return folder ? { name: folder, keys: [normalizeMcpKey(folder)] } : undefined;
}

/**
 * Tools of the MCPs the filter names. An exact name ("Jira" = tag jira, "jsm", "Bitbucket",
 * "Jira Service Management") wins; without one, any MCP whose name contains the filter.
 */
function filterByMcp(tools: ToolEntry[], filter: string): ToolEntry[] {
  const wanted = normalizeMcpKey(filter);
  if (!wanted) return tools;
  const exact = tools.filter((t) => mcpOf(t)?.keys.includes(wanted));
  if (exact.length) return exact;
  return tools.filter((t) => mcpOf(t)?.keys.some((k) => k.includes(wanted)));
}

/** Every MCP among the tools, with its tool count, largest first. */
export function summarizeMcps(tools: ToolEntry[]): McpSummary[] {
  const counts = new Map<string, number>();
  for (const t of tools) {
    const m = mcpOf(t);
    if (m) counts.set(m.name, (counts.get(m.name) ?? 0) + 1);
  }
  return [...counts.entries()].map(([mcp, n]) => ({ mcp, tools: n })).sort((a, b) => b.tools - a.tools || a.mcp.localeCompare(b.mcp));
}

const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const clamp = (v: unknown, def: number, max: number) => Math.min(Math.max(1, typeof v === "number" && Number.isFinite(v) ? Math.floor(v) : def), max);

/**
 * search_vault_tools. Filters: `mcp` (package), `name` (exact tool name), `url` + `method`
 * (endpoint) and `query` (keywords). With only `mcp`, lists that MCP's tools one line each.
 * Without any criteria, returns the available MCPs.
 */
export function searchTools(tools: ToolEntry[], index: EndpointPattern[], input: SearchInput): SearchOutput {
  const query = text(input.query);
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const name = text(input.name).toLowerCase();
  const url = text(input.url);
  const mcp = text(input.mcp);
  const offset = typeof input.offset === "number" && input.offset > 0 ? Math.floor(input.offset) : 0;

  const ready = tools.filter((t) => t.status === "ready");
  const pool = mcp ? filterByMcp(ready, mcp) : ready;
  const mcps = mcp ? summarizeMcps(pool) : undefined;

  if (!query && !name && !url) {
    if (!mcp) {
      return {
        results: [],
        total: 0,
        mcps: summarizeMcps(ready),
        note: "No search criteria. Pass mcp (one of mcps), name (exact tool name), query (keywords) and/or method + url.",
      };
    }
    // Whole MCP listing: one short line per tool, paged.
    const limit = clamp(input.limit, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
    const sorted = [...pool].sort((a, b) => a.name.localeCompare(b.name));
    const page = sorted.slice(offset, offset + limit).map((t) => ({ name: t.name, title: t.title, writes: t.writes }));
    return {
      results: page,
      total: sorted.length,
      mcps,
      note: !sorted.length
        ? `No MCP matched "${mcp}". Call search_vault_tools without arguments to see the MCPs.`
        : offset + page.length < sorted.length
          ? `Showing ${offset + 1}-${offset + page.length} of ${sorted.length}. Pass offset to see more, or add query to narrow down. Use name to get a tool's parameters.`
          : "Use name to get a tool's parameters, then run it with tools_run.",
    };
  }

  const limit = clamp(input.limit, DEFAULT_LIMIT, MAX_LIMIT);
  const found = new Map<string, { tool: ToolEntry; score: number; args?: Record<string, string>; endpoint?: string }>();
  const add = (tool: ToolEntry, score: number, extra: { args?: Record<string, string>; endpoint?: string } = {}) => {
    const hit = found.get(tool.name);
    if (hit) hit.score += score;
    else found.set(tool.name, { tool, score, ...extra });
  };
  const inPool = new Set(pool.map((t) => t.name));

  if (name) {
    const exact = pool.filter((t) => t.name.toLowerCase() === name);
    if (exact.length) exact.forEach((t) => add(t, 100_000));
    else pool.filter((t) => t.name.toLowerCase().includes(name)).forEach((t) => add(t, 500));
  }
  if (url) {
    for (const { pattern, args } of matchEndpoint(index, input.method, url)) {
      if (inPool.has(pattern.tool.name) && !found.has(pattern.tool.name)) {
        add(pattern.tool, 1000 + pattern.literal, { args, endpoint: `${pattern.method} ${pattern.path}` });
      }
    }
  }
  if (words.length > 0) {
    // With a name, keywords only rank what it found; otherwise they search the pool.
    const candidates = name ? [...found.values()].map((h) => h.tool) : pool;
    for (const tool of candidates) {
      const tName = tool.name.toLowerCase();
      const title = tool.title.toLowerCase();
      const description = tool.description.toLowerCase();
      let score = 0;
      let all = true;
      for (const word of words) {
        const s = (tName.includes(word) ? 3 : 0) + (title.includes(word) ? 2 : 0) + (description.includes(word) ? 1 : 0);
        if (s) score += s;
        else all = false;
      }
      if (!score) continue;
      if (all) score += 10;
      add(tool, score);
    }
  }

  const ranked = [...found.values()].sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name));
  const results = ranked.slice(offset, offset + limit).map(({ tool, args, endpoint }) => {
    const m = mcpOf(tool);
    return {
      name: tool.name,
      title: tool.title,
      description: tool.description.length > MAX_DESCRIPTION ? `${tool.description.slice(0, MAX_DESCRIPTION)}…` : tool.description,
      ...(endpoint ? { endpoint } : {}),
      params: tool.params,
      writes: tool.writes,
      exposed: tool.expose,
      ...(m ? { mcp: m.name } : {}),
      run: howToRun(tool, args),
    };
  });
  return {
    results,
    total: ranked.length,
    ...(mcps ? { mcps } : {}),
    note: results.length
      ? "Run the tool as shown in run. Use http_request only if none of these fits."
      : name
        ? `No vault tool named "${text(input.name)}"${mcp ? ` in MCP "${mcp}"` : ""}.`
        : "No vault tool matched. You may use http_request.",
  };
}
