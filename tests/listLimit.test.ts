import { beforeEach, describe, expect, it } from "vitest";
import { AuditLog } from "../src/audit/auditLog";
import { Broker } from "../src/secrets/broker";
import { ClientContext } from "../src/server/clients";
import { ToolRegistry } from "../src/tools/registry";
import { ScriptRunner } from "../src/tools/scriptRunner";
import { ToolsService, ToolsSettings } from "../src/tools/service";
import { fence, MemorySource } from "./toolHelpers";

const settings: ToolsSettings = {
  toolsEnabled: true,
  scriptsEnabled: true,
  toolTag: "mcp/tool",
  requestTag: "api/request",
  scriptTimeoutSeconds: 5,
  maxResponseMB: 1,
};

describe("list_vault_tools limit/offset and repeated hint reduction (Item 23)", () => {
  let source: MemorySource;
  let registry: ToolRegistry;
  let toolsService: ToolsService;
  const clientA: ClientContext = { id: "client-a", name: "Client A", access: { mode: "all" } };
  const clientB: ClientContext = { id: "client-b", name: "Client B", access: { mode: "all" } };

  beforeEach(async () => {
    source = new MemorySource();
    source.add("Services/Svc.md", { url: "https://api.example.com" });
    source.add(
      "Requests/Req.md",
      { tags: ["api/request"], service: "[[Svc]]" },
      [`${fence}http`, "POST {{service.url}}/items", "Content-Type: application/json", "", "{}", fence].join("\n"),
    );

    // Register 5 tools in order
    for (let i = 1; i <= 5; i++) {
      source.add(`Tools/tool_${i}.md`, {
        tags: ["mcp/tool"],
        tool: `tool_${i}`,
        title: `Tool ${i}`,
        kind: "request",
        request: "[[Req]]",
        description: `Tool number ${i}`,
        params: { id: { type: "string", required: true } },
        writes: false,
        expose: true,
      });
    }

    const broker = {
      execute: async () => ({
        ok: true,
        status: 200,
        statusText: "OK",
        headers: { "content-type": "application/json" },
        body: "{}",
        truncated: false,
        redactions: [],
      }),
      listSecrets: () => ({ ok: true, secrets: [] }),
    } as unknown as Broker;

    registry = new ToolRegistry(source, () => ({ enabled: true, toolTag: settings.toolTag, scriptsEnabled: true }));
    toolsService = new ToolsService({
      registry,
      source,
      broker,
      runner: new ScriptRunner(),
      audit: new AuditLog(),
      settings: () => settings,
      guide: () => "guide",
    });

    await registry.refresh();
  });

  it("Dado list_vault_tools limit 2 de 5 tools, Então 2 tools, total 5, next_offset 2", async () => {
    // Via status() directly
    const res = toolsService.status({ limit: 2 });
    expect(res.total).toBe(5);
    expect(Array.isArray(res.tools)).toBe(true);
    expect((res.tools as unknown[]).length).toBe(2);
    expect(res.next_offset).toBe(2);

    // Via callMcp dispatch
    const mcpRes = await toolsService.callMcp("list_vault_tools", { limit: 2 }, clientA);
    expect(mcpRes.isError).toBe(false);
    const val = mcpRes.value as Record<string, unknown>;
    expect(val.total).toBe(5);
    expect((val.tools as unknown[]).length).toBe(2);
    expect(val.next_offset).toBe(2);
  });

  it("Dado offset 4 e limit 2, Então a 5ª tool e next_offset null", async () => {
    // Via status() directly
    const res = toolsService.status({ offset: 4, limit: 2 });
    expect(res.total).toBe(5);
    const tools = res.tools as Array<{ name: string }>;
    expect(tools.length).toBe(1);
    expect(tools[0].name).toBe("tool_5");
    expect(res.next_offset).toBeNull();

    // Via callMcp dispatch
    const mcpRes = await toolsService.callMcp("list_vault_tools", { offset: 4, limit: 2 }, clientA);
    expect(mcpRes.isError).toBe(false);
    const val = mcpRes.value as Record<string, unknown>;
    expect(val.total).toBe(5);
    const mcpTools = val.tools as Array<{ name: string }>;
    expect(mcpTools.length).toBe(1);
    expect(mcpTools[0].name).toBe("tool_5");
    expect(val.next_offset).toBeNull();
  });

  it("Dado limit 500, Então erro de validação (máximo 200)", async () => {
    // Directly throws ToolError
    expect(() => toolsService.status({ limit: 500 })).toThrow(/limit/i);

    // Via callMcp returns error
    const errRes = await toolsService.callMcp("list_vault_tools", { limit: 500 }, clientA);
    expect(errRes.isError).toBe(true);
    const val = errRes.value as { ok: boolean; error: { code: string; message: string } };
    expect(val.ok).toBe(false);
    expect(val.error.code).toBe("invalid_argument");
    expect(val.error.message).toMatch(/200/);
  });

  it("Dado a mesma tool duas vezes para o mesmo cliente, Então a segunda dica não traz message nem run", async () => {
    // First call for clientA: complete hint
    const hint1 = await toolsService.hintFor("POST", "https://api.example.com/items", clientA);
    expect(hint1).toBeDefined();
    expect(hint1?.tool).toBe("tool_1");
    expect((hint1 as any).endpoint).toBeDefined();
    expect((hint1 as any).run).toBeDefined();
    expect((hint1 as any).message).toBeDefined();

    // Second call for clientA: reduced hint with only { tool }
    const hint2 = await toolsService.hintFor("POST", "https://api.example.com/items", clientA);
    expect(hint2).toEqual({ tool: "tool_1" });
    expect((hint2 as any).endpoint).toBeUndefined();
    expect((hint2 as any).run).toBeUndefined();
    expect((hint2 as any).message).toBeUndefined();

    // First call for clientB: still receives the complete hint
    const hintB = await toolsService.hintFor("POST", "https://api.example.com/items", clientB);
    expect(hintB).toBeDefined();
    expect(hintB?.tool).toBe("tool_1");
    expect((hintB as any).endpoint).toBeDefined();
    expect((hintB as any).run).toBeDefined();
    expect((hintB as any).message).toBeDefined();
  });

  it("applies default limit 50 and default offset 0", () => {
    const res = toolsService.status();
    expect(res.total).toBe(5);
    expect((res.tools as unknown[]).length).toBe(5);
    expect(res.next_offset).toBeNull();
  });

  it("validates offset and limit boundaries", () => {
    expect(() => toolsService.status({ offset: -1 })).toThrow(/offset/i);
    expect(() => toolsService.status({ limit: 0 })).toThrow(/limit/i);
    expect(() => toolsService.status({ limit: 201 })).toThrow(/limit/i);
    expect(() => toolsService.status({ limit: 1.5 })).toThrow(/limit/i);
  });
});
