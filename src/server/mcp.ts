// Minimal JSON-RPC 2.0 MCP handler over Streamable HTTP (stateless POST /mcp).
// Exposes `list_secrets` and `http_request`, plus vault tools when enabled.

import { Broker } from "../secrets/broker";
import { parseFieldList, projectFields } from "../tools/responseShape";
import { ResponseWriter, saveResponse } from "../tools/savedResponses";
import { ToolsService } from "../tools/service";
import { ToolError } from "../tools/types";
import { ClientContext } from "./clients";

export const MCP_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

export const SERVER_INSTRUCTIONS =
  "Use list_secrets to see stored variable names and allowed hosts without seeing any values. " +
  "Use http_request with {{secret:NAME}}, {{basic:NAME}} or {{bearer:NAME}} in headers to call APIs.";

export const TOOLS_INSTRUCTIONS =
  " Use the tool discovery of your environment (tools_find) to find vault tools; they are not in your tool list. " +
  "Run it with tools_run {id, args} when the AI Ecosystem is available. Use http_request only when no vault tool fits. " +
  "Before creating, editing or explaining vault tools (MCP tools defined as Markdown notes in the Obsidian vault), call get_tool_authoring_guide and follow its workflow: ask the user for missing information, write an implementation plan, and wait for approval.";

