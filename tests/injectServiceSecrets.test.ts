import * as http from "http";
import { AddressInfo } from "net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AuditLog } from "../src/audit/auditLog";
import { Broker } from "../src/engine/broker";
import { utf8ToBase64 } from "../src/engine/placeholders";
import { nodeTransport } from "../src/engine/transport";
import { ClientContext } from "../src/server/clients";
import { ToolRegistry } from "../src/tools/registry";
import { parseRequestBlock, resolveRequest, servicePlaceholderNames, serviceValue } from "../src/tools/requestNote";
import { ScriptRunner } from "../src/tools/scriptRunner";
import { ToolsService, ToolsSettings } from "../src/tools/service";
import { VaultNote } from "../src/tools/types";
import { secretInput, unlockedStore } from "./helpers";
import { fence, MemorySource } from "./toolHelpers";

const service: VaultNote = {
  path: "S.md",
  name: "Jira - ACME",
  tags: [],
  frontmatter: {
    url: "https://acme.atlassian.net",
    auth: "{{basic:JIRA_ACME}}",
    "legacy.key": "dotted-key",
    automation_web_auth: { bitbucket: "{{basic:BITBUCKET}}", github: "{{bearer:GITHUB}}" },
    nested: { deep: { value: "{{bearer:DEEP}}" }, list: ["a"] },
    bad_map: { broken: "{{secret:}}" },
  },
};

const putRule = (body = "{{param:rule|inject_service:automation_web_auth}}") =>
  parseRequestBlock(
    [`${fence}http`, "PUT {{service.url}}/gateway/api/automation/rule/{{param:id}}", "Authorization: {{service.auth}}", "Content-Type: application/json", "", body, fence].join("\n"),
  );

const rule = (auth: string) => ({
  name: "Notify Bitbucket",
  components: [{ type: "jira.issue.outgoing.webhook", value: { url: "https://api.bitbucket.org/2.0/x", headers: [{ name: "Authorization", value: auth }] } }],
});

describe("{{service.*}} with dot-notation", () => {
  it("reads nested properties of the service note", () => {
    const tpl = parseRequestBlock([`${fence}http`, "GET {{service.url}}/x", "Authorization: {{service.automation_web_auth.bitbucket}}", "X-Deep: {{service.nested.deep.value}}", fence].join("\n"));
    const req = resolveRequest(tpl, { params: {}, service });
    expect(req.headers).toEqual({ Authorization: "{{basic:BITBUCKET}}", "X-Deep": "{{bearer:DEEP}}" });
  });

  it("prefers a key that itself contains dots", () => {
    expect(serviceValue(service.frontmatter, "legacy.key")).toBe("dotted-key");
    expect(serviceValue(service.frontmatter, "nested.list.0")).toBeUndefined();
  });

  it("still requires the final value to be text or a number", () => {
    const tpl = parseRequestBlock([`${fence}http`, "GET {{service.url}}/x", "Authorization: {{service.automation_web_auth}}", fence].join("\n"));
    expect(() => resolveRequest(tpl, { params: {}, service })).toThrow(/must be text or a number/);
    const missing = parseRequestBlock([`${fence}http`, "GET {{service.url}}/x", "Authorization: {{service.automation_web_auth.gitlab}}", fence].join("\n"));
    expect(() => resolveRequest(missing, { params: {}, service })).toThrow(/no property "automation_web_auth.gitlab"/);
  });
});

