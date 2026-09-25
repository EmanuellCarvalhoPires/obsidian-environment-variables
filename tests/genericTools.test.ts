import * as http from "http";
import { AddressInfo } from "net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AuditLog } from "../src/audit/auditLog";
import { Broker } from "../src/engine/broker";
import { utf8ToBase64 } from "../src/engine/placeholders";
import { nodeTransport } from "../src/engine/transport";
import { ClientContext } from "../src/server/clients";
import { parseToolNote } from "../src/tools/definition";
import { serviceChoices, ToolRegistry } from "../src/tools/registry";
import { ScriptRunner } from "../src/tools/scriptRunner";
import { ToolsService, ToolsSettings } from "../src/tools/service";
import { secretInput, unlockedStore } from "./helpers";
import { fence, MemorySource } from "./toolHelpers";

const client: ClientContext = { id: "c", name: "test", access: { mode: "all" } };
const settings: ToolsSettings = { toolsEnabled: true, scriptsEnabled: true, toolTag: "mcp/tool", requestTag: "api/request", scriptTimeoutSeconds: 5, maxResponseMB: 1 };

describe("service choices", () => {
  const note = (name: string) => ({ path: `Services/${name}.md`, name, frontmatter: {}, tags: [] });

  it("drops the shared part of the note names", () => {
    const ids = serviceChoices([note("Jira - Globex"), note("Jira - Acme"), note("Jira - Assets")]).map((c) => c.id);
    expect(ids).toEqual(["Acme", "Assets", "Globex"]);
  });

  it("keeps the full name for a single note or when ids would clash", () => {
    expect(serviceChoices([note("Jira - Acme")]).map((c) => c.id)).toEqual(["Jira - Acme"]);
    expect(serviceChoices([note("Jira"), note("Jira ")]).map((c) => c.id)).toEqual(["Jira", "Jira "]);
  });

  it("validates the generic tool properties", () => {
    const parse = (fm: Record<string, unknown>) => parseToolNote({ path: "t.md", name: "t", frontmatter: fm, tags: [], body: "" });
    const base = { tool: "jira_get", kind: "request", request: "[[R]]", description: "d" };
    expect(parse({ ...base, service_tag: "service/jira", service_param: "instancia" }).problems).toEqual([]);
    expect(parse({ ...base, service_tag: "service/jira" }).serviceParam).toBe("instance");
    expect(parse({ ...base, service_tag: "x", service: "[[S]]" }).problems.join()).toMatch(/not both/);
    expect(parse({ ...base, service_tag: "x", service_param: "key", params: { key: "string" } }).problems.join()).toMatch(/also in "params"/);
    expect(parse({ ...base, service_param: "instancia" }).problems.join()).toMatch(/only work together/);
  });
});