export const PROMPTS = [
  {
    name: "configure_vault_tools",
    title: "Set up the MCP environment",
    description: "Sets up the plugin's MCP environment from scratch or completes one: AI client, environment variables, catalog packages or custom service/request/tool notes, MCP groups, validation and the rules in CLAUDE.md (with permission).",
    arguments: [
      { name: "request", description: "What you want to set up, e.g. 'Jira and Confluence from the catalog' or 'tools to list and read files in Google Drive'", required: false },
      { name: "topic", description: "Topic slug to read a single section of the guide (e.g. 'security', 'note-formats'). Omit to get the index.", required: false },
    ],
  },
];

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export const BUILT_IN_TOOLS = [
  {
    name: "list_secrets",
    title: "List environment variables",
    description:
      "Lists the environment variables stored in Obsidian (name, type, description, allowed hosts, placement rules, approval policy). " +
      "Never returns values. Use the returned names in http_request placeholders such as {{secret:NAME}}, {{basic:NAME}} or {{bearer:NAME}}.",
    inputSchema: {
      type: "object" as const,
      properties: {
        detail: {
          type: "boolean",
          description: "Include the full metadata (description, placement rules, approval policy).",
        },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "http_request",
    title: "HTTP request with environment variables",
    description:
      "Sends an HTTP/HTTPS request after replacing {{secret:NAME}}, {{basic:NAME}} and {{bearer:NAME}} placeholders inside Obsidian. " +
      "Placeholders are only sent to hosts listed in the variable's allowedHosts, and any secret values are masked in the response. " +
      "Use save_to: true for large responses.",
    inputSchema: {
      type: "object" as const,
      properties: {
        method: { type: "string", description: "HTTP method (GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS). Default: GET." },
        url: { type: "string", description: "Full https:// URL. Placeholders are not allowed in the host." },
        headers: {
          type: "boolean",
          description: "Include HTTP response headers in the result. Default: false.",
        },
        body: { type: "string", description: "Optional request body as a string (e.g. JSON.stringify(...))." },
        fields: {
          type: "string",
          description: "Comma-separated field paths to project from JSON response (e.g. 'key,fields.summary').",
        },
        max_chars: {
          type: "integer",
          description: "Maximum characters in response body (1 to 1000000). Truncates if exceeded.",
        },
        save_to: { type: "boolean", description: "Save the response body (masked) to a file in the vault and return its path, size and top-level keys instead of the body." },
      },
      required: ["url"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  },
];

export const LIST_VAULT_TOOLS_SCHEMA = {
  type: "object" as const,
  properties: {
    mcp: { type: "string", description: "Only the tools of this MCP package, e.g. \"Jira\", \"Jira Service Management\", \"Bitbucket\"." },
    name: { type: "string", description: "Only the tool with this exact name." },
    query: { type: "string", description: "Only tools whose name, title or description contain every word." },
    status: { type: "string", enum: ["ready", "scripts-disabled", "invalid"], description: "Only tools with this status." },
    limit: { type: "integer", description: "Maximum number of tools to return (1 to 200, default 50)." },
    offset: { type: "integer", description: "Number of tools to skip (>= 0, default 0)." },
  },
  additionalProperties: false,
};

export const LIST_VAULT_TOOLS_TOOL = {
  name: "list_vault_tools",
  title: "List vault tools and their status",
  description:
    "Lists the tool notes and package tools found in the vault with their status (ready, scripts-disabled, invalid), parameters and problems to fix, plus the saved request notes. Use it to check your work after creating or editing tool notes. " +
    "Without filters the output is very large: pass mcp, name, query or status to narrow it down. To find a tool for a task, use search_vault_tools.",
  inputSchema: LIST_VAULT_TOOLS_SCHEMA,
  annotations: { readOnlyHint: true, openWorldHint: false },
};

export interface McpContext {
  broker: Broker;
  client: ClientContext;
  version: string;
  tools?: ToolsService;
  /** Builds the prompt text for configure_vault_tools. */
  guide?: (request?: string, topic?: string) => string;
  /** This vault's MCP server name (`environment-variables-<vault>`). */
  serverName?: string;
  responseWriter?: ResponseWriter;
}

export function buildMcpInstructions(toolsEnabled: boolean): string {
  return toolsEnabled ? SERVER_INSTRUCTIONS + TOOLS_INSTRUCTIONS : SERVER_INSTRUCTIONS;
}

/**
 * Runs a vault tool (a package tool or a tool note) by name for the AI Ecosystem's tools_run.
 * run_vault_tool is no longer a listed MCP tool, so it cannot go through executeMcpToolCall.
 */
export async function executeVaultToolRun(
  name: string,
  args: Record<string, unknown>,
  ctx: Pick<McpContext, "client" | "tools">,
): Promise<{ content: Array<{ type: "text"; text: string }>; structuredContent?: Record<string, unknown>; isError: boolean }> {
  if (!ctx.tools?.enabled()) {
    return toolResult({ ok: false, error: { code: "tools_disabled", message: "Vault tools are turned off. The user can turn them on in Obsidian: Settings > Environment Keys > Vault tools." } }, true);
  }
  const out = await ctx.tools.callMcp("run_vault_tool", { name, arguments: args }, ctx.client);
  if (out.text !== undefined) return { content: [{ type: "text", text: out.text }], isError: out.isError };
  return toolResult(out.value, out.isError);
}

export async function executeMcpToolCall(
  name: string,
  args: Record<string, unknown>,
  ctx: Pick<McpContext, "broker" | "client" | "tools" | "responseWriter">,
): Promise<{ content: Array<{ type: "text"; text: string }>; structuredContent?: Record<string, unknown>; isError: boolean }> {
  await ctx.tools?.ready();
  if (name === "list_secrets") {
    if (args.detail !== undefined && typeof args.detail !== "boolean") {
      return toolResult({ ok: false, error: { code: "invalid_argument", message: 'Argument "detail" must be a boolean.' } }, true);
    }
    const out = ctx.broker.listSecrets(ctx.client, args.detail === true);
    return toolResult(out, !out.ok);
  }
  if (name === "http_request") {
    if ("path" in args || "filePath" in args || "save_path" in args) {
      return toolResult({ ok: false, error: { code: "invalid_argument", message: "Specifying a custom path is not allowed." } }, true);
    }
    if (args.save_to !== undefined && typeof args.save_to !== "boolean") {
      return toolResult({ ok: false, error: { code: "invalid_argument", message: 'Argument "save_to" must be a boolean.' } }, true);
    }
    let fieldsList: string[] | undefined;
    if (args.fields !== undefined) {
      try {
        fieldsList = parseFieldList(args.fields);
      } catch (err) {
        if (err instanceof ToolError) {
          return toolResult({ ok: false, error: { code: err.code, message: err.message } }, true);
        }
        throw err;
      }
    }
    if (args.max_chars !== undefined) {
      if (typeof args.max_chars !== "number" || !Number.isInteger(args.max_chars) || args.max_chars < 1 || args.max_chars > 1000000) {
        return toolResult({ ok: false, error: { code: "invalid_argument", message: 'Argument "max_chars" must be an integer between 1 and 1000000.' } }, true);
      }
    }
    if (args.headers !== undefined && typeof args.headers !== "boolean" && (typeof args.headers !== "object" || args.headers === null || Array.isArray(args.headers))) {
      return toolResult({ ok: false, error: { code: "invalid_argument", message: 'Argument "headers" must be a boolean.' } }, true);
    }
    const headers: Record<string, string> = {};
    if (args.headers && typeof args.headers === "object" && !Array.isArray(args.headers)) {
      for (const [k, v] of Object.entries(args.headers as Record<string, unknown>)) headers[k] = String(v);
    }
    const method = typeof args.method === "string" ? args.method : undefined;
    const url = typeof args.url === "string" ? args.url : "";
    const hint = await ctx.tools?.hintFor(method, url, ctx.client);
    if (hint && "via_tool" in hint) {
      return toolResult(hint, false);
    }
    const out = await ctx.broker.execute({ method, url, headers, body: typeof args.body === "string" ? args.body : undefined }, ctx.client);
    if (!out.ok) {
      return toolResult(hint ? { ...out, vault_tool_hint: hint } : out, true);
    }
    if (args.save_to === true) {
      if (!ctx.responseWriter) {
        return toolResult({ ok: false, error: { code: "internal_error", message: "Response writer is not available." } }, true);
      }
      const saved = await saveResponse(ctx.responseWriter, out.body, crypto.randomUUID());
      const res = {
        ok: true,
        status: out.status,
        headers: out.headers,
        saved_to: saved.saved_to,
        bytes: saved.bytes,
        top_keys: saved.top_keys,
        ...(hint ? { vault_tool_hint: hint } : {}),
      };
      return toolResult(res, false);
    }

    let isJson = false;
    let parsedJson: unknown = undefined;
    try {
      parsedJson = JSON.parse(out.body);
      isJson = parsedJson !== null && typeof parsedJson === "object";
    } catch {
      isJson = false;
    }

    let finalBodyObject: unknown = out.body;
    let bodyText = out.body;

    if (isJson) {
      if (fieldsList && fieldsList.length > 0) {
        finalBodyObject = projectFields(parsedJson, fieldsList);
      } else {
        finalBodyObject = parsedJson;
      }
      bodyText = JSON.stringify(finalBodyObject);
    }

    let body: unknown;
    let truncated = out.truncated;
    let totalChars: number | undefined = undefined;

    const maxChars = typeof args.max_chars === "number" ? args.max_chars : undefined;
    if (maxChars !== undefined && bodyText.length > maxChars) {
      body = bodyText.slice(0, maxChars);
      truncated = true;
      totalChars = bodyText.length;
    } else {
      body = isJson ? finalBodyObject : out.body;
    }

    const res: Record<string, unknown> = {
      ok: true,
      status: out.status,
      statusText: out.statusText,
      ...(args.headers === true ? { headers: out.headers } : {}),
      body,
      bodyEncoding: out.bodyEncoding,
      bodyBytes: out.bodyBytes,
      truncated,
      ...(totalChars !== undefined ? { total_chars: totalChars } : {}),
      finalUrl: out.finalUrl,
      redactions: out.redactions,
      ...(hint ? { vault_tool_hint: hint } : {}),
    };
    return toolResult(res, false);
  }
  if (name === "list_vault_tools" && ctx.tools?.enabled()) {
    const out = await ctx.tools.callMcp(name, args, ctx.client);
    return toolResult(out.value, out.isError);
  }
  if (ctx.tools?.handles(name)) {
    const out = await ctx.tools.callMcp(name, args, ctx.client);
    if (out.text !== undefined) return { content: [{ type: "text", text: out.text }], isError: out.isError };
    return toolResult(out.value, out.isError);
  }
  return toolResult({ ok: false, error: { code: "unknown_tool", message: `Unknown tool: ${name}` } }, true);
}

/** Returns a JSON-RPC response object, or null for notifications that take no reply. */
export async function handleMcpMessage(msg: unknown, ctx: McpContext): Promise<Record<string, unknown> | null> {
  if (!msg || typeof msg !== "object") {
    return rpcError(null, -32600, "Invalid Request");
  }
  const req = msg as JsonRpcRequest;
  if (req.jsonrpc !== "2.0" || typeof req.method !== "string") {
    return rpcError(req.id ?? null, -32600, "Invalid Request");
  }
  if (req.id === undefined) return null; // notification (e.g. notifications/initialized)

  try {
    switch (req.method) {
      case "initialize": {
        const asked = typeof req.params?.protocolVersion === "string" ? req.params.protocolVersion : "";
        const protocolVersion = MCP_PROTOCOL_VERSIONS.includes(asked) ? asked : MCP_PROTOCOL_VERSIONS[0];
        const toolsOn = Boolean(ctx.tools?.enabled());
        return rpcResult(req.id, {
          protocolVersion,
          capabilities: { tools: { listChanged: true }, ...(toolsOn ? { prompts: { listChanged: false } } : {}) },
          serverInfo: { name: ctx.serverName ?? "environment-variables", title: "Obsidian Environment Keys", version: ctx.version },
          instructions: buildMcpInstructions(toolsOn),
        });

      }
      case "ping":
        return rpcResult(req.id, {});
      case "tools/list":
        await ctx.tools?.ready();
        return rpcResult(req.id, { tools: [...BUILT_IN_TOOLS, ...(ctx.tools?.mcpTools() ?? [])] });
      case "prompts/list":
        return rpcResult(req.id, { prompts: ctx.tools?.enabled() && ctx.guide ? PROMPTS : [] });
      case "prompts/get":
        return getPrompt(req.id, req.params ?? {}, ctx);
      case "resources/list":
        return rpcResult(req.id, { resources: [] });
      case "resources/templates/list":
        return rpcResult(req.id, { resourceTemplates: [] });
      case "tools/call": {
        const name = typeof req.params?.name === "string" ? req.params.name : "";
        const args = (req.params?.arguments ?? {}) as Record<string, unknown>;
        const res = await executeMcpToolCall(name, args, ctx);
        return rpcResult(req.id, res);
      }
      default:
        return rpcError(req.id, -32601, `Method not found: ${req.method}`);
    }
  } catch (err) {
    return rpcError(req.id, -32603, err instanceof Error ? err.message : "Internal error");
  }
}

function getPrompt(id: string | number | null, params: Record<string, unknown>, ctx: McpContext): Record<string, unknown> {
  const name = typeof params.name === "string" ? params.name : "";
  const prompt = ctx.tools?.enabled() && ctx.guide ? PROMPTS.find((p) => p.name === name) : undefined;
  if (!prompt || !ctx.guide) return rpcError(id, -32602, `Unknown prompt: ${name}`);
  const args = (params.arguments ?? {}) as Record<string, unknown>;
  const request = typeof args.request === "string" ? args.request : undefined;
  const topic = typeof args.topic === "string" ? args.topic : undefined;
  try {
    const text = ctx.guide(request, topic);
    return rpcResult(id, {
      description: prompt.description,
      messages: [{ role: "user", content: { type: "text", text } }],
    });
  } catch (err) {
    return rpcError(id, -32602, err instanceof Error ? err.message : String(err));
  }
}

function toolResult(value: unknown, isError: boolean) {
  const structured = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : { result: value };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: structured,
    isError,
  };
}

function rpcResult(id: string | number | null, result: unknown): Record<string, unknown> {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id: string | number | null, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: "2.0", id, error: { code, message } };
}