describe("{{param:x|inject_service:map}} in the body", () => {
  it("replaces {{inject:key}} markers with the values declared in the service note", () => {
    const req = resolveRequest(putRule(), { params: { id: "42", rule: rule("{{inject:bitbucket}}") }, service });
    const body = JSON.parse(req.body!);
    expect(body.components[0].value.headers[0].value).toBe("{{basic:BITBUCKET}}");
    expect(body.name).toBe("Notify Bitbucket");
    expect(req.url).toBe("https://acme.atlassian.net/gateway/api/automation/rule/42");
  });

  it("injects inside a longer string and in a string parameter", () => {
    const req = resolveRequest(putRule('{ "header": "{{param:h|inject_service:automation_web_auth}}" }'), { params: { id: "1", h: "x {{inject:github}} y" }, service });
    expect(JSON.parse(req.body!)).toEqual({ header: "x {{bearer:GITHUB}} y" });
  });

  it("leaves a body without markers untouched", () => {
    const req = resolveRequest(putRule(), { params: { id: "1", rule: { name: "plain", n: 3 } }, service });
    expect(JSON.parse(req.body!)).toEqual({ name: "plain", n: 3 });
  });

  it("refuses a key that is not declared in the service note", () => {
    expect(() => resolveRequest(putRule(), { params: { id: "1", rule: rule("{{inject:gitlab}}") }, service })).toThrow(/"gitlab" is not declared in "automation_web_auth".*bitbucket, github/);
  });

  it("still refuses secret placeholders sent by the agent", () => {
    expect(() => resolveRequest(putRule(), { params: { id: "1", rule: rule("{{basic:OTHER}}") }, service })).toThrow(/secret placeholder/);
  });

  it("refuses markers in a parameter that the note does not declare as injectable", () => {
    const plain = putRule("{{param:rule}}");
    expect(() => resolveRequest(plain, { params: { id: "1", rule: rule("{{inject:bitbucket}}") }, service })).toThrow(/does not declare \{\{param:rule\|inject_service/);
    expect(() => resolveRequest(putRule(), { params: { id: "{{inject:bitbucket}}", rule: {} }, service })).toThrow(/does not declare/);
  });

  it("refuses malformed markers and markers in keys", () => {
    expect(() => resolveRequest(putRule(), { params: { id: "1", rule: rule("{{inject: bit bucket}}") }, service })).toThrow(/Malformed \{\{inject/);
    expect(() => resolveRequest(putRule(), { params: { id: "1", rule: { "{{inject:bitbucket}}": 1 } }, service })).toThrow(/not in keys/);
  });

  it("only accepts a map of text values, with well-formed placeholders", () => {
    expect(() => resolveRequest(putRule("{{param:rule|inject_service:url}}"), { params: { id: "1", rule: {} }, service })).toThrow(/must be a map/);
    expect(() => resolveRequest(putRule("{{param:rule|inject_service:nested}}"), { params: { id: "1", rule: {} }, service })).toThrow(/must be text/);
    expect(() => resolveRequest(putRule("{{param:rule|inject_service:bad_map}}"), { params: { id: "1", rule: {} }, service })).toThrow(/malformed placeholder/);
    expect(() => resolveRequest(putRule("{{param:rule|inject_service:nope}}"), { params: { id: "1", rule: {} }, service })).toThrow(/no property "nope"/);
    expect(() => resolveRequest(putRule(), { params: { id: "1", rule: {} } })).toThrow(/no service note/);
  });

  it("is only allowed in the body", () => {
    const inUrl = parseRequestBlock([`${fence}http`, "GET {{service.url}}/{{param:id|inject_service:automation_web_auth}}", fence].join("\n"));
    expect(() => resolveRequest(inUrl, { params: { id: "1" }, service })).toThrow(/only allowed in the body/);
    const inHeader = parseRequestBlock([`${fence}http`, "GET {{service.url}}/x", "X-A: {{param:id|inject_service:automation_web_auth}}", fence].join("\n"));
    expect(() => resolveRequest(inHeader, { params: { id: "1" }, service })).toThrow(/only allowed in the body/);
  });

  it("lists every secret named in the service note", () => {
    expect(servicePlaceholderNames(service.frontmatter).sort()).toEqual(["BITBUCKET", "DEEP", "GITHUB", "JIRA_ACME"]);
  });
});

describe("injected secrets end to end", () => {
  const client: ClientContext = { id: "c", name: "test", access: { mode: "all" } };
  const settings: ToolsSettings = { toolsEnabled: true, scriptsEnabled: true, toolTag: "mcp/tool", requestTag: "api/request", scriptTimeoutSeconds: 5, maxResponseMB: 1 };
  const BB_TOKEN = "bitbucket-app-password-0123456789";
  let upstream: http.Server;
  let port = 0;
  const received: string[] = [];
  let tools: ToolsService;
  let source: MemorySource;
  let registry: ToolRegistry;

  beforeAll(async () => {
    upstream = http.createServer((req, res) => {
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => {
        received.push(data);
        res.writeHead(200, { "Content-Type": "application/json" });
        // Echo the rule back, as the automation API does: the stored token comes back too.
        res.end(req.method === "GET" ? JSON.stringify(rule("Basic " + utf8ToBase64(`bb@x.com:${BB_TOKEN}`))) : data);
      });
    });
    await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", () => r()));
    port = (upstream.address() as AddressInfo).port;
    const host = `127.0.0.1:${port}`;

    const { store } = await unlockedStore();
    await store.add(secretInput({ name: "JIRA", allowHttpLocalhost: true, allowedHosts: [host] }));
    // The Bitbucket token is stored in the rule, so it travels to the automation API: that host must be allowed.
    await store.add(secretInput({ name: "BB", username: "bb@x.com", value: BB_TOKEN, allowHttpLocalhost: true, allowedHosts: [host], placement: { headers: true, url: false, body: true } }));
    await store.add(secretInput({ name: "BB_HEADERS_ONLY", username: "bb@x.com", value: "headers-only-token-0123456789", allowHttpLocalhost: true, allowedHosts: [host] }));
    await store.add(secretInput({ name: "BB_OTHER_HOST", username: "bb@x.com", value: "other-host-token-0123456789", allowHttpLocalhost: true, allowedHosts: ["api.bitbucket.org"], placement: { headers: true, url: false, body: true } }));

    source = new MemorySource();
    source.add("S/Automation.md", {
      url: `http://${host}`,
      auth: "{{basic:JIRA}}",
      automation_web_auth: { bitbucket: "{{basic:BB}}", headers_only: "{{basic:BB_HEADERS_ONLY}}", other_host: "{{basic:BB_OTHER_HOST}}" },
    });
    source.add(
      "R/Update rule.md",
      { tags: ["api/request"], service: "[[Automation]]" },
      [`${fence}http`, "PUT {{service.url}}/rule/{{param:id}}", "Authorization: {{service.auth}}", "Content-Type: application/json", "", "{{param:rule|inject_service:automation_web_auth}}", fence].join("\n"),
    );
    source.add("R/Get rule.md", { tags: ["api/request"], service: "[[Automation]]" }, [`${fence}http`, "GET {{service.url}}/rule/{{param:id}}", "Authorization: {{service.auth}}", fence].join("\n"));
    source.add("T/update.md", {
      tags: ["mcp/tool"],
      tool: "automation_update_rule",
      kind: "request",
      request: "[[Update rule]]",
      description: "d",
      params: { id: { type: "string", required: true }, rule: { type: "object", required: true } },
    });
    source.add("T/get.md", { tags: ["mcp/tool"], tool: "automation_get_rule", kind: "request", request: "[[Get rule]]", description: "d", params: { id: { type: "string", required: true } } });

    const broker = new Broker(store, nodeTransport, async () => true, new AuditLog(), () => ({ timeoutMs: 5000, maxResponseBytes: 1_000_000, maxRedirects: 5 }));
    registry = new ToolRegistry(source, () => ({ enabled: true, toolTag: "mcp/tool", scriptsEnabled: true }));
    tools = new ToolsService({ registry, source, broker, runner: new ScriptRunner(), audit: new AuditLog(), settings: () => settings, guide: () => "" });
    await registry.refresh();
  });

  afterAll(async () => {
    await new Promise<void>((r) => upstream.close(() => r()));
  });

  it("sends the real token upstream and masks it in the response", async () => {
    const out = (await tools.run("automation_update_rule", { id: "7", rule: rule("{{inject:bitbucket}}") }, client)) as Record<string, unknown>;
    const expected = "Basic " + utf8ToBase64(`bb@x.com:${BB_TOKEN}`);
    expect(JSON.parse(received.at(-1)!).components[0].value.headers[0].value).toBe(expected);
    const text = JSON.stringify(out);
    expect(text).not.toContain(BB_TOKEN);
    expect(text).not.toContain(utf8ToBase64(`bb@x.com:${BB_TOKEN}`));
    expect(text).toContain("***");
  });

  it("masks the service note's secrets when reading the rule back", async () => {
    const out = JSON.stringify(await tools.run("automation_get_rule", { id: "7" }, client));
    expect(out).not.toContain(utf8ToBase64(`bb@x.com:${BB_TOKEN}`));
    expect(out).toContain("***");
  });

  it("keeps the placement and host rules of the injected secret", async () => {
    await expect(tools.run("automation_update_rule", { id: "7", rule: rule("{{inject:headers_only}}") }, client)).rejects.toThrow(/placement_not_allowed/);
    await expect(tools.run("automation_update_rule", { id: "7", rule: rule("{{inject:other_host}}") }, client)).rejects.toThrow(/host_not_allowed/);
  });

  it("refuses a key that the service note does not declare", async () => {
    await expect(tools.run("automation_update_rule", { id: "7", rule: rule("{{inject:JIRA}}") }, client)).rejects.toThrow(/not declared/);
    await expect(tools.run("automation_update_rule", { id: "7", rule: rule("{{basic:JIRA}}") }, client)).rejects.toThrow(/secret placeholder/);
  });
});
