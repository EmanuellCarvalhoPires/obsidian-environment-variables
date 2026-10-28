// Runs vault tools and exposes them (plus the management tools) to the MCP server and the REST API.

import { ToolIndexEntry } from "../ecosystem/moduleConnector";
import { AuditLog } from "../audit/auditLog";
import { Broker, BrokerSuccess } from "../secrets/broker";
import { RequestInput } from "../secrets/prepare";
import { ClientContext } from "../server/clients";
import { buildApiIndexEntries, withoutPackageDbTools } from "./apiIndex";
import { inputSchema, validateArgs } from "./definition";
import { resolveServiceChoice, ToolRegistry } from "./registry";
import { parseRequestBlock, resolveRequest, servicePlaceholderNames } from "./requestNote";
import { ScriptRunner } from "./scriptRunner";
import { compileEndpoint, EndpointPattern, endpointOf, howToRun, matchEndpoint, mcpOf, normalizeMcpKey, RunHint, searchTools, summarizeMcps } from "./toolSearch";
import { McpDbManager } from "./mcpDb";
import { convertAdfFields } from "./adfText";
import { paginate } from "./pagination";
import { limitResponse, projectFields, takeMaxChars } from "./responseShape";
import { NoteSource, ToolEntry, ToolError, VaultNote } from "./types";
export { computeSyncHash } from "./syncHash";

export interface ToolsSettings {
  toolsEnabled: boolean;
  scriptsEnabled: boolean;
  toolTag: string;
  requestTag: string;
  scriptTimeoutSeconds: number;
  maxResponseMB: number;
}

export interface ToolsDeps {
  registry: ToolRegistry;
  source: NoteSource;
  broker: Broker;
  runner: ScriptRunner;
  audit: AuditLog;
  settings: () => ToolsSettings;
  /** The authoring guide for AI agents, in the user's language. */
  guide: (topic?: string) => string;
  dbManager?: McpDbManager;
}

export interface McpToolDefinition {
  name: string;
  title?: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, boolean>;
}

/** What an MCP tools/call returns: plain text (the guide) or a JSON value. */
export interface McpCallOutput {
  text?: string;
  value?: unknown;
  isError: boolean;
}

