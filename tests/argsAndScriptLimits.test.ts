import { describe, expect, it } from "vitest";
import { AuditLog } from "../src/audit/auditLog";
import { Broker } from "../src/secrets/broker";
import { Transport, TransportRequest } from "../src/secrets/transport";
import { ClientContext } from "../src/server/clients";
import { validateArgs } from "../src/tools/definition";
import { ToolRegistry } from "../src/tools/registry";
import { ScriptRunner } from "../src/tools/scriptRunner";
import { ToolsService, ToolsSettings } from "../src/tools/service";
import { secretInput, unlockedStore } from "./helpers";
import { fence, MemorySource } from "./toolHelpers";

const client: ClientContext = { id: "c1", name: "test-client", access: { mode: "all" } };
const defaultSettings: ToolsSettings = {
  toolsEnabled: true,
  scriptsEnabled: true,
  toolTag: "mcp/tool",
  requestTag: "api/request",
  scriptTimeoutSeconds: 5,
  maxResponseMB: 1,
};

function fakeTransport(body = "{}"): { transport: Transport; sent: TransportRequest[] } {
  const sent: TransportRequest[] = [];
  const transport: Transport = async (req) => {
    sent.push(req);
    return {
      status: 200,
      statusText: "OK",
      headers: {},
      body,
      bodyEncoding: "text",
      bodyBytes: body.length,
      truncated: false,
      finalUrl: req.url.toString(),
      redirects: 0,
    };
  };
  return { transport, sent };
}

describe("Item 15: Argument validation and type coercion in validateArgs", () => {
  it("converts finite number to string when spec.type is string", () => {
    const res = validateArgs({ maxResults: { type: "string", required: true } }, { maxResults: 5 });
    expect(res).toEqual({ ok: true, args: { maxResults: "5" } });
  });

  it("converts boolean to string when spec.type is string", () => {
    const resTrue = validateArgs({ enabled: { type: "string", required: true } }, { enabled: true });
    expect(resTrue).toEqual({ ok: true, args: { enabled: "true" } });

    const resFalse = validateArgs({ enabled: { type: "string", required: true } }, { enabled: false });
    expect(resFalse).toEqual({ ok: true, args: { enabled: "false" } });
  });

  it("does not convert number when spec.type is number", () => {
    const res = validateArgs({ count: { type: "number", required: true } }, { count: 5 });
    expect(res).toEqual({ ok: true, args: { count: 5 } });
    if (res.ok) {
      expect(typeof res.args.count).toBe("number");
    }
  });

  it("keeps rejecting string '5' when spec.type is number", () => {
    const res = validateArgs({ count: { type: "number", required: false } }, { count: "5" });
    expect(res).toEqual({ ok: false, message: '"count" must be of type number.' });
  });

  it("validates enum after type conversion", () => {
    const valid = validateArgs(
      { level: { type: "string", required: false, enum: ["1", "2", "3"] } },
      { level: 2 },
    );
    expect(valid).toEqual({ ok: true, args: { level: "2" } });

    const invalid = validateArgs(
      { level: { type: "string", required: false, enum: ["1", "2", "3"] } },
      { level: 4 },
    );
    expect(invalid).toEqual({ ok: false, message: '"level" must be one of: 1, 2, 3.' });
  });

  it("does not convert NaN or Infinity for string spec", () => {
    const resNaN = validateArgs({ val: { type: "string", required: false } }, { val: NaN });
    expect(resNaN).toEqual({ ok: false, message: '"val" must be of type string.' });

    const resInf = validateArgs({ val: { type: "string", required: false } }, { val: Infinity });
    expect(resInf).toEqual({ ok: false, message: '"val" must be of type string.' });
  });

  it("BDD: Dado jira_get_changelogs com maxResults 5 (spec string), a chamada é aceita e segue como '5'", async () => {
    const { store } = await unlockedStore();
    const { transport } = fakeTransport();
    const broker = new Broker(store, transport, async () => true, new AuditLog(), () => ({ timeoutMs: 1000, maxResponseBytes: 1000, maxRedirects: 2 }));
    const source = new MemorySource();
    source.add("T/jira_get_changelogs.md", {
      tags: ["mcp/tool"],
      tool: "jira_get_changelogs",
      description: "Gets issue changelogs",
      kind: "script",
      params: { maxResults: { type: "string", required: true } },
    }, `${fence}js\nexport default async function (ctx) { return { received: ctx.args.maxResults }; }\n${fence}`);

    const registry = new ToolRegistry(source, () => ({ enabled: true, toolTag: "mcp/tool", scriptsEnabled: true }));
    const tools = new ToolsService({
      registry,
      source,
      broker,
      runner: new ScriptRunner(),
      audit: new AuditLog(),
      settings: () => defaultSettings,
      guide: () => "",
    });
    await registry.refresh();

    const res = await tools.run("jira_get_changelogs", { maxResults: 5 }, client);
    expect(res).toEqual({ received: "5" });
  });
});

