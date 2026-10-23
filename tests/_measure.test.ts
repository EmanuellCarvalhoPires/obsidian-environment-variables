import { it } from "vitest";
import { AuditLog } from "../src/audit/auditLog";
import { Broker } from "../src/secrets/broker";
import { contextOf, createClient } from "../src/server/clients";
import { handleMcpMessage } from "../src/server/mcp";
import { buildGuide } from "../src/tools/guide";
import { ToolRegistry } from "../src/tools/registry";
import { ScriptRunner } from "../src/tools/scriptRunner";
import { ToolsService, ToolsSettings } from "../src/tools/service";
import { unlockedStore } from "./helpers";
import { fence, MemorySource } from "./toolHelpers";

const settings: ToolsSettings = { toolsEnabled: true, scriptsEnabled: true, toolTag: "mcp/tool", requestTag: "api/request", scriptTimeoutSeconds: 5, maxResponseMB: 1 };

it("measure", async () => {
  const issues = Array.from({ length: 50 }, (_, i) => ({
    expand: "operations,versionedRepresentations,editmeta,changelog,renderedFields",
    id: String(10000 + i),
    self: `https://acme.atlassian.net/rest/api/3/issue/${10000 + i}`,
    key: `ABC-${i}`,
    fields: { summary: `Issue number ${i} with a reasonably long summary text`, status: { self: "https://acme.atlassian.net/rest/api/3/status/3", description: "The issue is being actively worked on.", iconUrl: "https://acme.atlassian.net/images/icons/statuses/inprogress.png", name: "In Progress", id: "3", statusCategory: { self: "x", id: 4, key: "indeterminate", colorName: "yellow", name: "In Progress" } }, assignee: { accountId: "abc", displayName: "Someone", avatarUrls: { "48x48": "https://x/48", "24x24": "https://x/24", "16x16": "https://x/16", "32x32": "https://x/32" } }, labels: ["a", "b"], created: "2026-01-01T00:00:00.000+0000" },
  }));
  const bigBody = JSON.stringify({ expand: "names,schema", startAt: 0, maxResults: 50, total: 500, issues });
  const source = new MemorySource();
  const mk = (name: string, mcpFolder: string, desc: string, params: Record<string, unknown>, writes = false) =>
    source.add(`MCPs/${mcpFolder}/${name}.md`, { tags: ["mcp/tool"], tool: name, kind: "request", request: "[[Get item]]", description: desc, params, writes, expose: false });
  source.add("Services/Svc.md", { url: "https://acme.atlassian.net" });
  source.add("Requests/Get item.md", { tags: ["api/request"], service: "[[Svc]]" }, [`${fence}http`, "GET {{service.url}}/rest/api/3/issue/{{param:issueIdOrKey}}", fence].join("\n"));
  const long = "Returns the details for an issue. The issue is identified by its ID or key. Fields are returned according to the permissions of the user, and the expand parameter lets callers ask for additional information such as rendered fields, change log and transitions. See the Atlassian documentation for the full list of options. ";
  mk("jira_get_issue", "Jira Cloud", long, { issueIdOrKey: { type: "string", required: true, description: "The ID or key of the issue." }, expand: { type: "string", description: "Use expand to include additional information about issues in the response. This parameter accepts a comma-separated list." }, fields: { type: "string", description: "A list of fields to return for the issue." } });
  mk("jira_get_changelogs", "Jira Cloud", long, { issueIdOrKey: { type: "string", required: true, description: "The ID or key of the issue." }, startAt: { type: "integer", description: "The index of the first item to return." }, maxResults: { type: "integer", description: "The maximum number of items to return." } });
  mk("jira_search_for_issues_using_jql", "Jira Cloud", long, { jql: { type: "string", required: true, description: "The JQL that defines the search." }, fields: { type: "string" }, maxResults: { type: "integer" } });
  mk("jira_edit_issue", "Jira Cloud", long, { issueIdOrKey: { type: "string", required: true }, body: { type: "object", required: true } }, true);
  mk("jira_get_transitions", "Jira Cloud", long, { issueIdOrKey: { type: "string", required: true } });
  mk("jira_get_issue_comments", "Jira Cloud", long, { issueIdOrKey: { type: "string", required: true }, orderBy: { type: "string", enum: ["created", "-created"] } });
  const { store } = await unlockedStore();
  const transport = async () => ({ status: 200, statusText: "OK", headers: { "content-type": "application/json", server: "AtlassianEdge", "x-trace-id": "abc123", "x-ratelimit-remaining": "99", "set-cookie": "a=b; Path=/; Secure", "cache-control": "no-cache", date: "Thu, 22 Oct 2026 18:00:00 GMT" }, body: bigBody, bodyEncoding: "text" as const, bodyBytes: bigBody.length, truncated: false, finalUrl: "https://acme.atlassian.net/rest/api/3/search", redirects: 0 });
  const audit = new AuditLog();
  const broker = new Broker(store, transport, async () => true, audit, () => ({ timeoutMs: 5000, maxResponseBytes: 5_000_000, maxRedirects: 5 }));
  const registry = new ToolRegistry(source, () => ({ enabled: true, toolTag: settings.toolTag, scriptsEnabled: true }));
  const tools = new ToolsService({ registry, source, broker, runner: new ScriptRunner(), audit, settings: () => settings, guide: () => buildGuide("en") });
  await registry.refresh();
  const full = await createClient("m", { mode: "all" });
  const client = contextOf(full.record);
  const ctx = { broker, client, version: "t", tools, guide: (r?: string) => buildGuide("en", r) };
  let id = 0;
  const rpc = async (method: string, params?: unknown) => (await handleMcpMessage({ jsonrpc: "2.0", id: ++id, method, params }, ctx)) as any;
  const size = (v: unknown) => JSON.stringify(v).length;
  const out: Record<string, number> = {};
  const list = await rpc("tools/list");
  out["tools/list bytes (no vault tools exposed)"] = size(list.result);
  const init = await rpc("initialize", { protocolVersion: "2025-06-18" });
  out["initialize instructions chars"] = init.result.instructions.length;
  const call = async (label: string, name: string, args: unknown) => {
    const r = await rpc("tools/call", { name, arguments: args });
    out[label] = size(r.result);
  };
  const extra = JSON.parse(process.env.M_EXTRA ?? "{}");
  await call("search mcp+query (6 jira tools) rpc bytes", "search_vault_tools", { mcp: "Jira", query: "issue" });
  await call("search exact name rpc bytes", "search_vault_tools", { name: "jira_get_issue" });
  await call("search exact name FULL rpc bytes", "search_vault_tools", { name: "jira_get_issue", ...extra.full });
  await call("search mcp+query FULL rpc bytes", "search_vault_tools", { mcp: "Jira", query: "issue", ...extra.full });
  await call("http_request (50 issues, 60KB body) rpc bytes", "http_request", { url: "https://acme.atlassian.net/rest/api/3/search" });
  await call("run_vault_tool jira_get_issue (60KB body) rpc bytes", "run_vault_tool", { name: "jira_get_issue", arguments: { issueIdOrKey: "ABC-1" } });
  await call("list_secrets (empty) rpc bytes", "list_secrets", {});
  if (extra.shaped) for (const [k, v] of Object.entries(extra.shaped as Record<string, any>)) await call(k, v.name, v.args);
  console.log("MEASURE " + JSON.stringify(out, null, 1));
});