describe("generic tools: one service note per instance", () => {
  let upstream: http.Server;
  let port = 0;
  const seen: Array<{ path: string; auth?: string }> = [];
  const source = new MemorySource();
  let registry: ToolRegistry;
  let tools: ToolsService;

  beforeAll(async () => {
    upstream = http.createServer((req, res) => {
      seen.push({ path: req.url ?? "", auth: req.headers.authorization });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ path: req.url }));
    });
    await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", () => r()));
    port = (upstream.address() as AddressInfo).port;

    const { store } = await unlockedStore();
    await store.add(secretInput({ name: "JIRA_A", username: "a@x.com", allowHttpLocalhost: true, allowedHosts: [`127.0.0.1:${port}`] }));
    await store.add(secretInput({ name: "JIRA_B", username: "b@x.com", value: "second-secret-token-value-123", allowHttpLocalhost: true, allowedHosts: [`127.0.0.1:${port}`] }));

    // The instance notes hold every value; the request and tool notes are generic.
    source.add("Services/Jira - Alpha.md", { tags: ["service/jira"], url: `http://127.0.0.1:${port}/alpha`, token_chave: "{{basic:JIRA_A}}" });
    source.add("Services/Jira - Beta.md", { tags: ["service/jira"], url: `http://127.0.0.1:${port}/beta`, token_chave: "{{basic:JIRA_B}}" });
    source.add("Services/Jira - Template.md", { tags: ["service/jira", "template"], url: "https://empresa.atlassian.net", token_chave: "" });
    source.add(
      "Req/Jira - Buscar ticket.md",
      { tags: ["api/request"] },
      [`${fence}http`, "GET {{service.url}}/rest/api/3/issue/{{param:chave}}", "Authorization: {{service.token_chave}}", fence].join("\n"),
    );
    source.add("Tools/jira_buscar_ticket.md", {
      tags: ["mcp/tool"],
      tool: "jira_buscar_ticket",
      kind: "request",
      request: "[[Jira - Buscar ticket]]",
      service_tag: "service/jira",
      service_param: "instancia",
      service_exclude_tag: "template",
      description: "Busca um ticket em qualquer instância.",
      params: { chave: { type: "string", required: true } },
    });
    source.add(
      "Tools/jira_resumo.md",
      {
        tags: ["mcp/tool"],
        tool: "jira_resumo",
        kind: "script",
        service_tag: "service/jira",
        service_param: "instancia",
        service_exclude_tag: "template",
        description: "Resumo.",
        params: { chave: { type: "string", required: true } },
      },
      [`${fence}js`, "export default async (ctx) => {", '  const r = await ctx.requests.run("Jira - Buscar ticket", { chave: ctx.args.chave });', "  return { url: ctx.service.frontmatter.url, path: r.json.path };", "}", fence].join("\n"),
    );

    const broker = new Broker(store, nodeTransport, async () => true, new AuditLog(), () => ({ timeoutMs: 5000, maxResponseBytes: 1_000_000, maxRedirects: 5 }));
    registry = new ToolRegistry(source, () => ({ enabled: true, toolTag: "mcp/tool", scriptsEnabled: true }));
    tools = new ToolsService({
      registry,
      source,
      broker,
      runner: new ScriptRunner(),
      audit: new AuditLog(),
      settings: () => settings,
      guide: () => "",
    });
    await registry.refresh();
  });

  afterAll(async () => {
    await new Promise<void>((r) => upstream.close(() => r()));
  });

  it("builds the instance parameter from the instance notes", () => {
    const tool = registry.get("jira_buscar_ticket")!;
    expect(tool.problems).toEqual([]);
    expect(tool.params.instancia).toMatchObject({ type: "string", required: true, enum: ["Alpha", "Beta"] });
    const mcp = tools.mcpTools().find((t) => t.name === "jira_buscar_ticket")!;
    expect(mcp.inputSchema).toMatchObject({ required: ["instancia", "chave"] });
  });

  it("fills the generic request with the values of the chosen instance", async () => {
    await tools.run("jira_buscar_ticket", { instancia: "Beta", chave: "B-1" }, client);
    expect(seen.at(-1)).toEqual({ path: "/beta/rest/api/3/issue/B-1", auth: "Basic " + utf8ToBase64("b@x.com:second-secret-token-value-123") });
    await tools.run("jira_buscar_ticket", { instancia: "Alpha", chave: "A-9" }, client);
    expect(seen.at(-1)!.path).toBe("/alpha/rest/api/3/issue/A-9");
    expect(seen.at(-1)!.auth).toBe("Basic " + utf8ToBase64(`a@x.com:${secretInput().value}`));
  });

  it("refuses an instance that is not a note (or a template)", async () => {
    await expect(tools.run("jira_buscar_ticket", { instancia: "Template", chave: "X" }, client)).rejects.toThrow(/must be one of: Alpha, Beta/);
    await expect(tools.run("jira_buscar_ticket", { chave: "X" }, client)).rejects.toThrow(/Missing required argument "instancia"/);
  });

  it("gives scripts the chosen instance as ctx.service and default service", async () => {
    const out = await tools.run("jira_resumo", { instancia: "Alpha", chave: "A-2" }, client);
    expect(out).toEqual({ url: `http://127.0.0.1:${port}/alpha`, path: "/alpha/rest/api/3/issue/A-2" });
  });

  it("picks up a new instance note without touching the tools", async () => {
    source.add("Services/Jira - Gamma.md", { tags: ["service/jira"], url: `http://127.0.0.1:${port}/gamma`, token_chave: "{{basic:JIRA_A}}" });
    await registry.refresh();
    expect(registry.get("jira_buscar_ticket")!.params.instancia.enum).toEqual(["Alpha", "Beta", "Gamma"]);
    expect(registry.get("jira_resumo")!.params.instancia.enum).toEqual(["Alpha", "Beta", "Gamma"]);
    expect(registry.get("jira_resumo")!.status).toBe("ready");
  });

  it("reports a generic tool without instance notes", async () => {
    source.add("Tools/orfa.md", { tags: ["mcp/tool"], tool: "orfa", kind: "request", request: "[[Jira - Buscar ticket]]", service_tag: "nada/aqui", description: "d" });
    await registry.refresh();
    expect(registry.get("orfa")!.problems.join()).toMatch(/No service notes found with the tag #nada\/aqui/);
  });
});

