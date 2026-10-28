import { describe, expect, it, vi } from "vitest";

const { MockTFile } = vi.hoisted(() => {
  class MockTFile {
    path: string = "";
    basename: string = "";
    extension: string = "md";
  }
  return { MockTFile };
});

vi.mock("obsidian", () => ({
  TFile: MockTFile,
  App: class {},
}));

import { AuditLog } from "../src/audit/auditLog";
import { Broker } from "../src/secrets/broker";
import { ClientContext } from "../src/server/clients";
import { executeMcpToolCall } from "../src/server/mcp";
import { ObsidianNoteSource } from "../src/tools/obsidianSource";
import { ToolRegistry } from "../src/tools/registry";
import { ScriptRunner } from "../src/tools/scriptRunner";
import { ToolsService, ToolsSettings } from "../src/tools/service";
import { ToolEntry, VaultNote } from "../src/tools/types";
import { MemorySource } from "./toolHelpers";

const client: ClientContext = { id: "test", name: "test", access: { mode: "all" } };
const settings: ToolsSettings = {
  toolsEnabled: true,
  scriptsEnabled: true,
  toolTag: "mcp/tool",
  requestTag: "api/request",
  scriptTimeoutSeconds: 5,
  maxResponseMB: 1,
};

describe("endpoint index with mcp.db tools", () => {
  it("(a) finds a database tool by URL via buildEndpointIndex", async () => {
    const dbTool: ToolEntry = {
      name: "jira_get_changelogs",
      title: "Get Changelogs",
      description: "Returns changelogs for an issue",
      kind: "request",
      params: { key: { type: "string", required: true } },
      writes: false,
      expose: false,
      notePath: "mcp.db",
      noteName: "jira_get_changelogs",
      request: "req_changelog",
      status: "ready",
      problems: [],
      warnings: [],
    };

    const dbManagerMock = {
      getRequestForTool: (name: string) => {
        if (name === "jira_get_changelogs") {
          return {
            id: "req_changelog",
            tool_id: "jira_get_changelogs",
            method: "GET",
            path: "/rest/api/3/issue/{key}/changelog",
            writes_data: 0,
          } as any;
        }
        return undefined;
      },
      getRequestNote: () => undefined,
    };

    const source = new MemorySource();
    const registry = new ToolRegistry(source, () => ({ enabled: true, toolTag: "mcp/tool", scriptsEnabled: true }), () => [dbTool]);
    const broker = {
      execute: vi.fn(),
      listSecrets: () => ({ ok: true, secrets: [] }),
    } as unknown as Broker;

    const service = new ToolsService({
      registry,
      source,
      broker,
      runner: new ScriptRunner(),
      audit: new AuditLog(),
      settings: () => settings,
      guide: () => "",
      dbManager: dbManagerMock as any,
    });

    await registry.refresh();

    // Given a database tool with GET /rest/api/3/issue/{key}/changelog,
    // When searching .../issue/ABC-1/changelog,
    // Then search_vault_tools returns this tool.
    const searchRes = await service.callMcp(
      "search_vault_tools",
      { method: "GET", url: "https://acme.atlassian.net/rest/api/3/issue/ABC-1/changelog" },
      client,
    );

    expect(searchRes.isError).toBe(false);
    const results = (searchRes.value as any).results;
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].name).toBe("jira_get_changelogs");
  });

  it("(b) runs tool and returns via_tool when single GET tool matches with required params", async () => {
    const dbTool: ToolEntry = {
      name: "jira_get_changelogs",
      title: "Get Changelogs",
      description: "Returns changelogs for an issue",
      kind: "request",
      params: { key: { type: "string", required: true } },
      writes: false,
      expose: false,
      notePath: "mcp.db",
      noteName: "jira_get_changelogs",
      request: "req_changelog",
      status: "ready",
      problems: [],
      warnings: [],
    };

    const dbManagerMock = {
      getRequestForTool: (name: string) => {
        if (name === "jira_get_changelogs") {
          return {
            id: "req_changelog",
            tool_id: "jira_get_changelogs",
            method: "GET",
            path: "/rest/api/3/issue/{key}/changelog",
            writes_data: 0,
          } as any;
        }
        return undefined;
      },
      getRequestNote: (name: string) => {
        if (name === "jira_get_changelogs") {
          const note: VaultNote = {
            path: "mcp.db",
            name: "req_changelog",
            frontmatter: { method: "GET", path: "/rest/api/3/issue/{key}/changelog" },
            tags: [],
          };
          return {
            note,
            body: "```http\nGET https://acme.atlassian.net/rest/api/3/issue/{{param:key}}/changelog\n```",
          };
        }
        return undefined;
      },
    };

    const source = new MemorySource();
    const registry = new ToolRegistry(source, () => ({ enabled: true, toolTag: "mcp/tool", scriptsEnabled: true }), () => [dbTool]);

    const broker = {
      execute: vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: "OK",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ values: [{ id: "1" }] }),
        truncated: false,
        redactions: [],
      }),
      listSecrets: () => ({ ok: true, secrets: [] }),
    } as unknown as Broker;

    const service = new ToolsService({
      registry,
      source,
      broker,
      runner: new ScriptRunner(),
      audit: new AuditLog(),
      settings: () => settings,
      guide: () => "",
      dbManager: dbManagerMock as any,
    });

    await registry.refresh();

    const res = await executeMcpToolCall(
      "http_request",
      { method: "GET", url: "https://acme.atlassian.net/rest/api/3/issue/ABC-1/changelog" },
      { broker, client, tools: service },
    );

    expect(res.isError).toBe(false);
    expect(res.structuredContent?.via_tool).toBe("jira_get_changelogs");
    expect(res.structuredContent?.ok).toBe(true);
    expect(res.structuredContent?.status).toBe(200);
  });

  it("(c) does not run tool when two tools match: returns raw response with hint", async () => {
    const toolA: ToolEntry = {
      name: "jira_get_changelogs",
      title: "Get Changelogs",
      description: "Changelogs",
      kind: "request",
      params: { key: { type: "string", required: true } },
      writes: false,
      expose: false,
      notePath: "mcp.db",
      noteName: "jira_get_changelogs",
      request: "req_changelog",
      status: "ready",
      problems: [],
      warnings: [],
    };

    const toolB: ToolEntry = {
      name: "jira_get_changelogs_v2",
      title: "Get Changelogs V2",
      description: "Changelogs alternative",
      kind: "request",
      params: { key: { type: "string", required: true } },
      writes: false,
      expose: false,
      notePath: "mcp.db",
      noteName: "jira_get_changelogs_v2",
      request: "req_changelog_v2",
      status: "ready",
      problems: [],
      warnings: [],
    };

    const dbManagerMock = {
      getRequestForTool: (name: string) => {
        if (name === "jira_get_changelogs" || name === "jira_get_changelogs_v2") {
          return {
            id: `req_${name}`,
            tool_id: name,
            method: "GET",
            path: "/rest/api/3/issue/{key}/changelog",
            writes_data: 0,
          } as any;
        }
        return undefined;
      },
      getRequestNote: () => undefined,
    };

    const source = new MemorySource();
    const registry = new ToolRegistry(source, () => ({ enabled: true, toolTag: "mcp/tool", scriptsEnabled: true }), () => [toolA, toolB]);

    const rawBrokerExecute = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ raw: "response" }),
      truncated: false,
      redactions: [],
    });

    const broker = {
      execute: rawBrokerExecute,
      listSecrets: () => ({ ok: true, secrets: [] }),
    } as unknown as Broker;

    const service = new ToolsService({
      registry,
      source,
      broker,
      runner: new ScriptRunner(),
      audit: new AuditLog(),
      settings: () => settings,
      guide: () => "",
      dbManager: dbManagerMock as any,
    });

    await registry.refresh();

    const res = await executeMcpToolCall(
      "http_request",
      { method: "GET", url: "https://acme.atlassian.net/rest/api/3/issue/ABC-1/changelog" },
      { broker, client, tools: service },
    );

    // Two tools match: no via_tool, raw execution via broker with vault_tool_hint
    expect(res.isError).toBe(false);
    expect(res.structuredContent?.via_tool).toBeUndefined();
    expect(res.structuredContent?.vault_tool_hint).toBeDefined();
    expect((res.structuredContent?.vault_tool_hint as { tool?: string })?.tool).toBe("jira_get_changelogs");
    expect(rawBrokerExecute).toHaveBeenCalled();
  });

  it("(d) toNote ignores tags that appear only in the note body", () => {
    const fileWithBodyTag = Object.assign(new MockTFile(), { path: "BodyOnly.md", basename: "BodyOnly", extension: "md" });
    const fileWithFmTag = Object.assign(new MockTFile(), { path: "Frontmatter.md", basename: "Frontmatter", extension: "md" });

    const mockApp = {
      vault: {
        getAbstractFileByPath: (p: string) => {
          if (p === "BodyOnly.md") return fileWithBodyTag;
          if (p === "Frontmatter.md") return fileWithFmTag;
          return null;
        },
      },
      metadataCache: {
        getFileCache: (f: any) => {
          if (f.path === "BodyOnly.md") {
            return {
              frontmatter: { title: "Body Tag Note" },
              // In Obsidian cache, inline tags from body appear in cache.tags
              tags: [{ tag: "#jira/instance" }],
            };
          }
          if (f.path === "Frontmatter.md") {
            return {
              frontmatter: { tags: ["jira/instance"] },
              tags: [{ tag: "#jira/instance" }],
            };
          }
          return null;
        },
      },
    } as any;

    const noteSource = new ObsidianNoteSource(mockApp);

    const bodyOnlyNote = noteSource.get("BodyOnly.md")!;
    expect(bodyOnlyNote).toBeDefined();
    expect(bodyOnlyNote.tags).toEqual([]);

    const fmNote = noteSource.get("Frontmatter.md")!;
    expect(fmNote).toBeDefined();
    expect(fmNote.tags).toEqual(["jira/instance"]);
  });

  it("handles instance note created after mount and resolved event; description does not repeat ids", async () => {
    const genericDbTool: ToolEntry = {
      name: "jira_get_issue",
      title: "Get Issue",
      description: "Gets an issue",
      kind: "request",
      params: { key: { type: "string", required: true } },
      writes: false,
      expose: true,
      notePath: "mcp.db",
      noteName: "jira_get_issue",
      request: "req_issue",
      serviceTag: "jira/instance",
      serviceParam: "instance",
      status: "ready",
      problems: [],
      warnings: [],
    };

    const source = new MemorySource();
    const registry = new ToolRegistry(source, () => ({ enabled: true, toolTag: "mcp/tool", scriptsEnabled: true }), () => [genericDbTool]);

    // Initial scan with no service note in vault: status becomes invalid
    await registry.refresh();
    expect(registry.get("jira_get_issue")!.status).toBe("invalid");

    // Two instance notes are created later
    source.add("Services/Jira - Acme.md", { tags: ["jira/instance"] });
    source.add("Services/Jira - Beta.md", { tags: ["jira/instance"] });

    // isServiceNote recognises the serviceTag from dbToolsProvider
    const relevant = registry.noteChanged("Services/Jira - Acme.md");
    expect(relevant).toBe(true);

    // After metadata cache resolves and scan runs:
    await registry.ensureFresh();
    const readyTool = registry.get("jira_get_issue")!;
    expect(readyTool.status).toBe("ready");

    // Instance parameter description does NOT repeat the list of ids, but enum remains
    const instanceParam = readyTool.params.instance;
    expect(instanceParam).toBeDefined();
    expect(instanceParam.enum).toEqual(["Acme", "Beta"]);
    expect(instanceParam.description).toBe("Which instance to use. Each value is a note tagged #jira/instance.");
    expect(instanceParam.description).not.toContain("Acme");
    expect(instanceParam.description).not.toContain("Beta");
  });
});
