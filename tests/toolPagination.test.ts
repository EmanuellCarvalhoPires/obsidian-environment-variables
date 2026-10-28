import { describe, expect, it, vi } from "vitest";
import { AuditLog } from "../src/audit/auditLog";
import { Broker } from "../src/secrets/broker";
import { ClientContext } from "../src/server/clients";
import { paginate } from "../src/tools/pagination";
import { ToolRegistry } from "../src/tools/registry";
import { ScriptRunner } from "../src/tools/scriptRunner";
import { ToolsService, ToolsSettings } from "../src/tools/service";
import { ToolEntry, VaultNote } from "../src/tools/types";
import { MemorySource } from "./toolHelpers";

const client: ClientContext = { id: "test", name: "test", access: { mode: "all" } };
const defaultSettings: ToolsSettings = {
  toolsEnabled: true,
  scriptsEnabled: true,
  toolTag: "mcp/tool",
  requestTag: "api/request",
  scriptTimeoutSeconds: 5,
  maxResponseMB: 1,
};

describe("toolPagination unit tests", () => {
  it("given page_limit 5 and API with 3 pages startAt, Then returns items of all 3 pages and stops", async () => {
    // startAt com 3 páginas
    const pages = [
      { startAt: 0, total: 3, issues: [{ id: "1", key: "A-1" }] },
      { startAt: 1, total: 3, issues: [{ id: "2", key: "A-2" }] },
      { startAt: 2, total: 3, issues: [{ id: "3", key: "A-3" }] },
    ];

    const fetchPage = vi.fn().mockImplementation(async (cursor) => {
      const idx = cursor.page - 1;
      return pages[idx];
    });

    const res = await paginate(fetchPage, 5);

    expect(fetchPage).toHaveBeenCalledTimes(3);
    expect(res).toEqual({
      startAt: 0,
      total: 3,
      issues: [
        { id: "1", key: "A-1" },
        { id: "2", key: "A-2" },
        { id: "3", key: "A-3" },
      ],
    });
  });

  it("follows nextPageToken with isLast until isLast is true", async () => {
    // nextPageToken com isLast
    const pages = [
      { nextPageToken: "tok-2", isLast: false, values: ["item-1", "item-2"] },
      { nextPageToken: "tok-3", isLast: false, values: ["item-3", "item-4"] },
      { isLast: true, values: ["item-5"] },
    ];

    const fetchPage = vi.fn().mockImplementation(async (cursor) => {
      const idx = cursor.page - 1;
      return pages[idx];
    });

    const res = await paginate(fetchPage, 10);

    expect(fetchPage).toHaveBeenCalledTimes(3);
    expect(res).toEqual({
      values: ["item-1", "item-2", "item-3", "item-4", "item-5"],
      isLast: true,
    });
  });

  it("enforces fixed 20-page limit even when pageLimit is higher", async () => {
    // limite de 20 páginas
    const fetchPage = vi.fn().mockImplementation(async (cursor) => {
      return {
        startAt: (cursor.page - 1) * 10,
        total: 500,
        issues: [{ id: String(cursor.page) }],
      };
    });

    const res = await paginate(fetchPage, 25);

    expect(fetchPage).toHaveBeenCalledTimes(20);
    expect((res as any).issues).toHaveLength(20);
  });

  it("stops at 5th page when page_limit is 5", async () => {
    // page_limit 5 para na 5ª
    const fetchPage = vi.fn().mockImplementation(async (cursor) => {
      return {
        startAt: (cursor.page - 1) * 10,
        total: 100,
        issues: [{ id: String(cursor.page) }],
      };
    });

    const res = await paginate(fetchPage, 5);

    expect(fetchPage).toHaveBeenCalledTimes(5);
    expect((res as any).issues).toHaveLength(5);
  });

  it("truncates response and sets truncated: true when maxBytes is exceeded", async () => {
    const fetchPage = vi.fn().mockImplementation(async (cursor) => {
      return {
        startAt: (cursor.page - 1) * 10,
        total: 100,
        issues: [
          { id: String(cursor.page), data: "x".repeat(300) },
        ],
      };
    });

    // maxBytes = 500 bytes
    const res = await paginate(fetchPage, 10, { maxBytes: 500 });

    expect((res as any).truncated).toBe(true);
    expect(fetchPage.mock.calls.length).toBeLessThan(10);
  });
});