export const META_TOOLS: McpToolDefinition[] = [
  {
    name: "get_tool_authoring_guide",
    title: "Guide: how to create vault tools",
    description:
      "Read this before creating, changing or explaining vault tools (MCP tools defined by notes in the user's Obsidian vault, e.g. a set of tools for Google Drive or Jira). " +
      "Explains the note formats, the rules, and the mandatory workflow: ask the user for missing information, then write an implementation plan and wait for approval.",
    inputSchema: {
      type: "object",
      properties: {
        topic: {
          type: "string",
          description: "Topic slug to read a single section of the guide (e.g. 'security', 'note-formats'). Omit to get the index.",
        },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
];

const META_NAMES = new Set(META_TOOLS.map((t) => t.name));
const MAX_QUERY_RESULTS = 500;
const MAX_SCRIPT_HTTP_CALLS = 200;

/** What http_request adds to its result when a vault tool covers the endpoint it just called. */
export interface VaultToolHint {
  tool: string;
  endpoint?: string;
  run?: RunHint;
  message?: string;
}

export type HintResult = VaultToolHint | (Record<string, unknown> & { via_tool: string });

export class ToolsService {
  /** The endpoints of the request tools, rebuilt after any tool note changes. */
  private endpoints: Promise<EndpointPattern[]> | null = null;
  /** Tracks which tools have already been hinted to each client ID. */
  private clientSeenTools = new Map<string, Set<string>>();

  constructor(private readonly deps: ToolsDeps) {
    deps.registry.onChange(() => (this.endpoints = null));
  }

  enabled(): boolean {
    return this.deps.settings().toolsEnabled;
  }

  onChange(listener: () => void): () => void {
    return this.deps.registry.onChange(listener);
  }

  /** Applies tool note changes not yet read, so the AI never sees an outdated list. */
  async ready(): Promise<void> {
    if (this.enabled()) await this.deps.registry.ensureFresh();
  }

  /** Management tools plus every exposed, usable vault tool. Empty when the feature is off. */
  mcpTools(): McpToolDefinition[] {
    if (!this.enabled()) return [];
    const vault = this.deps.registry
      .list()
      .filter((e) => e.expose && e.status === "ready")
      .map((e) => this.definitionOf(e));
    return [...META_TOOLS, ...vault];
  }

  handles(name: string): boolean {
    if (!this.enabled()) return false;
    return META_NAMES.has(name) || this.deps.registry.list().some((e) => e.name === name && e.expose);
  }

  async callMcp(name: string, args: Record<string, unknown>, client: ClientContext): Promise<McpCallOutput> {
    return this.dispatch(name, args, client);
  }

  private async dispatch(name: string, args: Record<string, unknown>, client: ClientContext): Promise<McpCallOutput> {
    try {
      await this.ready();
      if (name === "get_tool_authoring_guide") {
        const topic = typeof args.topic === "string" ? args.topic.trim() : undefined;
        return { text: this.deps.guide(topic), isError: false };
      }
      if (name === "list_vault_tools") {
        return { value: this.status(args), isError: false };
      }
      if (name === "search_vault_tools") {
        return { value: searchTools(this.deps.registry.list(), await this.endpointIndex(), args), isError: false };
      }
      if (name === "run_vault_tool") {
        if (typeof args.name !== "string") throw new ToolError("invalid_argument", "name is required.");
        return { value: await this.run(args.name, args.arguments, client), isError: false };
      }
      return { value: await this.run(name, args, client), isError: false };
    } catch (err) {
      return { value: errorValue(err), isError: true };
    }
  }

  /** For list_vault_tools and GET /v1/tools. Never contains secret values. Filters: mcp, name, query, status. */
  status(filters: Record<string, unknown> = {}): Record<string, unknown> {
    let limit = 50;
    if (filters.limit !== undefined) {
      const rawLimit = typeof filters.limit === "string" && /^\d+$/.test(filters.limit.trim()) ? Number(filters.limit) : filters.limit;
      if (typeof rawLimit !== "number" || !Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > 200) {
        throw new ToolError("invalid_argument", 'Argument "limit" must be an integer between 1 and 200.');
      }
      limit = rawLimit;
    }

    let offset = 0;
    if (filters.offset !== undefined) {
      const rawOffset = typeof filters.offset === "string" && /^\d+$/.test(filters.offset.trim()) ? Number(filters.offset) : filters.offset;
      if (typeof rawOffset !== "number" || !Number.isInteger(rawOffset) || rawOffset < 0) {
        throw new ToolError("invalid_argument", 'Argument "offset" must be an integer greater than or equal to 0.');
      }
      offset = rawOffset;
    }
    const s = this.deps.settings();
    const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
    const mcp = str(filters.mcp);
    const name = str(filters.name).toLowerCase();
    const words = str(filters.query).toLowerCase().split(/\s+/).filter(Boolean);
    const status = str(filters.status);
    const filtered = !!(mcp || name || words.length || status);
    let entries = this.deps.registry.list();
    if (mcp) {
      const wanted = normalizeMcpKey(mcp);
      const exact = entries.filter((e) => mcpOf(e)?.keys.includes(wanted));
      entries = exact.length ? exact : entries.filter((e) => mcpOf(e)?.keys.some((k) => k.includes(wanted)));
    }
    if (name) entries = entries.filter((e) => e.name.toLowerCase() === name);
    if (words.length) entries = entries.filter((e) => words.every((w) => `${e.name} ${e.title} ${e.description}`.toLowerCase().includes(w)));
    if (status) entries = entries.filter((e) => e.status === status);
    const total = entries.length;
    const paged = entries.slice(offset, offset + limit);
    const nextOffset = offset + limit < total ? offset + limit : null;
    return {
      enabled: s.toolsEnabled,
      scriptsEnabled: s.scriptsEnabled,
      toolTag: s.toolTag,
      requestTag: s.requestTag,
      ...(filtered ? {} : { mcps: summarizeMcps(this.deps.registry.list()) }),
      total,
      next_offset: nextOffset,
      tools: paged.map((e) => ({
        name: e.name,
        title: e.title,
        kind: e.kind,
        status: e.status,
        description: e.description,
        params: e.params,
        writes: e.writes,
        expose: e.expose,
        mcp: mcpOf(e)?.name,
        note: e.notePath,
        request: e.request,
        service: e.service,
        serviceTag: e.serviceTag,
        serviceParam: e.serviceParam,
        instances: e.serviceChoices?.map((c) => ({ id: c.id, note: c.notePath })),
        problems: e.problems,
        warnings: e.warnings,
      })),
      requestNotes: s.requestTag && !filtered
        ? this.deps.source.byTag(s.requestTag).map((n) => ({ name: n.name, note: n.path, service: typeof n.frontmatter.service === "string" ? n.frontmatter.service : undefined }))
        : [],
    };
  }

  /** Runs a tool directly by name, used by POST /v1/tools/:name. */
  async runTool(name: string, rawArgs: unknown, client: ClientContext): Promise<unknown> {
    return this.run(name, rawArgs, client);
  }

  /** Runs a tool. Throws ToolError with a message the AI can act on. */
  async run(name: string, rawArgs: unknown, client: ClientContext): Promise<unknown> {
    if (!this.enabled()) throw new ToolError("tools_disabled", "Vault tools are turned off. The user can turn them on in Obsidian: Settings > Environment Keys > Vault tools.");
    const entry = this.deps.registry.get(name);
    if (!entry) throw new ToolError("unknown_tool", `There is no vault tool named "${name}". Call list_vault_tools to see the available tools.`);
    try {
      const result = await this.execute(entry, rawArgs, client);
      this.deps.audit.add({ client: client.name, action: "tool", tool: entry.name, target: entry.notePath, secrets: [], outcome: "ok" });
      return result;
    } catch (err) {
      const code = err instanceof ToolError ? err.code : "script_error";
      const outcome = code === "denied" ? "denied" : code === "request_failed" ? "blocked" : "error";
      const message = err instanceof Error ? err.message : String(err);
      this.deps.audit.add({ client: client.name, action: "tool", tool: entry.name, target: entry.notePath, secrets: [], outcome, detail: message });
      throw err;
    }
  }

  private async execute(entry: ToolEntry, rawArgs: unknown, client: ClientContext): Promise<unknown> {
    if (entry.status === "invalid") throw new ToolError("invalid_tool", `Tool "${entry.name}" in ${entry.notePath} has problems: ${entry.problems.join(" ")}`);
    if (entry.status === "scripts-disabled") throw new ToolError("scripts_disabled", "Script tools are turned off. The user can turn them on in Obsidian: Settings > Environment Keys > Vault tools.");
    let toolArgs = rawArgs;
    let maxChars: number | undefined;
    if (entry.kind === "request") ({ args: toolArgs, maxChars } = takeMaxChars(rawArgs));
    toolArgs = this.withResolvedInstance(entry, toolArgs);
    const checked = validateArgs(entry.params, toolArgs);
    if (!checked.ok) throw new ToolError("invalid_argument", checked.message);

    // Generic tools get the service note of the instance chosen in the call; others their fixed one.
    const service = this.serviceFor(entry, checked.args);

    if (entry.kind === "request") {
      let note: VaultNote;
      let body: string | undefined;
      const dbReq = this.deps.dbManager?.getRequestNote(entry.name);
      if (dbReq) {
        note = dbReq.note;
        body = dbReq.body;
      } else {
        note = this.resolveNote(entry.request!, entry.notePath, "Request note");
      }
      let res: ToolHttpResponse;
      if (checked.args.page_limit !== undefined) {
        const pageLimit = checked.args.page_limit as number;
        const maxBytes = this.deps.settings().maxResponseMB * 1024 * 1024;
        res = await paginate(
          async (cursor) => {
            const pageArgs = { ...checked.args };
            if (cursor.startAt !== undefined) {
              pageArgs.startAt = cursor.startAt;
            }
            if (cursor.nextPageToken !== undefined) {
              pageArgs.nextPageToken = cursor.nextPageToken;
            }
            return this.runRequestNote(note, pageArgs, service, entry.notePath, client, body);
          },
          pageLimit,
          { maxBytes },
        );
      } else {
        res = await this.runRequestNote(note, checked.args, service, entry.notePath, client, body);
      }

      if (checked.args.adf === "text" && res.json !== undefined) {
        res.json = convertAdfFields(res.json);
      }

      const responseFields =
        entry.responseFields ??
        (typeof this.deps.dbManager?.getResponseFieldsForTool === "function"
          ? this.deps.dbManager.getResponseFieldsForTool(entry.name)
          : undefined);
      if (responseFields && responseFields.length > 0 && res.json !== undefined) {
        res.json = projectFields(res.json, responseFields);
      }
      return compact(maxChars !== undefined ? limitResponse(res, maxChars) : res);
    }

    // kind: script. Permission to run it is asked by the AI client, like for any other MCP tool.
    const tool = entry;
    const s = this.deps.settings();
    const serviceNote = service ? this.deps.source.resolve(service, tool.notePath) : undefined;
    const extraRedact = serviceNote ? servicePlaceholderNames(serviceNote.frontmatter) : [];
    const executionState = { httpCalls: 0 };
    return this.deps.runner.run({
      code: tool.code!,
      args: checked.args,
      tool: tool.name,
      service: serviceNote ? summary(serviceNote) : null,
      timeoutMs: s.scriptTimeoutSeconds * 1000,
      maxOutputBytes: s.maxResponseMB * 1024 * 1024,
      bridge: (method, params) => this.bridge(method, params, tool, client, service, executionState),
      onLog: (line: string) => {
        const safeLine = typeof this.deps.broker.redact === "function" ? this.deps.broker.redact(line, extraRedact) : line;
        this.deps.audit.add({
          client: client.name,
          action: "tool",
          tool: tool.name,
          target: tool.notePath,
          secrets: [],
          outcome: "ok",
          detail: safeLine,
        });
        console.debug(safeLine);
      },
    });
  }

  /** Replaces the instance the AI typed ("CSP Tech") by the id of the note it means ("Jira Access - CSP Tech"). */
  private withResolvedInstance(entry: ToolEntry, rawArgs: unknown): unknown {
    const param = entry.serviceParam;
    if (!param || !entry.serviceChoices || typeof rawArgs !== "object" || rawArgs === null || Array.isArray(rawArgs)) return rawArgs;
    const typed = (rawArgs as Record<string, unknown>)[param];
    if (typeof typed !== "string") return rawArgs;
    const id = resolveServiceChoice(entry.serviceChoices, typed);
    return id === undefined ? rawArgs : { ...(rawArgs as Record<string, unknown>), [param]: id };
  }

  /** Path or link of the service note for this call: the chosen instance, the fixed service, or none. */
  private serviceFor(entry: ToolEntry, args: Record<string, unknown>): string | undefined {
    if (!entry.serviceParam) return entry.service;
    const id = args[entry.serviceParam];
    const choice = entry.serviceChoices?.find((c) => c.id === id);
    if (!choice) {
      const ids = (entry.serviceChoices ?? []).map((c) => c.id).join(", ");
      throw new ToolError("invalid_argument", `"${entry.serviceParam}" must be one of: ${ids}.`);
    }
    return choice.notePath;
  }

  /** The ctx API of scripts. Every request goes through the broker as the calling client. */
  private async bridge(method: string, params: unknown, tool: ToolEntry, client: ClientContext, defaultService?: string, executionState?: { httpCalls: number }): Promise<unknown> {
    const p = (params ?? {}) as Record<string, unknown>;
    switch (method) {
      case "notes.get": {
        if (typeof p.ref !== "string") throw new Error("ctx.notes.get(ref) needs a note name or [[link]].");
        const note = this.deps.source.resolve(p.ref, tool.notePath);
        if (!note) return null;
        return { ...summary(note), body: await this.deps.source.read(note) };
      }
      case "notes.query": {
        if (typeof p.tag !== "string" || !p.tag.trim()) throw new Error("ctx.notes.query({ tag }) needs a tag.");
        const name = typeof p.name === "string" ? p.name.toLowerCase() : "";
        const limit = typeof p.limit === "number" ? Math.min(Math.max(1, p.limit), MAX_QUERY_RESULTS) : MAX_QUERY_RESULTS;
        return this.deps.source
          .byTag(p.tag)
          .filter((n) => !name || n.name.toLowerCase().includes(name))
          .slice(0, limit)
          .map(summary);
      }
      case "requests.run": {
        if (typeof p.note !== "string") throw new Error("ctx.requests.run(note, params, options) needs the request note name or [[link]].");
        const args = p.params ?? {};
        if (typeof args !== "object" || Array.isArray(args)) throw new Error("ctx.requests.run: params must be an object.");
        const options = (p.options ?? {}) as { service?: unknown };
        const note = this.resolveNote(p.note, tool.notePath, "Request note");
        // Without options.service, a script uses the instance of the call (generic tools) or the tool's service.
        const service = typeof options.service === "string" ? options.service : defaultService;
        return this.runRequestNote(note, args as Record<string, unknown>, service, tool.notePath, client);
      }
      case "http": {
        if (executionState) {
          executionState.httpCalls++;
          if (executionState.httpCalls > MAX_SCRIPT_HTTP_CALLS) {
            throw new ToolError("limit_reached", `limit_reached: the script exceeded the limit of ${MAX_SCRIPT_HTTP_CALLS} ctx.http calls.`);
          }
        }
        const req = p as { method?: unknown; url?: unknown; headers?: unknown; body?: unknown };
        const headers = { ...((req.headers ?? {}) as Record<string, string>) };
        let body = req.body;
        if (body !== undefined && typeof body !== "string") {
          body = JSON.stringify(body);
          if (!Object.keys(headers).some((k) => k.toLowerCase() === "content-type")) headers["Content-Type"] = "application/json";
        }
        const input: RequestInput = { method: typeof req.method === "string" ? req.method : undefined, url: typeof req.url === "string" ? req.url : "", headers, body: body as string | undefined };
        return this.send(input, client, []);
      }
      default:
        throw new Error(`Unknown ctx method ${method}.`);
    }
  }

  private async runRequestNote(note: VaultNote, params: Record<string, unknown>, serviceOverride: string | undefined, fromPath: string, client: ClientContext, bodyOverride?: string) {
    const rawBody = bodyOverride !== undefined ? bodyOverride : await this.deps.source.read(note);
    const tpl = parseRequestBlock(rawBody, note.name);
    const serviceRef = serviceOverride ?? (typeof note.frontmatter.service === "string" ? note.frontmatter.service : undefined);
    // A service override from a tool is relative to the tool note; the request's own link to the request note.
    const service = serviceRef ? this.resolveNote(serviceRef, serviceOverride ? fromPath : note.path, "Service note") : undefined;
    const input = resolveRequest(tpl, { params, service, noteName: note.name });
    // Secrets of the service note are masked in the response even when this request does not send
    // them (e.g. reading an automation rule that stores an injected token).
    return this.send(input, client, service ? servicePlaceholderNames(service.frontmatter) : []);
  }

  private async send(input: RequestInput, client: ClientContext, alsoRedact: string[]) {
    const res = await this.deps.broker.execute(input, client, { fromVaultTool: true, alsoRedact });
    if (!res.ok) throw new ToolError("request_failed", `${res.error.code}: ${res.error.message}`);
    return responseOf(res);
  }

  /**
   * For http_request: the vault tool that covers this method + URL, if any, so the agent
   * uses it next time. Never fails the request.
   */
  async hintFor(method: string | undefined, url: string, client?: ClientContext): Promise<HintResult | undefined> {
    if (!this.enabled() || !url) return undefined;
    try {
      await this.ready();
      const matches = matchEndpoint(await this.endpointIndex(), method, url);
      if (matches.length === 0) return undefined;

      const isGet = (typeof method === "string" && method ? method : "GET").toUpperCase() === "GET";

      if (isGet && matches.length === 1 && client) {
        const match = matches[0];
        const tool = match.pattern.tool;
        const args: Record<string, unknown> = { ...match.args };

        try {
          const parsedUrl = new URL(url, "https://x.invalid");
          for (const [k, v] of parsedUrl.searchParams.entries()) {
            if (!(k in args)) args[k] = v;
          }
        } catch {
          // Ignore invalid URL
        }

        let canFillRequired = true;
        for (const [paramName, spec] of Object.entries(tool.params)) {
          if (spec.required) {
            if (args[paramName] === undefined || args[paramName] === "") {
              canFillRequired = false;
              break;
            }
          }
        }

        if (canFillRequired) {
          try {
            const runResult = await this.run(tool.name, args, client);
            const resObj =
              runResult && typeof runResult === "object" && !Array.isArray(runResult)
                ? (runResult as Record<string, unknown>)
                : { result: runResult };
            return {
              ...resObj,
              via_tool: tool.name,
            };
          } catch {
            // Fall back to returning the hint
          }
        }
      }

      const best = matches[0];
      const tool = best.pattern.tool;
      if (client?.id) {
        let seen = this.clientSeenTools.get(client.id);
        if (!seen) {
          seen = new Set<string>();
          this.clientSeenTools.set(client.id, seen);
        }
        if (seen.has(tool.name)) {
          return { tool: tool.name };
        }
        seen.add(tool.name);
      }
      return {
        tool: tool.name,
        endpoint: `${best.pattern.method} ${best.pattern.path}`,
        run: howToRun(tool, best.args),
        message: `The vault tool "${tool.name}" covers this endpoint. Next time use it instead of http_request.`,
      };
    } catch {
      return undefined;
    }
  }

  /**
   * The tools.db entries (kind "api") of every ready request tool: package tools (mcp.db) and tool notes.
   * Method and path come from the mcp.db row or from the request note. Empty when vault tools are off.
   */
  async apiIndexEntries(): Promise<ToolIndexEntry[]> {
    if (!this.enabled()) return [];
    await this.ready();
    return buildApiIndexEntries(withoutPackageDbTools(this.deps.registry.list()), async (entry) => {
      const row = this.deps.dbManager?.getRequestForTool(entry.name);
      if (row) return { method: row.method, path: row.path };
      if (!entry.request) return undefined;
      const note = this.deps.source.resolve(entry.request, entry.notePath);
      return note ? endpointOf(await this.deps.source.read(note), note.frontmatter) : undefined;
    });
  }

  private endpointIndex(): Promise<EndpointPattern[]> {
    this.endpoints ??= this.buildEndpointIndex();
    return this.endpoints;
  }

  private async buildEndpointIndex(): Promise<EndpointPattern[]> {
    const out: EndpointPattern[] = [];
    for (const entry of this.deps.registry.list()) {
      if (entry.kind !== "request" || entry.status !== "ready") continue;
      let endpoint: { method: string; path: string } | undefined;
      const row = this.deps.dbManager?.getRequestForTool(entry.name);
      if (row) {
        endpoint = { method: row.method, path: row.path };
      } else if (entry.request) {
        const note = this.deps.source.resolve(entry.request, entry.notePath);
        if (note) {
          endpoint = endpointOf(await this.deps.source.read(note), note.frontmatter);
        }
      }
      if (!endpoint) continue;
      const pattern = compileEndpoint(entry, endpoint.method, endpoint.path);
      if (pattern) out.push(pattern);
    }
    return out;
  }

  private resolveNote(ref: string, fromPath: string, what: string): VaultNote {
    const note = this.deps.source.resolve(ref, fromPath);
    if (!note) throw new ToolError("note_not_found", `${what} "${ref}" was not found in the vault.`);
    return note;
  }

  private definitionOf(e: ToolEntry): McpToolDefinition {
    return {
      name: e.name,
      title: e.title,
      description: e.description,
      inputSchema: inputSchema(e.params),
      annotations: { readOnlyHint: !e.writes, destructiveHint: e.writes, openWorldHint: true },
    };
  }
}

function summary(note: VaultNote) {
  return { name: note.name, path: note.path, frontmatter: note.frontmatter, tags: note.tags };
}

export interface ToolHttpResponse {
  status: number;
  statusText: string;
  ok: boolean;
  headers: Record<string, string>;
  json?: unknown;
  body?: string;
  /** An image body, in base64. */
  bodyBase64?: string;
  truncated: boolean;
}

function responseOf(res: BrokerSuccess): ToolHttpResponse {
  const contentType = res.headers["content-type"] ?? "";
  if (res.bodyEncoding === "base64") {
    return { status: res.status, statusText: res.statusText, ok: res.status >= 200 && res.status < 300, headers: res.headers, bodyBase64: res.body, truncated: res.truncated };
  }
  let json: unknown;
  if (/json/i.test(contentType) || /^\s*[[{]/.test(res.body)) {
    try {
      json = JSON.parse(res.body);
    } catch {
      json = undefined;
    }
  }
  const out: ToolHttpResponse = { status: res.status, statusText: res.statusText, ok: res.status >= 200 && res.status < 300, headers: res.headers, truncated: res.truncated };
  if (json !== undefined) out.json = json;
  else out.body = res.body;
  return out;
}

/** The result of a request tool, without the noise of every response header. */
function compact(res: ToolHttpResponse): Omit<ToolHttpResponse, "headers"> & { headers?: Record<string, string> } {
  const keep = ["content-type", "location", "link", "retry-after"];
  const headers = Object.fromEntries(Object.entries(res.headers).filter(([k]) => keep.includes(k) || k.startsWith("x-ratelimit")));
  return { ...res, headers };
}

function errorValue(err: unknown): { ok: false; error: { code: string; message: string } } {
  if (err instanceof ToolError) return { ok: false, error: { code: err.code, message: err.message } };
  return { ok: false, error: { code: "internal_error", message: err instanceof Error ? err.message : String(err) } };
}
