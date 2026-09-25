// Runs vault tools and exposes them (plus the management tools) to the MCP server and the REST API.

import { AuditLog } from "../audit/auditLog";
import { Broker, BrokerSuccess } from "../engine/broker";
import { RequestInput } from "../engine/prepare";
import { ClientContext } from "../server/clients";
import { inputSchema, validateArgs } from "./definition";
import { GUIDE_MODES, GuideMode, isGuideMode } from "./guide";
import { ToolRegistry } from "./registry";
import { parseRequestBlock, resolveRequest } from "./requestNote";
import { ScriptRunner } from "./scriptRunner";
import { NoteSource, ToolEntry, ToolError, VaultNote } from "./types";

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
  /** The authoring guide for AI agents, in the user's language, for the chosen prompt. */
  guide: (mode?: GuideMode) => string;
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
      "Explains the note formats, the rules, and the mandatory workflow: ask the user for missing information, then write an implementation plan and wait for approval. " +
      "mode: setup (set up the MCP environment for an app: service notes, secrets and tools; the default), single (add one tool) or multiple (add several tools).",
    inputSchema: {
      type: "object",
      properties: { mode: { type: "string", enum: GUIDE_MODES, default: "setup" } },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "list_vault_tools",
    title: "List vault tools and their status",
    description:
      "Lists every tool note found in the vault with its status (ready, scripts-disabled, invalid), parameters and problems to fix, plus the saved request notes. Use it to check your work after creating or editing tool notes.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "run_vault_tool",
    title: "Run a vault tool by name",
    description:
      "Runs a vault tool by name, including tools with expose: false and tools created after your tool list was loaded. Ask the user before running a tool that writes data.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Tool name, as in list_vault_tools." },
        arguments: { type: "object", description: "Arguments for the tool." },
      },
      required: ["name"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  },
];

const META_NAMES = new Set(META_TOOLS.map((t) => t.name));
const MAX_QUERY_RESULTS = 500;