describe("ToolsService integration with pagination, adf and response_fields", () => {
  it("given page_limit missing, Then makes only one call as before", async () => {
    const dbTool: ToolEntry = {
      name: "jira_search",
      title: "Jira Search",
      description: "Search issues",
      kind: "request",
      params: {
        jql: { type: "string", required: true },
        page_limit: { type: "integer", required: false },
      },
      writes: false,
      expose: true,
      notePath: "mcp.db",
      noteName: "jira_search",
      request: "req_search",
      status: "ready",
      problems: [],
      warnings: [],
    };

    let callCount = 0;
    const dbManagerMock = {
      getRequestForTool: () => undefined,
      getRequestNote: (name: string) => {
        if (name === "jira_search") {
          const note: VaultNote = {
            path: "mcp.db",
            name: "req_search",
            frontmatter: { method: "GET", path: "/rest/api/3/search" },
            tags: [],
          };
          return {
            note,
            body: "```http\nGET https://acme.atlassian.net/rest/api/3/search?jql={{param:jql}}\n```",
          };
        }
        return undefined;
      },
      getResponseFieldsForTool: () => undefined,
    };

    const source = new MemorySource();
    const registry = new ToolRegistry(source, () => ({ enabled: true, toolTag: "mcp/tool", scriptsEnabled: true }), () => [dbTool]);
    const broker = {
      execute: vi.fn().mockImplementation(async () => {
        callCount++;
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ startAt: 0, total: 30, issues: [{ id: "1" }] }),
          truncated: false,
          redactions: [],
        };
      }),
      listSecrets: () => ({ ok: true, secrets: [] }),
    } as unknown as Broker;

    const service = new ToolsService({
      registry,
      source,
      broker,
      runner: new ScriptRunner(),
      audit: new AuditLog(),
      settings: () => defaultSettings,
      guide: () => "",
      dbManager: dbManagerMock as any,
    });

    await registry.refresh();

    // Call without page_limit
    const result = (await service.run("jira_search", { jql: "project = TEST" }, client)) as any;

    expect(callCount).toBe(1);
    expect(result.json.issues).toHaveLength(1);
  });

  it("given response_fields in db, Then response brings only those fields; without response_fields, equal as before", async () => {
    // Tool with response_fields
    const dbToolWithFields: ToolEntry = {
      name: "jira_get_issue_projected",
      title: "Get Issue Projected",
      description: "Gets issue with projected fields",
      kind: "request",
      params: { id: { type: "string", required: true } },
      writes: false,
      expose: true,
      notePath: "mcp.db",
      noteName: "jira_get_issue_projected",
      request: "req_issue_proj",
      responseFields: ["key", "fields.summary"],
      status: "ready",
      problems: [],
      warnings: [],
    };

    // Tool without response_fields
    const dbToolWithoutFields: ToolEntry = {
      name: "jira_get_issue_raw",
      title: "Get Issue Raw",
      description: "Gets issue raw",
      kind: "request",
      params: { id: { type: "string", required: true } },
      writes: false,
      expose: true,
      notePath: "mcp.db",
      noteName: "jira_get_issue_raw",
      request: "req_issue_raw",
      status: "ready",
      problems: [],
      warnings: [],
    };

    const rawPayload = {
      id: "1001",
      key: "PROJ-1",
      extra: "should be omitted in projected",
      fields: {
        summary: "Important bug",
        description: "Long details",
        assignee: "alice",
      },
    };

    const dbManagerMock = {
      getRequestForTool: () => undefined,
      getRequestNote: (name: string) => {
        const note: VaultNote = {
          path: "mcp.db",
          name: name,
          frontmatter: { method: "GET", path: "/rest/api/3/issue" },
          tags: [],
        };
        return {
          note,
          body: "```http\nGET https://acme.atlassian.net/rest/api/3/issue/{{param:id}}\n```",
        };
      },
      getResponseFieldsForTool: (name: string) => {
        if (name === "jira_get_issue_projected") return ["key", "fields.summary"];
        return undefined;
      },
    };

    const source = new MemorySource();
    const registry = new ToolRegistry(
      source,
      () => ({ enabled: true, toolTag: "mcp/tool", scriptsEnabled: true }),
      () => [dbToolWithFields, dbToolWithoutFields],
    );
    const broker = {
      execute: vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: "OK",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(rawPayload),
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
      settings: () => defaultSettings,
      guide: () => "",
      dbManager: dbManagerMock as any,
    });

    await registry.refresh();

    // Call tool with response_fields
    const projectedRes = (await service.run("jira_get_issue_projected", { id: "PROJ-1" }, client)) as any;
    expect(projectedRes.json).toEqual({
      key: "PROJ-1",
      fields: {
        summary: "Important bug",
      },
    });

    // Call tool without response_fields
    const rawRes = (await service.run("jira_get_issue_raw", { id: "PROJ-1" }, client)) as any;
    expect(rawRes.json).toEqual(rawPayload);
  });

  it("converts ADF when adf is 'text', and keeps intact when adf is omitted or different", async () => {
    const dbTool: ToolEntry = {
      name: "jira_get_issue_adf",
      title: "Get Issue ADF",
      description: "Gets issue with adf parameter",
      kind: "request",
      params: {
        id: { type: "string", required: true },
        adf: { type: "string", required: false },
      },
      writes: false,
      expose: true,
      notePath: "mcp.db",
      noteName: "jira_get_issue_adf",
      request: "req_issue_adf",
      status: "ready",
      problems: [],
      warnings: [],
    };

    const adfDoc = {
      type: "doc",
      version: 1,
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "texto", marks: [{ type: "strong" }] },
            { type: "text", text: " " },
            { type: "text", text: "rótulo", marks: [{ type: "link", attrs: { href: "https://example.com" } }] },
          ],
        },
      ],
    };

    const dbManagerMock = {
      getRequestForTool: () => undefined,
      getRequestNote: () => ({
        note: {
          path: "mcp.db",
          name: "req_issue_adf",
          frontmatter: { method: "GET", path: "/rest/api/3/issue" },
          tags: [],
        },
        body: "```http\nGET https://acme.atlassian.net/rest/api/3/issue/{{param:id}}\n```",
      }),
      getResponseFieldsForTool: () => undefined,
    };

    const source = new MemorySource();
    const registry = new ToolRegistry(source, () => ({ enabled: true, toolTag: "mcp/tool", scriptsEnabled: true }), () => [dbTool]);
    const broker = {
      execute: vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: "OK",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key: "TEST-1", fields: { description: adfDoc } }),
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
      settings: () => defaultSettings,
      guide: () => "",
      dbManager: dbManagerMock as any,
    });

    await registry.refresh();

    // adf: "text"
    const textRes = (await service.run("jira_get_issue_adf", { id: "TEST-1", adf: "text" }, client)) as any;
    expect(textRes.json.fields.description).toBe("**texto** [rótulo](https://example.com)");

    // adf omitted -> intact
    const intactRes = (await service.run("jira_get_issue_adf", { id: "TEST-1" }, client)) as any;
    expect(intactRes.json.fields.description).toEqual(adfDoc);
  });
});
