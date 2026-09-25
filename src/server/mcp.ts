// Minimal MCP server (JSON-RPC 2.0 over Streamable HTTP, JSON responses; the optional GET stream
// in localServer.ts only carries notifications/tools/list_changed).
// Implemented by hand: two built-in tools, plus the vault tools when that feature is on.

import { Broker } from "../engine/broker";
import type { ToolsService } from "../tools/service";
import { ClientContext } from "./clients";

export const SUPPORTED_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
export const SERVER_NAME = "environment-variables";

export const SERVER_INSTRUCTIONS = [
  "This server lets you call HTTP APIs with secrets you are not allowed to see.",
  "Notes in the user's vault reference secrets by key, e.g. {{secret:NAME}}, {{basic:NAME}} or {{bearer:NAME}}.",
  "Never ask the user for the real value. Put the placeholder in a header (usually Authorization) and call http_request;",
  "the plugin replaces it with the real value, checks that the destination host is allowed, and masks the value in the response.",
  "Call list_secrets to see the available keys and the hosts each one may be sent to.",
  "If the vault is locked, ask the user to unlock it in Obsidian (Environment Variables panel). Do not try other ways to obtain the secret.",
].join(" ");

const TOOLS_INSTRUCTIONS = [
  "Vault tools are on: other tools of this server are defined by notes in the user's vault.",
  "Before creating or changing vault tools (e.g. a set of tools for a new app or API), call get_tool_authoring_guide and follow it:",
  "ask the user for missing information, write an implementation plan and wait for approval before editing notes.",
  "Use list_vault_tools to check tool notes and run_vault_tool to run a tool that is not in your list.",
].join(" ");

export const CONFIGURE_PROMPT = "configure_vault_tools";

const TOOLS = [
  {
    name: "list_secrets",
    title: "List secret keys",
    description:
      "List the keys stored in the user's Environment Variables vault: name, type, description, allowed hosts and where each key may be placed. Never returns values.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "http_request",
    title: "HTTP request with secret placeholders",
    description:
      "Send an HTTP request. Placeholders {{secret:NAME}}, {{secret:NAME.user}}, {{basic:NAME}} (Basic auth from username + token) and {{bearer:NAME}} are replaced with real values right before sending. " +
      "By default placeholders are only accepted in header values, and only for the hosts allowed for that key (a key marked allowAnyHost works with any https host, but the user must approve every request). " +
      "Example header: {\"Authorization\": \"{{basic:JIRA_ACME}}\"}. Values found in the response are masked as ***.",
    inputSchema: {
      type: "object",
      properties: {
        method: { type: "string", enum: ["GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE"], default: "GET" },
        url: { type: "string", description: "Absolute https URL." },
        headers: { type: "object", additionalProperties: { type: "string" } },
        body: { type: "string", description: "Raw request body. Serialize JSON yourself and set Content-Type." },
      },
      required: ["url"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  },
];

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export type JsonRpcResponse =
  | { jsonrpc: "2.0"; id: string | number | null; result: unknown }
  | { jsonrpc: "2.0"; id: string | number | null; error: { code: number; message: string } };

export interface McpContext {
  broker: Broker;
  client: ClientContext;
  version: string;
  tools?: ToolsService;
  /** The authoring guide with the user's request appended, for prompts/get. */
  guide?: (request?: string) => string;
}

export async function handleMcpMessage(message: unknown, ctx: McpContext): Promise<JsonRpcResponse | null> {
  if (!isRequest(message)) {
    return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } };
  }
  const isNotification = message.id === undefined;
  if (isNotification) return null;
  const id = message.id ?? null;

  switch (message.method) {
    case "initialize": {
      const asked = message.params?.protocolVersion;
      const requested = typeof asked === "string" ? asked : "";
      const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : SUPPORTED_PROTOCOL_VERSIONS[0];
      const toolsOn = ctx.tools?.enabled() ?? false;
      const capabilities: Record<string, unknown> = { tools: { listChanged: toolsOn } };
      if (toolsOn && ctx.guide) capabilities.prompts = { listChanged: false };
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion,
          capabilities,
          serverInfo: { name: SERVER_NAME, title: "Environment Variables (Obsidian)", version: ctx.version },
          instructions: toolsOn ? `${SERVER_INSTRUCTIONS} ${TOOLS_INSTRUCTIONS}` : SERVER_INSTRUCTIONS,
        },
      };
    }
    case "ping":
      return { jsonrpc: "2.0", id, result: {} };
    case "tools/list":
      return { jsonrpc: "2.0", id, result: { tools: [...TOOLS, ...(ctx.tools?.mcpTools() ?? [])] } };
    case "tools/call":
      return { jsonrpc: "2.0", id, result: await callTool(message.params ?? {}, ctx) };
    case "prompts/list":
      return { jsonrpc: "2.0", id, result: { prompts: promptsOf(ctx) } };
    case "prompts/get": {
      const name = message.params?.name;
      if (name !== CONFIGURE_PROMPT || promptsOf(ctx).length === 0 || !ctx.guide) {
        return { jsonrpc: "2.0", id, error: { code: -32602, message: `Unknown prompt: ${String(name)}` } };
      }
      const args = (message.params?.arguments ?? {}) as Record<string, unknown>;
      const request = typeof args.request === "string" ? args.request : undefined;
      return {
        jsonrpc: "2.0",
        id,
        result: {
          description: "Create or change vault tools following the plugin's guide.",
          messages: [{ role: "user", content: { type: "text", text: ctx.guide(request) } }],
        },
      };
    }
    default:
      return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${message.method}` } };
  }
}

function promptsOf(ctx: McpContext) {
  if (!ctx.tools?.enabled() || !ctx.guide) return [];
  return [
    {
      name: CONFIGURE_PROMPT,
      title: "Configure vault tools",
      description: "Create or change MCP tools defined by notes in the vault (e.g. a set of tools for an app). Loads the plugin's guide for AI agents.",
      arguments: [{ name: "request", description: "What you want, e.g. \"tools to list and search files in Google Drive\".", required: false }],
    },
  ];
}

async function callTool(params: Record<string, unknown>, ctx: McpContext) {
  const name = params.name;
  const args = (params.arguments ?? {}) as Record<string, unknown>;
  if (name === "list_secrets") {
    const res = ctx.broker.listSecrets(ctx.client);
    return toolResult(res, !res.ok);
  }
  if (name === "http_request") {
    const res = await ctx.broker.execute(
      {
        method: typeof args.method === "string" ? args.method : undefined,
        url: typeof args.url === "string" ? args.url : "",
        headers: args.headers as Record<string, string> | undefined,
        body: args.body as string | undefined,
      },
      ctx.client,
    );
    return toolResult(res, !res.ok);
  }
  if (typeof name === "string" && ctx.tools?.handles(name)) {
    const out = await ctx.tools.callMcp(name, args, ctx.client);
    if (out.text !== undefined) return { content: [{ type: "text", text: out.text }], isError: out.isError };
    return toolResult(out.value, out.isError);
  }
  return toolResult({ ok: false, error: { code: "unknown_tool", message: `Unknown tool ${String(name)}` } }, true);
}

function toolResult(value: unknown, isError: boolean) {
  // structuredContent must be an object; arrays and scalars only go in the text.
  const structured = typeof value === "object" && value !== null && !Array.isArray(value) ? { structuredContent: value } : {};
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], ...structured, isError };
}

function isRequest(m: unknown): m is JsonRpcRequest {
  return typeof m === "object" && m !== null && (m as JsonRpcRequest).jsonrpc === "2.0" && typeof (m as JsonRpcRequest).method === "string";
}