describe("Item 19: Script limits and logging", () => {
  it("redacts secrets in ctx.log output and records in audit log with ***", async () => {
    const SECRET_VALUE = "super-secret-token-12345";
    const { store } = await unlockedStore();
    await store.add(secretInput({ name: "MY_SECRET", value: SECRET_VALUE, allowedHosts: ["api.example.com"] }));

    const { transport } = fakeTransport();
    const audit = new AuditLog();
    const broker = new Broker(store, transport, async () => true, audit, () => ({ timeoutMs: 1000, maxResponseBytes: 1000, maxRedirects: 2 }));
    const source = new MemorySource();
    source.add("T/leak.md", {
      tags: ["mcp/tool"],
      tool: "leak_tool",
      description: "Tool that logs secrets",
      kind: "script",
    }, `${fence}js\nexport default async function (ctx) {\n  ctx.log("secret value is: " + "${SECRET_VALUE}");\n  return { ok: true };\n}\n${fence}`);

    const registry = new ToolRegistry(source, () => ({ enabled: true, toolTag: "mcp/tool", scriptsEnabled: true }));
    const tools = new ToolsService({
      registry,
      source,
      broker,
      runner: new ScriptRunner(),
      audit,
      settings: () => defaultSettings,
      guide: () => "",
    });
    await registry.refresh();

    const result = await tools.run("leak_tool", {}, client);
    expect(result).toEqual({ ok: true });

    const entries = audit.list();
    const loggedEntry = entries.find((e) => e.detail && e.detail.includes("secret value is:"));
    expect(loggedEntry).toBeDefined();
    expect(loggedEntry?.detail).toBe("secret value is: ***");
    expect(JSON.stringify(entries)).not.toContain(SECRET_VALUE);
  });

  it("limits ctx.http to 200 calls per execution and fails 201st with limit_reached while runner continues", async () => {
    const { store } = await unlockedStore();
    const { transport } = fakeTransport('{"status":"ok"}');
    const broker = new Broker(store, transport, async () => true, new AuditLog(), () => ({ timeoutMs: 1000, maxResponseBytes: 1000, maxRedirects: 2 }));
    const source = new MemorySource();
    source.add("T/http_loop.md", {
      tags: ["mcp/tool"],
      tool: "http_loop_tool",
      description: "Loops ctx.http 201 times",
      kind: "script",
    }, `${fence}js\nexport default async function (ctx) {\n  let successCount = 0;\n  let errorCaught = null;\n  for (let i = 0; i < 201; i++) {\n    try {\n      await ctx.http({ url: "https://api.example.com/test" });\n      successCount++;\n    } catch (e) {\n      errorCaught = e.message;\n    }\n  }\n  return { successCount, errorCaught };\n}\n${fence}`);

    const registry = new ToolRegistry(source, () => ({ enabled: true, toolTag: "mcp/tool", scriptsEnabled: true }));
    const tools = new ToolsService({
      registry,
      source,
      broker,
      runner: new ScriptRunner(),
      audit: new AuditLog(),
      settings: () => ({ ...defaultSettings, scriptTimeoutSeconds: 30 }),
      guide: () => "",
    });
    await registry.refresh();

    const res = (await tools.run("http_loop_tool", {}, client)) as { successCount: number; errorCaught: string };
    expect(res.successCount).toBe(200);
    expect(res.errorCaught).toContain("limit_reached");
  });

  it("throws limit_reached if 201st ctx.http is uncaught", async () => {
    const { store } = await unlockedStore();
    const { transport } = fakeTransport('{"status":"ok"}');
    const broker = new Broker(store, transport, async () => true, new AuditLog(), () => ({ timeoutMs: 1000, maxResponseBytes: 1000, maxRedirects: 2 }));
    const source = new MemorySource();
    source.add("T/uncaught_loop.md", {
      tags: ["mcp/tool"],
      tool: "uncaught_loop_tool",
      description: "Loops ctx.http 201 times uncaught",
      kind: "script",
    }, `${fence}js\nexport default async function (ctx) {\n  for (let i = 0; i < 201; i++) {\n    await ctx.http({ url: "https://api.example.com/test" });\n  }\n  return "done";\n}\n${fence}`);

    const registry = new ToolRegistry(source, () => ({ enabled: true, toolTag: "mcp/tool", scriptsEnabled: true }));
    const tools = new ToolsService({
      registry,
      source,
      broker,
      runner: new ScriptRunner(),
      audit: new AuditLog(),
      settings: () => ({ ...defaultSettings, scriptTimeoutSeconds: 30 }),
      guide: () => "",
    });
    await registry.refresh();

    await expect(tools.run("uncaught_loop_tool", {}, client)).rejects.toThrow(/limit_reached/);
  });

  it("respects total timeout N seconds without restarting per call", async () => {
    const { store } = await unlockedStore();
    const { transport } = fakeTransport();
    const broker = new Broker(store, transport, async () => true, new AuditLog(), () => ({ timeoutMs: 1000, maxResponseBytes: 1000, maxRedirects: 2 }));
    const source = new MemorySource();
    source.add("T/timeout_tool.md", {
      tags: ["mcp/tool"],
      tool: "timeout_tool",
      description: "Infinite loop tool",
      kind: "script",
    }, `${fence}js\nexport default async function (ctx) {\n  while (true) {}\n}\n${fence}`);

    const registry = new ToolRegistry(source, () => ({ enabled: true, toolTag: "mcp/tool", scriptsEnabled: true }));
    const tools = new ToolsService({
      registry,
      source,
      broker,
      runner: new ScriptRunner(),
      audit: new AuditLog(),
      settings: () => ({ ...defaultSettings, scriptTimeoutSeconds: 1 }),
      guide: () => "",
    });
    await registry.refresh();

    await expect(tools.run("timeout_tool", {}, client)).rejects.toMatchObject({
      code: "timeout",
    });
  });
});
