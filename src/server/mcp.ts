// Minimal JSON-RPC 2.0 MCP handler over Streamable HTTP (stateless POST /mcp).
// Exposes `list_secrets` and `http_request`, plus vault tools when enabled.

import { Broker } from "../secrets/broker";
import { ToolsService } from "../tools/service";
import { ClientContext } from "./clients";

export const MCP_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

export const SERVER_INSTRUCTIONS =
  "Use list_secrets to see stored variable names and allowed hosts without seeing any values. " +
  "Use http_request with {{secret:NAME}}, {{basic:NAME}} or {{bearer:NAME}} in headers to call APIs.";

export const TOOLS_INSTRUCTIONS =
  " Most vault tools (MCP packages such as Jira, Jira Service Management, Confluence and Bitbucket) are not in your tool list. To find one, call search_vault_tools with mcp (package), name (exact tool name), query (keywords) and/or the method and URL of the endpoint; call it without arguments to see the available MCPs. Run the tool as shown in its `run` field (directly if exposed, or via run_vault_tool). Use http_request only when no vault tool fits. " +
  "Before creating, editing or explaining vault tools (MCP tools defined as Markdown notes in the Obsidian vault), call get_tool_authoring_guide and follow its workflow: ask the user for missing information, write an implementation plan, and wait for approval.";

export const PROMPTS = [
  {
    name: "configure_vault_tools",
    title: "Set up the MCP environment",
    description: "Sets up the plugin's MCP environment from scratch or completes one: AI client, environment variables, catalog packages or custom service/request/tool notes, MCP groups, validation and the rules in CLAUDE.md (with permission).",
    arguments: [{ name: "request", description: "What you want to set up, e.g. 'Jira and Confluence from the catalog' or 'tools to list and read files in Google Drive'", required: false }],
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
    inputSchema: { type: "object" as const, properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "http_request",
    title: "HTTP request with environment variables",
    description:
      "Sends an HTTP/HTTPS request after replacing {{secret:NAME}}, {{basic:NAME}} and {{bearer:NAME}} placeholders inside Obsidian. " +
      "If Vault tools are enabled, call search_vault_tools with the method and URL first and prefer the vault tool it returns. " +
      "Placeholders are only sent to hosts listed in the variable's allowedHosts, and any secret values are masked in the response.",
    inputSchema: {
      type: "object" as const,
      properties: {
        method: { type: "string", description: "HTTP method (GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS). Default: GET." },
        url: { type: "string", description: "Full https:// URL. Placeholders are not allowed in the host." },
        headers: {
          type: "object",
          additionalProperties: { type: "string" },
          description: 'Request headers, e.g. { "Authorization": "{{basic:JIRA_ACME}}", "Accept": "application/json" }.',
        },
        body: { type: "string", description: "Optional request body as a string (e.g. JSON.stringify(...))." },
      },
      required: ["url"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  },
];

export interface McpContext {
  broker: Broker;
  client: ClientContext;
  version: string;
  tools?: ToolsService;
  /** Builds the prompt text for configure_vault_tools. */
  guide?: (request?: string) => string;
  /** This vault's MCP server name (`environment-variables-<vault>`). */
  serverName?: string;
}

export function buildMcpInstructions(toolsEnabled: boolean): string {
  return toolsEnabled ? SERVER_INSTRUCTIONS + TOOLS_INSTRUCTIONS : SERVER_INSTRUCTIONS;
}

export async function executeMcpToolCall(
  name: string,
  args: Record<string, unknown>,
  ctx: Pick<McpContext, "broker" | "client" | "tools">,
): Promise<{ content: Array<{ type: "text"; text: string }>; structuredContent?: Record<string, unknown>; isError: boolean }> {
  await ctx.tools?.ready();
  if (name === "list_secrets") {
    const out = ctx.broker.listSecrets(ctx.client);
    return toolResult(out, !out.ok);
  }
  if (name === "http_request") {
    const headers: Record<string, string> = {};
    if (args.headers && typeof args.headers === "object" && !Array.isArray(args.headers)) {
      for (const [k, v] of Object.entries(args.headers as Record<string, unknown>)) headers[k] = String(v);
    }
    const method = typeof args.method === "string" ? args.method : undefined;
    const url = typeof args.url === "string" ? args.url : "";
    const [out, hint] = await Promise.all([
      ctx.broker.execute({ method, url, headers, body: typeof args.body === "string" ? args.body : undefined }, ctx.client),
      ctx.tools?.hintFor(method, url),
    ]);
    return toolResult(hint ? { ...out, vault_tool_hint: hint } : out, !out.ok);
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
  const text = ctx.guide(request);
  return rpcResult(id, {
    description: prompt.description,
    messages: [{ role: "user", content: { type: "text", text } }],
  });
}

function toolResult(value: unknown, isError: boolean) {
  const structured = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : { result: value };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
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
