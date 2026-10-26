import { describe, expect, it } from "vitest";
import { buildApiIndexEntries, effectOf, toApiIndexEntry } from "../src/tools/apiIndex";
import { metadataFor, NATIVE_TOOL_METADATA } from "../src/tools/hubMetadata";
import { BUILT_IN_TOOLS } from "../src/server/mcp";
import { META_TOOLS } from "../src/tools/service";
import { CREATE_SECRET_TOOL_NAME } from "../src/tools/createSecretTool";
import { ToolEntry } from "../src/tools/types";

const tool = (name: string, extra: Partial<ToolEntry> = {}): ToolEntry => ({
  name,
  title: name,
  description: `Does ${name}`,
  kind: "request",
  params: {},
  writes: false,
  expose: false,
  notePath: "mcp.db",
  noteName: name,
  mcpName: "Jira Cloud",
  mcpKeys: ["jiracloud"],
  status: "ready",
  problems: [],
  warnings: [],
  ...extra,
});

describe("api index", () => {
  it("maps methods to effects, with JQL searches by POST as reads", () => {
    const e = tool("x");
    expect(effectOf(e, { method: "GET", path: "/issue/{id}" })).toBe("leitura");
    expect(effectOf(e, { method: "POST", path: "/rest/api/3/search/jql" })).toBe("leitura");
    expect(effectOf(e, { method: "POST", path: "/rest/api/3/issue" })).toBe("externo");
    expect(effectOf(e, { method: "PUT", path: "/issue/{id}" })).toBe("externo");
    expect(effectOf(e, { method: "DELETE", path: "/issue/{id}" })).toBe("externo");
    expect(effectOf(tool("w", { writes: true }), undefined)).toBe("externo");
  });

  it("builds kind api entries with the package as categoria", async () => {
    const entries = await buildApiIndexEntries(
      [
        tool("jira_get_changelogs", { title: "Get changelogs", params: { issueIdOrKey: { type: "string", required: true } } }),
        tool("jira_search_jql", { title: "Search issues by JQL" }),
        tool("script_tool", { kind: "script" }),
        tool("broken", { status: "invalid" }),
      ],
      (e) => (e.name === "jira_search_jql" ? { method: "POST", path: "/rest/api/3/search/jql" } : { method: "GET", path: "/rest/api/3/issue/{issueIdOrKey}/changelog" }),
    );
    expect(entries.map((e) => e.name)).toEqual(["jira_get_changelogs", "jira_search_jql"]);
    expect(entries[0]).toMatchObject({ kind: "api", categoria: "Jira Cloud", efeito: "leitura", exposicao: "indice", exemplo: { issueIdOrKey: "<issueIdOrKey>" } });
    expect(entries[0].description).toContain("/changelog");
    expect(entries[1].efeito).toBe("leitura");
    expect(entries[0].resumo!.length).toBeLessThanOrEqual(100);
  });

  it("does not put a secret value anywhere: only descriptions and schemas", () => {
    const entry = toApiIndexEntry(tool("a", { description: "uses {{secret:JIRA}}" }), { method: "GET", path: "/a" });
    expect(JSON.stringify(entry)).not.toMatch(/ATATT/);
  });
});

describe("native tool metadata", () => {
  it("covers the 8 native tools with every field", () => {
    const names = [...BUILT_IN_TOOLS.map((t) => t.name), ...META_TOOLS.map((t) => t.name), CREATE_SECRET_TOOL_NAME];
    expect(new Set(names).size).toBe(8);
    for (const name of names) {
      const m = NATIVE_TOOL_METADATA[name];
      expect(m, name).toBeDefined();
      expect(m.categoria, name).toBeTruthy();
      expect(m.tags?.length, name).toBeGreaterThan(0);
      expect(m.resumo!.length, name).toBeLessThanOrEqual(100);
      expect(["leitura", "cofre", "externo"]).toContain(m.efeito);
    }
    expect(metadataFor("some_note_tool", true).efeito).toBe("externo");
  });
});

describe("tools/list in indexed mode", () => {
  it("never lists the API tools one by one, but indexes all of them", async () => {
    const { ToolsService } = await import("../src/tools/service");
    const apiTools = Array.from({ length: 50 }, (_, i) => tool(`jira_tool_${i}`));
    const registry = { list: () => apiTools, onChange: () => () => undefined, ensureFresh: async () => undefined, get: () => undefined };
    const service = new ToolsService({
      registry: registry as never,
      source: { byTag: () => [], resolve: () => undefined, read: async () => "" } as never,
      broker: {} as never,
      runner: {} as never,
      audit: { add: () => undefined } as never,
      settings: () => ({ toolsEnabled: true, scriptsEnabled: false, toolTag: "mcp/tool", requestTag: "mcp/request", scriptTimeoutSeconds: 5, maxResponseMB: 1 }),
      guide: () => "",
    });
    const listed = service.mcpTools().map((t) => t.name);
    expect(listed.some((n) => n.startsWith("jira_tool_"))).toBe(false);
    expect(listed).toEqual(META_TOOLS.map((t) => t.name));
    expect((await service.apiIndexEntries()).length).toBe(50);
  });
});
