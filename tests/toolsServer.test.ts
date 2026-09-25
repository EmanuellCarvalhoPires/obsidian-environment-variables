import * as http from "http";
import { AddressInfo } from "net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AuditLog } from "../src/audit/auditLog";
import { Broker } from "../src/engine/broker";
import { utf8ToBase64 } from "../src/engine/placeholders";
import { nodeTransport } from "../src/engine/transport";
import { contextOf, createClient, findClient } from "../src/server/clients";
import { LocalServer } from "../src/server/localServer";
import { buildGuide, GuideMode } from "../src/tools/guide";
import { ToolRegistry } from "../src/tools/registry";
import { ScriptRunner } from "../src/tools/scriptRunner";
import { ToolsService, ToolsSettings } from "../src/tools/service";
import { secretInput, unlockedStore } from "./helpers";
import { fence, MemorySource } from "./toolHelpers";

const PORT = 27198;
const base = `http://127.0.0.1:${PORT}`;
let upstream: http.Server;
let upstreamPort = 0;
let lastAuth: string | undefined;
let lastPath = "";
let server: LocalServer;
let token = "";
let registry: ToolRegistry;
const source = new MemorySource();
const audit = new AuditLog();
const settings: ToolsSettings = { toolsEnabled: true, scriptsEnabled: true, toolTag: "mcp/tool", requestTag: "api/request", scriptTimeoutSeconds: 5, maxResponseMB: 1 };

beforeAll(async () => {
  upstream = http.createServer((req, res) => {
    lastAuth = req.headers.authorization;
    lastPath = req.url ?? "";
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ path: req.url, auth: req.headers.authorization ?? null }));
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", () => r()));
  upstreamPort = (upstream.address() as AddressInfo).port;

  const { store } = await unlockedStore();
  await store.add(secretInput({ allowHttpLocalhost: true, allowedHosts: [`127.0.0.1:${upstreamPort}`], approval: "never" }));

  source.add("Services/Svc.md", { url: `http://127.0.0.1:${upstreamPort}`, auth: "{{basic:JIRA_ACME}}" });
  source.add(
    "Requests/Get item.md",
    { tags: ["api/request"], service: "[[Svc]]" },
    [`${fence}http`, "GET {{service.url}}/items/{{param:id}}?fields={{param:fields}}", "Authorization: {{service.auth}}", fence].join("\n"),
  );
  source.add("Tools/get_item.md", {
    tags: ["mcp/tool"],
    tool: "get_item",
    kind: "request",
    request: "[[Get item]]",
    description: "Gets an item by id.",
    params: { id: { type: "string", required: true }, fields: { type: "string" } },
  });
  source.add("Tools/hidden.md", { tags: ["mcp/tool"], tool: "hidden_item", kind: "request", request: "[[Get item]]", description: "Hidden.", params: { id: "string" }, expose: false });
  source.add(
    "Tools/digest.md",
    { tags: ["mcp/tool"], tool: "item_digest", kind: "script", description: "Digest of an item.", params: { id: { type: "string", required: true } } },
    [`${fence}js`, "export default async function (ctx) {", '  const r = await ctx.requests.run("Get item", { id: ctx.args.id });', "  return { status: r.status, path: r.json.path, auth: r.json.auth };", "}", fence].join("\n"),
  );
  source.add("Tools/broken.md", { tags: ["mcp/tool"], tool: "broken", kind: "request" });

  const broker = new Broker(store, nodeTransport, async () => true, audit, () => ({ timeoutMs: 5000, maxResponseBytes: 1_000_000, maxRedirects: 5 }));
  registry = new ToolRegistry(source, () => ({ enabled: settings.toolsEnabled, toolTag: settings.toolTag, scriptsEnabled: settings.scriptsEnabled }));
  const guideText = (request?: string, mode?: GuideMode) => buildGuide("en", request, mode);
  const tools = new ToolsService({
    registry,
    source,
    broker,
    runner: new ScriptRunner(),
    audit,
    settings: () => settings,
    guide: (mode) => guideText(undefined, mode),
  });
  await registry.refresh();

  const full = await createClient("test", { mode: "all" });
  token = full.token;
  server = new LocalServer({
    port: PORT,
    broker,
    version: "test",
    tools,
    guide: guideText,
    authenticate: async (tk) => {
      const c = await findClient([full.record], tk);
      return c ? contextOf(c) : null;
    },
  });
  await server.start();
});