export class ToolsService {
  constructor(private readonly deps: ToolsDeps) {}

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
    try {
      await this.ready();
      if (name === "get_tool_authoring_guide") return { text: this.deps.guide(isGuideMode(args.mode) ? args.mode : undefined), isError: false };
      if (name === "list_vault_tools") return { value: this.status(), isError: false };
      if (name === "run_vault_tool") {
        if (typeof args.name !== "string") throw new ToolError("invalid_argument", "name is required.");
        return { value: await this.run(args.name, args.arguments, client), isError: false };
      }
      return { value: await this.run(name, args, client), isError: false };
    } catch (err) {
      return { value: errorValue(err), isError: true };
    }
  }

  /** For list_vault_tools and GET /v1/tools. Never contains secret values. */
  status(): Record<string, unknown> {
    const s = this.deps.settings();
    return {
      enabled: s.toolsEnabled,
      scriptsEnabled: s.scriptsEnabled,
      toolTag: s.toolTag,
      requestTag: s.requestTag,
      tools: this.deps.registry.list().map((e) => ({
        name: e.name,
        title: e.title,
        kind: e.kind,
        status: e.status,
        description: e.description,
        params: e.params,
        writes: e.writes,
        expose: e.expose,
        note: e.notePath,
        request: e.request,
        service: e.service,
        serviceTag: e.serviceTag,
        serviceParam: e.serviceParam,
        instances: e.serviceChoices?.map((c) => ({ id: c.id, note: c.notePath })),
        problems: e.problems,
        warnings: e.warnings,
      })),
      requestNotes: s.requestTag
        ? this.deps.source.byTag(s.requestTag).map((n) => ({ name: n.name, note: n.path, service: typeof n.frontmatter.service === "string" ? n.frontmatter.service : undefined }))
        : [],
    };
  }

  /** Runs a tool. Throws ToolError with a message the AI can act on. */
  async run(name: string, rawArgs: unknown, client: ClientContext): Promise<unknown> {
    if (!this.enabled()) throw new ToolError("tools_disabled", "Vault tools are turned off. The user can turn them on in Obsidian: Settings > Environment Variables > Vault tools.");
    const entry = this.deps.registry.get(name);
    if (!entry) throw new ToolError("unknown_tool", `There is no vault tool named "${name}". Call list_vault_tools to see the available tools.`);
    try {
      const result = await this.execute(entry, rawArgs, client);
      this.deps.audit.add({ client: client.name, action: "tool", tool: entry.name, target: entry.notePath, secrets: [], outcome: "ok" });
      return result;
    } catch (err) {
      const code = err instanceof ToolError ? err.code : "script_error";
      this.deps.audit.add({
        client: client.name,
        action: "tool",
        tool: entry.name,
        target: entry.notePath,
        secrets: [],
        outcome: code === "denied" ? "denied" : code === "request_failed" ? "blocked" : "error",
        detail: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  private async execute(entry: ToolEntry, rawArgs: unknown, client: ClientContext): Promise<unknown> {
    if (entry.status === "invalid") throw new ToolError("invalid_tool", `Tool "${entry.name}" in ${entry.notePath} has problems: ${entry.problems.join(" ")}`);
    if (entry.status === "scripts-disabled") throw new ToolError("scripts_disabled", "Script tools are turned off. The user can turn them on in Obsidian: Settings > Environment Variables > Vault tools.");
    const checked = validateArgs(entry.params, rawArgs);
    if (!checked.ok) throw new ToolError("invalid_argument", checked.message);

    // Generic tools get the service note of the instance chosen in the call; others their fixed one.
    const service = this.serviceFor(entry, checked.args);

    if (entry.kind === "request") {
      const note = this.resolveNote(entry.request!, entry.notePath, "Request note");
      const res = await this.runRequestNote(note, checked.args, service, entry.notePath, client);
      return compact(res);
    }

    // kind: script. Permission to run it is asked by the AI client, like for any other MCP tool.
    const tool = entry;
    const s = this.deps.settings();
    const serviceNote = service ? this.deps.source.resolve(service, tool.notePath) : undefined;
    return this.deps.runner.run({
      code: tool.code!,
      args: checked.args,
      tool: tool.name,
      service: serviceNote ? summary(serviceNote) : null,
      timeoutMs: s.scriptTimeoutSeconds * 1000,
      maxOutputBytes: s.maxResponseMB * 1024 * 1024,
      bridge: (method, params) => this.bridge(method, params, tool, client, service),
    });
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
  private async bridge(method: string, params: unknown, tool: ToolEntry, client: ClientContext, defaultService?: string): Promise<unknown> {
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
        const req = p as { method?: unknown; url?: unknown; headers?: unknown; body?: unknown };
        const headers = { ...((req.headers ?? {}) as Record<string, string>) };
        let body = req.body;
        if (body !== undefined && typeof body !== "string") {
          body = JSON.stringify(body);
          if (!Object.keys(headers).some((k) => k.toLowerCase() === "content-type")) headers["Content-Type"] = "application/json";
        }
        const input: RequestInput = { method: typeof req.method === "string" ? req.method : undefined, url: typeof req.url === "string" ? req.url : "", headers, body: body as string | undefined };
        return this.send(input, client);
      }
      default:
        throw new Error(`Unknown ctx method ${method}.`);
    }
  }

  private async runRequestNote(note: VaultNote, params: Record<string, unknown>, serviceOverride: string | undefined, fromPath: string, client: ClientContext) {
    const tpl = parseRequestBlock(await this.deps.source.read(note), note.name);
    const serviceRef = serviceOverride ?? (typeof note.frontmatter.service === "string" ? note.frontmatter.service : undefined);
    // A service override from a tool is relative to the tool note; the request's own link to the request note.
    const service = serviceRef ? this.resolveNote(serviceRef, serviceOverride ? fromPath : note.path, "Service note") : undefined;
    const input = resolveRequest(tpl, { params, service, noteName: note.name });
    return this.send(input, client);
  }

  private async send(input: RequestInput, client: ClientContext) {
    const res = await this.deps.broker.execute(input, client, { fromVaultTool: true });
    if (!res.ok) throw new ToolError("request_failed", `${res.error.code}: ${res.error.message}`);
    return responseOf(res);
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
  truncated: boolean;
}

function responseOf(res: BrokerSuccess): ToolHttpResponse {
  const contentType = res.headers["content-type"] ?? "";
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
