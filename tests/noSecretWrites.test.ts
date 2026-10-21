import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AuditLog } from "../src/audit/auditLog";
import { Broker } from "../src/secrets/broker";
import { nodeTransport } from "../src/secrets/transport";
import { contextOf, createClient, findClient } from "../src/server/clients";
import { LocalServer } from "../src/server/localServer";
import { BUILT_IN_TOOLS } from "../src/server/mcp";
import { ToolRegistry } from "../src/tools/registry";
import { ScriptRunner } from "../src/tools/scriptRunner";
import { META_TOOLS, ToolsService, ToolsSettings } from "../src/tools/service";
import { SecretStore } from "../src/store/secretStore";
import { secretInput, unlockedStore } from "./helpers";
import { MemorySource } from "./toolHelpers";

// Nothing on the AI side may create, change or delete a secret or a value. The only way in is the
// env_criar_secret screen, which the USER fills, and the plugin's own panel.

const PORT = 27196;
const base = `http://127.0.0.1:${PORT}`;
let server: LocalServer;
let store: SecretStore;
let token = "";

const settings: ToolsSettings = { toolsEnabled: true, scriptsEnabled: true, toolTag: "mcp/tool", requestTag: "api/request", scriptTimeoutSeconds: 5, maxResponseMB: 1 };

const snapshot = () => JSON.stringify({ secrets: store.list(), values: store.listValues() });
let before = "";

beforeAll(async () => {
  ({ store } = await unlockedStore());
  await store.add(secretInput({ name: "JIRA_ACME", type: "token", username: undefined, allowedHosts: ["acme.atlassian.net"] }));
  await store.addValue({ name: "PROJECT_KEY", kind: "texto", value: "ACME-1234", description: "", allowedHosts: ["acme.atlassian.net"] });
  before = snapshot();

  const { record, token: tk } = await createClient("test", { mode: "all" });
  token = tk;
  const audit = new AuditLog();
  const broker = new Broker(store, nodeTransport, async () => false, audit, () => ({ timeoutMs: 2000, maxResponseBytes: 100_000, maxRedirects: 2 }));
  const registry = new ToolRegistry(
    new MemorySource(),
    () => ({ enabled: true, toolTag: "mcp/tool", scriptsEnabled: true }),
  );
  const tools = new ToolsService({
    registry,
    source: new MemorySource(),
    broker,
    runner: new ScriptRunner(),
    audit,
    settings: () => settings,
    guide: () => "guide",
  });
  server = new LocalServer({
    port: PORT,
    broker,
    version: "test",
    tools,
    authenticate: async (tk2) => {
      const c = await findClient([record], tk2);
      return c ? contextOf(c) : null;
    },
  });
  await server.start();
});

afterAll(async () => {
  await server.stop();
});

const auth = () => ({ Authorization: `Bearer ${token}`, "Content-Type": "application/json" });

describe("no REST route or tool writes secrets or values", () => {
  it("rejects every write method on the secrets routes, legacy ones included", async () => {
    const paths = ["/v1/secrets", "/v1/secrets/JIRA_ACME", "/secrets", "/api/v1/environment-variables/secrets", "/v1/values", "/api/v1/environment-variables/values"];
    for (const path of paths) {
      for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
        const res = await fetch(`${base}${path}`, { method, headers: auth(), body: JSON.stringify({ name: "EVIL", value: "evil-value-123", type: "token" }) });
        expect([404, 405], `${method} ${path}`).toContain(res.status);
      }
    }
    expect(snapshot()).toBe(before);
  });

  it("the only secrets route that answers is a read-only listing, with no values", async () => {
    const res = await fetch(`${base}/v1/secrets`, { headers: auth() });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("JIRA_ACME");
    expect(text).not.toContain(secretInput().value);
    expect(text).not.toContain("ACME-1234");
    expect(text).not.toContain("PROJECT_KEY"); // values are not listed as secrets
  });

  it("offers no tool that creates, changes or deletes (and not env_criar_secret on the transition server)", async () => {
    const mcp = async (body: unknown) => {
      const res = await fetch(`${base}/mcp`, { method: "POST", headers: { ...auth(), Accept: "application/json, text/event-stream" }, body: JSON.stringify(body) });
      return (await res.json()) as { result: { tools?: Array<{ name: string }>; isError?: boolean; content?: Array<{ text: string }> } };
    };
    const names = (await mcp({ jsonrpc: "2.0", id: 1, method: "tools/list" })).result.tools!.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["list_secrets", "http_request"]));
    expect(names.join(" ")).not.toMatch(/(^| )(create|add|set|update|delete|remove|store|save|adopt|write)[a-z_]*/i);
    expect(names).not.toContain("env_criar_secret");
    expect([...BUILT_IN_TOOLS, ...META_TOOLS].map((t) => t.name)).not.toContain("env_criar_secret");

    for (const name of ["env_criar_secret", "create_secret", "set_secret", "delete_secret"]) {
      const res = await mcp({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: { nome_sugerido: "X", name: "X", value: "abc-value-12345" } } });
      expect(res.result.isError, name).toBe(true);
    }
    // list_secrets and a request that uses a placeholder leave the store as it was.
    await mcp({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_secrets", arguments: {} } });
    await mcp({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "http_request", arguments: { url: "https://acme.atlassian.net/", headers: { "X-P": "{{secret:PROJECT_KEY}}" }, body: "{{secret:JIRA_ACME}}" } },
    });
    expect(snapshot().replace(/"lastUsedAt":"[^"]*",?/g, "")).toBe(before.replace(/"lastUsedAt":"[^"]*",?/g, ""));
  });

  it("registers, with AI Ecosystem, only read and request routes (source audit)", () => {
    const main = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
    const routes = [...main.matchAll(/\{ method: "(GET|POST|PUT|PATCH|DELETE)", path: "([^"]+)"/g)].map((m) => `${m[1]} ${m[2]}`).sort();
    expect(routes).toEqual(
      [
        "GET /secrets",
        "GET /tools",
        "GET /tools/guide",
        "POST /request",
        "POST /tools/:name",
        "GET /v1/secrets",
        "GET /v1/tools",
        "GET /v1/tools/guide",
        "POST /v1/request",
        "POST /v1/tools/:name",
      ].sort(),
    );
    // The transition server has the same surface.
    const local = readFileSync(new URL("../src/server/localServer.ts", import.meta.url), "utf8");
    const paths = [...new Set([...local.matchAll(/"(\/(?:v1|api|mcp|health)[^"]*)"/g)].map((m) => m[1]))].sort();
    expect(paths).toEqual(["/api/v1/environment-variables/request", "/health", "/mcp", "/v1/health", "/v1/request", "/v1/secrets", "/v1/tools", "/v1/tools/guide"].sort());
    const methods = new Set([...local.matchAll(/req\.method [=!]== "([A-Z]+)"/g)].map((m) => m[1]));
    expect([...methods].sort()).toEqual(["DELETE", "GET", "POST"]); // DELETE only closes an MCP session: it answers { ok: true }
    // Only the screen and the panel call the store's write methods; the routes, tools and server never do.
    for (const file of ["../src/server/localServer.ts", "../src/server/mcp.ts", "../src/tools/service.ts", "../src/secrets/broker.ts"]) {
      const source = readFileSync(new URL(file, import.meta.url), "utf8");
      expect(source, file).not.toMatch(/store\.(add|addValue|update|remove|removeValue)\(/);
    }
  });
});