afterAll(async () => {
  await server.stop();
  await new Promise<void>((r) => upstream.close(() => r()));
});

const auth = () => ({ Authorization: `Bearer ${token}`, "Content-Type": "application/json" });
let rpcId = 0;
async function rpc(method: string, params?: unknown) {
  const res = await fetch(`${base}/mcp`, { method: "POST", headers: auth(), body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }) });
  return (await res.json()) as { result?: any; error?: { code: number; message: string } };
}
const call = (name: string, args: unknown) => rpc("tools/call", { name, arguments: args });

describe("vault tools over MCP", () => {
  it("announces tools, list changes and the guide prompt", async () => {
    const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } });
    expect(init.result.capabilities.tools.listChanged).toBe(true);
    expect(init.result.capabilities.prompts).toBeDefined();
    expect(init.result.instructions).toContain("get_tool_authoring_guide");
  });

  it("lists built-in, management and exposed vault tools", async () => {
    const names = (await rpc("tools/list")).result.tools.map((t: { name: string }) => t.name);
    expect(names).toEqual(["list_secrets", "http_request", "get_tool_authoring_guide", "list_vault_tools", "run_vault_tool", "item_digest", "get_item"]); // vault tools sorted by note path
    const getItem = (await rpc("tools/list")).result.tools.find((t: { name: string }) => t.name === "get_item");
    expect(getItem.inputSchema).toMatchObject({ required: ["id"], properties: { id: { type: "string" } } });
    expect(getItem.annotations.readOnlyHint).toBe(true);
  });

  it("runs a request tool with the real secret and masks it", async () => {
    const res = await call("get_item", { id: "a/b 1" });
    expect(res.result.isError).toBe(false);
    expect(lastPath).toBe("/items/a%2Fb%201"); // fields was not given: the query pair is gone
    expect(lastAuth).toBe("Basic " + utf8ToBase64(`bot@acme.com:${secretInput().value}`));
    const text = res.result.content[0].text as string;
    expect(text).not.toContain(secretInput().value);
    expect(text).toContain("***");
    expect(res.result.structuredContent.status).toBe(200);
  });

  it("refuses secret placeholders and unknown arguments", async () => {
    const res = await call("get_item", { id: "{{secret:JIRA_ACME}}" });
    expect(res.result.isError).toBe(true);
    expect(res.result.structuredContent.error.code).toBe("invalid_argument");
    const extra = await call("get_item", { id: "1", nope: true });
    expect(extra.result.structuredContent.error.message).toContain('Unknown argument "nope"');
  });

  it("runs a script tool without asking for approval in the plugin", async () => {
    // Permission is the AI client's job (e.g. Claude Code asks before calling an MCP tool).
    expect(registry.get("item_digest")!.status).toBe("ready");
    const ok = await call("item_digest", { id: "7" });
    expect(ok.result.isError).toBe(false);
    expect(ok.result.structuredContent).toMatchObject({ status: 200, path: "/items/7", auth: "Basic ***" });
  });

  it("runs hidden tools through run_vault_tool and reports problems", async () => {
    const res = await call("run_vault_tool", { name: "hidden_item", arguments: { id: "9" } });
    expect(res.result.isError).toBe(false);
    expect(lastPath).toBe("/items/9");
    const direct = await call("hidden_item", { id: "9" });
    expect(direct.result.structuredContent.error.code).toBe("unknown_tool");
    const status = (await call("list_vault_tools", {})).result.structuredContent;
    const broken = status.tools.find((t: { name: string }) => t.name === "broken");
    expect(broken.status).toBe("invalid");
    expect(broken.problems.join(" ")).toMatch(/description/);
    expect(status.requestNotes.map((n: { name: string }) => n.name)).toEqual(["Get item"]);
  });

  it("serves the guide as a tool, a prompt and over REST", async () => {
    const tool = await call("get_tool_authoring_guide", {});
    expect(tool.result.content[0].text).toContain("Implementation Plan");
    const prompts = await rpc("prompts/list");
    expect(prompts.result.prompts.map((p: { name: string }) => p.name)).toEqual(["configure_vault_tools", "add_vault_tool", "add_vault_tools"]);
    const prompt = await rpc("prompts/get", { name: "configure_vault_tools", arguments: { request: "Google Drive tools" } });
    expect(prompt.result.messages[0].content.text).toContain("Google Drive tools");
    expect(prompt.result.messages[0].content.text).toMatch(/^# Set up the MCP environment/);
    const single = await rpc("prompts/get", { name: "add_vault_tool", arguments: { request: "get an item" } });
    expect(single.result.messages[0].content.text).toMatch(/^# Add one tool/);
    const multiple = await call("get_tool_authoring_guide", { mode: "multiple" });
    expect(multiple.result.content[0].text).toMatch(/^# Add several tools/);
    const singleRest = await fetch(`${base}/v1/tools/guide?mode=single`, { headers: auth() });
    expect(await singleRest.text()).toMatch(/^# Add one tool/);
    const rest = await fetch(`${base}/v1/tools/guide`, { headers: auth() });
    expect(await rest.text()).toContain("ask the user before writing the plan");
  });

  it("runs tools over REST", async () => {
    const list = await (await fetch(`${base}/v1/tools`, { headers: auth() })).json();
    expect(list.tools.length).toBe(4);
    const run = await fetch(`${base}/v1/tools/get_item`, { method: "POST", headers: auth(), body: JSON.stringify({ id: "rest" }) });
    expect(run.status).toBe(200);
    expect((await run.json()).result.status).toBe(200);
  });

  it("pushes notifications/tools/list_changed on the GET stream", async () => {
    const received = await new Promise<string>((resolve, reject) => {
      const req = http.get(`${base}/mcp`, { headers: { Authorization: `Bearer ${token}`, Accept: "text/event-stream" } }, (res) => {
        expect(res.headers["content-type"]).toContain("text/event-stream");
        let data = "";
        res.on("data", (chunk: Buffer) => {
          data += chunk.toString("utf8");
          if (data.includes(": connected")) {
            source.add("Tools/new.md", { tags: ["mcp/tool"], tool: "new_tool", kind: "request", request: "[[Get item]]", description: "New.", params: { id: "string" } });
            void registry.refresh();
          }
          if (data.includes("list_changed")) {
            req.destroy();
            resolve(data);
          }
        });
      });
      req.on("error", (err) => (String(err).includes("socket hang up") ? undefined : reject(err)));
    });
    expect(received).toContain('"method":"notifications/tools/list_changed"');
    const names = (await rpc("tools/list")).result.tools.map((t: { name: string }) => t.name);
    expect(names).toContain("new_tool");
  });

  it("logs tool runs without values", () => {
    const entries = audit.list();
    expect(entries.some((e) => e.action === "tool" && e.tool === "get_item" && e.outcome === "ok")).toBe(true);
    expect(JSON.stringify(entries)).not.toContain(secretInput().value);
  });

  it("goes back to the two built-in tools when the feature is off", async () => {
    settings.toolsEnabled = false;
    await registry.refresh();
    const names = (await rpc("tools/list")).result.tools.map((t: { name: string }) => t.name);
    expect(names).toEqual(["list_secrets", "http_request"]);
    const res = await fetch(`${base}/mcp`, { headers: { Authorization: `Bearer ${token}`, Accept: "text/event-stream" } });
    expect(res.status).toBe(405);
    settings.toolsEnabled = true;
  });
});