describe("per-variable approval and vault tools", () => {
  let upstream: http.Server;
  let port = 0;
  let asked = 0;
  let broker: Broker;
  let tools: ToolsService;

  beforeAll(async () => {
    upstream = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
    });
    await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", () => r()));
    port = (upstream.address() as AddressInfo).port;

    const { store } = await unlockedStore();
    // Asks on every request, even GET.
    await store.add(secretInput({ name: "ALWAYS", approval: "always", allowHttpLocalhost: true, allowedHosts: [`127.0.0.1:${port}`] }));
    // May go to any host: the dialog is where the user checks the address.
    await store.add(secretInput({ name: "ANY", approval: "never", allowAnyHost: true, allowHttpLocalhost: true, allowedHosts: [] }));

    const source = new MemorySource();
    source.add("S/Svc - Always.md", { tags: ["svc"], url: `http://127.0.0.1:${port}`, auth: "{{basic:ALWAYS}}" });
    source.add("S/Svc - Any.md", { tags: ["svc"], url: `http://127.0.0.1:${port}`, auth: "{{basic:ANY}}" });
    source.add("R/Get.md", { tags: ["api/request"] }, [`${fence}http`, "GET {{service.url}}/x", "Authorization: {{service.auth}}", fence].join("\n"));
    source.add("T/get.md", { tags: ["mcp/tool"], tool: "svc_get", kind: "request", request: "[[Get]]", service_tag: "svc", description: "d" });

    broker = new Broker(
      store,
      nodeTransport,
      async () => {
        asked++;
        return false;
      },
      new AuditLog(),
      () => ({ timeoutMs: 5000, maxResponseBytes: 1_000_000, maxRedirects: 5 }),
    );
    const registry = new ToolRegistry(source, () => ({ enabled: true, toolTag: "mcp/tool", scriptsEnabled: true }));
    tools = new ToolsService({ registry, source, broker, runner: new ScriptRunner(), audit: new AuditLog(), settings: () => settings, guide: () => "" });
    await registry.refresh();
  });

  afterAll(async () => {
    await new Promise<void>((r) => upstream.close(() => r()));
  });

  it("does not ask in Obsidian for requests made by a vault tool", async () => {
    asked = 0;
    await expect(tools.run("svc_get", { instance: "Always" }, client)).resolves.toMatchObject({ status: 200 });
    expect(asked).toBe(0);
  });

  it("still asks for http_request, which is not a vault tool", async () => {
    asked = 0;
    const res = await broker.execute({ url: `http://127.0.0.1:${port}/x`, headers: { Authorization: "{{basic:ALWAYS}}" } }, client);
    expect(asked).toBe(1);
    expect(res.ok).toBe(false);
  });

  it("does not ask for a variable that may go to any host when a tool uses it", async () => {
    // The agent guide makes the AI ask the user (showing the destination) before such a call.
    asked = 0;
    await expect(tools.run("svc_get", { instance: "Any" }, client)).resolves.toMatchObject({ status: 200 });
    expect(asked).toBe(0);
  });

  it("still asks for an any-host variable in http_request", async () => {
    asked = 0;
    await broker.execute({ url: `http://127.0.0.1:${port}/x`, headers: { Authorization: "{{basic:ANY}}" } }, client);
    expect(asked).toBe(1);
  });
});
