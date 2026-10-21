import { describe, expect, it } from "vitest";
import type { AuditEntry } from "../src/audit/auditLog";
import { computeMcpGroupStats, matchedTools, newMcpApp, newMcpGroup, parseLinkLines, validateMcpAppName, validateMcpGroupName } from "../src/tools/mcpGroups";
import { parseToolNote } from "../src/tools/definition";
import { ToolEntry } from "../src/tools/types";
import { MemorySource } from "./toolHelpers";

function entryFor(source: MemorySource, path: string): ToolEntry {
  const note = source.get(path)!;
  const parsed = parseToolNote({ ...note, body: "" });
  return { ...parsed, status: "ready" };
}

describe("mcpGroups", () => {
  it("matches tools by tag, including subtags", () => {
    const source = new MemorySource();
    source.add("Jira - Get issue.md", { tool: "jira_get_issue", description: "d", kind: "request", request: "[[R]]", tags: ["mcp/tool/jira"] });
    source.add("Bitbucket - List repos.md", { tool: "bb_list_repos", description: "d", kind: "request", request: "[[R]]", tags: ["mcp/tool/bitbucket"] });
    const entries = [entryFor(source, "Jira - Get issue.md"), entryFor(source, "Bitbucket - List repos.md")];

    const group = { ...newMcpGroup(), name: "Jira Cloud MCP", tag: "mcp/tool/jira" };
    const matched = matchedTools(group, entries, source);

    expect(matched.map((e) => e.name)).toEqual(["jira_get_issue"]);
  });

  it("matches tools by explicit links regardless of tag", () => {
    const source = new MemorySource();
    source.add("Confluence - Create page.md", { tool: "conf_create_page", description: "d", kind: "request", request: "[[R]]", tags: ["mcp/tool/other"] });
    const entries = [entryFor(source, "Confluence - Create page.md")];

    const group = { ...newMcpGroup(), name: "Confluence MCP", links: ["[[Confluence - Create page]]"] };
    const matched = matchedTools(group, entries, source);

    expect(matched.map((e) => e.name)).toEqual(["conf_create_page"]);
  });

  it("counts requests from the audit log, ignoring other tools and actions", () => {
    const source = new MemorySource();
    source.add("Jira - Get issue.md", { tool: "jira_get_issue", description: "d", kind: "request", request: "[[R]]", tags: ["mcp/tool/jira"] });
    const entries = [entryFor(source, "Jira - Get issue.md")];
    const audit: AuditEntry[] = [
      { time: "t", client: "c", action: "tool", tool: "jira_get_issue", secrets: [], outcome: "ok" },
      { time: "t", client: "c", action: "tool", tool: "jira_get_issue", secrets: [], outcome: "ok" },
      { time: "t", client: "c", action: "tool", tool: "other_tool", secrets: [], outcome: "ok" },
      { time: "t", client: "c", action: "request", secrets: [], outcome: "ok" },
    ];

    const group = { ...newMcpGroup(), name: "Jira Cloud MCP", tag: "mcp/tool/jira" };
    const stats = computeMcpGroupStats(group, entries, source, audit);

    expect(stats.toolCount).toBe(1);
    expect(stats.requestCount).toBe(2);
  });

  it("counts the tools of a downloaded package (mcp.db) by package id", () => {
    const source = new MemorySource();
    const dbTool = (name: string, keys: string[]): ToolEntry => ({
      name, title: name, description: "d", kind: "request", params: {}, writes: false, expose: false,
      notePath: "MCP/MCPs/Jira Cloud/jira-v3.db", noteName: name, mcpName: "Jira Cloud", mcpKeys: keys,
      status: "ready", problems: [], warnings: [],
    });
    const entries = [dbTool("jira_get_issue", ["jira v3", "jira cloud"]), dbTool("jira_search", ["jira v3"]), dbTool("bb_repos", ["bitbucket"])];

    const group = { ...newMcpGroup(), name: "Jira Cloud", tag: "api/app/jira", sourcePackageId: "jira-v3" };
    const stats = computeMcpGroupStats(group, entries, source, []);

    expect(stats.toolCount).toBe(2);
    expect(stats.toolNames).toEqual(["jira_get_issue", "jira_search"]);
  });

  it("parses one link per non-empty line", () => {
    expect(parseLinkLines("[[A]]\n\n [[B]] \nC\n")).toEqual(["[[A]]", "[[B]]", "C"]);
  });

  describe("validateMcpGroupName", () => {
    it("requires a name", () => {
      expect(validateMcpGroupName("  ", [])).toBeTruthy();
    });

    it("rejects a name already used by another group", () => {
      const existing = { ...newMcpGroup(), name: "Jira Cloud MCP" };
      expect(validateMcpGroupName("jira cloud mcp", [existing])).toBeTruthy();
    });

    it("allows keeping a group's own name while editing it", () => {
      const existing = { ...newMcpGroup(), id: "same", name: "Jira Cloud MCP" };
      expect(validateMcpGroupName("Jira Cloud MCP", [existing], "same")).toBeNull();
    });
  });

  it("leaves a new group without an app by default", () => {
    expect(newMcpGroup().appId).toBeUndefined();
  });

  describe("validateMcpAppName", () => {
    it("rejects an app name already used by another app", () => {
      const existing = { ...newMcpApp(), name: "Atlassian" };
      expect(validateMcpAppName("atlassian", [existing])).toBeTruthy();
    });

    it("allows keeping an app's own name while editing it", () => {
      const existing = { ...newMcpApp(), id: "same", name: "Atlassian" };
      expect(validateMcpAppName("Atlassian", [existing], "same")).toBeNull();
    });
  });
});
