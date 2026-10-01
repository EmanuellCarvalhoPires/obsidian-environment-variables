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
  limit?: unknown;
}

export interface SearchResult {
  name: string;
  title: string;
  description: string;
  endpoint?: string;
  params: ToolEntry["params"];
  writes: boolean;
  exposed: boolean;
  run: RunHint;
}

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
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
  return tool.expose ? { call: tool.name, arguments: args } : { call: "run_vault_tool", arguments: { name: tool.name, arguments: args } };
}

/** Endpoint matches first, then keyword matches (name > title > description; all words count extra). */
export function searchTools(tools: ToolEntry[], index: EndpointPattern[], input: SearchInput): { results: SearchResult[]; note: string } {
  const words = typeof input.query === "string" ? input.query.toLowerCase().split(/\s+/).filter(Boolean) : [];
  const limit = Math.min(Math.max(1, typeof input.limit === "number" ? Math.floor(input.limit) : DEFAULT_LIMIT), MAX_LIMIT);
  const found = new Map<string, { tool: ToolEntry; score: number; args?: Record<string, string>; endpoint?: string }>();

  if (typeof input.url === "string" && input.url) {
    for (const { pattern, args } of matchEndpoint(index, input.method, input.url)) {
      if (!found.has(pattern.tool.name)) {
        found.set(pattern.tool.name, { tool: pattern.tool, score: 1000 + pattern.literal, args, endpoint: `${pattern.method} ${pattern.path}` });
      }
    }
  }
  if (words.length > 0) {
    for (const tool of tools) {
      if (tool.status !== "ready") continue;
      const name = tool.name.toLowerCase();
      const title = tool.title.toLowerCase();
      const description = tool.description.toLowerCase();
      let score = 0;
      let all = true;
      for (const word of words) {
        const s = (name.includes(word) ? 3 : 0) + (title.includes(word) ? 2 : 0) + (description.includes(word) ? 1 : 0);
        if (s) score += s;
        else all = false;
      }
      if (!score) continue;
      if (all) score += 10;
      const hit = found.get(tool.name);
      if (hit) hit.score += score;
      else found.set(tool.name, { tool, score });
    }
  }

  const results = [...found.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ tool, args, endpoint }) => ({
      name: tool.name,
      title: tool.title,
      description: tool.description.length > MAX_DESCRIPTION ? `${tool.description.slice(0, MAX_DESCRIPTION)}…` : tool.description,
      ...(endpoint ? { endpoint } : {}),
      params: tool.params,
      writes: tool.writes,
      exposed: tool.expose,
      run: howToRun(tool, args),
    }));
  return {
    results,
    note: results.length ? "Run the tool as shown in run. Use http_request only if none of these fits." : "No vault tool matched. You may use http_request.",
  };
}
