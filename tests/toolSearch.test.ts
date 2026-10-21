import { describe, expect, it } from "vitest";
import { compileEndpoint, EndpointPattern, endpointOf, matchEndpoint, searchTools, SearchResult } from "../src/tools/toolSearch";
import { ToolEntry } from "../src/tools/types";

const tool = (name: string, extra: Partial<ToolEntry> = {}): ToolEntry => ({
  name,
  title: name,
  description: "",
  kind: "request",
  params: {},
  writes: false,
  expose: true,
  notePath: `${name}.md`,
  noteName: name,
  status: "ready",
  problems: [],
  warnings: [],
  ...extra,
});

describe("tool search", () => {
  it("reads the endpoint from the http block, or from the frontmatter", () => {
    expect(endpointOf("```http\nget {{service.url}}/rest/api/3/issue/{{param:key}}\n```", {})).toEqual({ method: "GET", path: "{{service.url}}/rest/api/3/issue/{{param:key}}" });
    expect(endpointOf("no block", { method: "post", path: "/a/{b}" })).toEqual({ method: "POST", path: "/a/{b}" });
    expect(endpointOf("no block", {})).toBeUndefined();
  });

  it("matches real URLs, with a base path in the service URL and the most specific first", () => {
    const changelog = compileEndpoint(tool("jira_get_changelogs"), "GET", "{{service.url}}/rest/api/3/issue/{{param:issueIdOrKey}}/changelog?startAt={{param:startAt}}")!;
    const issue = compileEndpoint(tool("jira_get_issue"), "GET", "{{service.url}}/rest/api/3/issue/{{param:issueIdOrKey}}")!;
    const repo = compileEndpoint(tool("bitbucket_get_a_repository"), "GET", "{{service.url}}/repositories/{workspace}/{repo_slug}")!;
    const index = [issue, changelog, repo];
    const m = matchEndpoint(index, "GET", "https://acme.atlassian.net/rest/api/3/issue/CHG-1119/changelog");
    expect(m.map((x) => x.pattern.tool.name)).toEqual(["jira_get_changelogs"]);
    expect(m[0].args).toEqual({ issueIdOrKey: "CHG-1119" });
    expect(changelog.path).toBe("/rest/api/3/issue/{issueIdOrKey}/changelog");
    const r = matchEndpoint(index, "get", "https://api.bitbucket.org/2.0/repositories/acme/web/");
    expect(r[0].args).toEqual({ workspace: "acme", repo_slug: "web" });
    expect(matchEndpoint(index, "DELETE", "https://acme.atlassian.net/rest/api/3/issue/A-1")).toEqual([]);
    expect(compileEndpoint(tool("x"), "GET", "relative/path")).toBeUndefined();
  });

  it("ranks endpoint matches over keywords and caps the list", () => {
    const tools = [
      tool("jira_get_issue", { description: "Get an issue" }),
      tool("jira_search", { description: "Search issues with JQL", expose: false }),
      tool("broken_issue", { status: "invalid" }),
    ];
    const index = [compileEndpoint(tools[0], "GET", "/rest/api/3/issue/{{param:key}}")!];
    const out = searchTools(tools, index, { query: "issue", method: "GET", url: "/rest/api/3/issue/A-1", limit: 1 });
    expect(out.results.map((r) => r.name)).toEqual(["jira_get_issue"]);
    const words = searchTools(tools, index, { query: "issue search" });
    expect(words.results.map((r) => r.name)).toEqual(["jira_search", "jira_get_issue"]);
    expect((words.results[0] as SearchResult).run).toEqual({ call: "run_vault_tool", arguments: { name: "jira_search", arguments: {} } });
  });

  it("filters by mcp package name, app, or key", () => {
    const tools = [
      tool("jira_get_issue", { mcpName: "Jira Cloud", mcpKeys: ["jira cloud", "jira", "api/app/jira"] }),
      tool("jsm_create_customer", { mcpName: "Jira Service Management", mcpKeys: ["jira service management", "jsm"] }),
      tool("bitbucket_get_repo", { mcpName: "Bitbucket", mcpKeys: ["bitbucket"] }),
    ];
    const index: EndpointPattern[] = [];

    // Listing whole MCP without query/name
    const jiraList = searchTools(tools, index, { mcp: "Jira" });
    expect(jiraList.results.map((r) => r.name)).toEqual(["jira_get_issue"]);
    expect(jiraList.total).toBe(1);

    // Filter by MCP with query
    const jsmSearch = searchTools(tools, index, { mcp: "jsm", query: "customer" });
    expect(jsmSearch.results.map((r) => r.name)).toEqual(["jsm_create_customer"]);

    // Without criteria, returns available MCPs
    const empty = searchTools(tools, index, {});
    expect(empty.results).toEqual([]);
    expect(empty.mcps).toEqual([
      { mcp: "Bitbucket", tools: 1 },
      { mcp: "Jira Cloud", tools: 1 },
      { mcp: "Jira Service Management", tools: 1 },
    ]);
  });

  it("finds a tool by exact name", () => {
    const tools = [
      tool("jira_get_issue", { title: "Get Issue" }),
      tool("jira_get_issues_for_board", { title: "Get Board Issues" }),
    ];
    const out = searchTools(tools, [], { name: "jira_get_issue" });
    expect(out.results.map((r) => r.name)).toEqual(["jira_get_issue"]);
    expect((out.results[0] as SearchResult).title).toBe("Get Issue");
  });
});
