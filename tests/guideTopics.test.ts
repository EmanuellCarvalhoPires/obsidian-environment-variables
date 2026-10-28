import { describe, expect, it } from "vitest";
import { buildGuide, guideIndex, guideTopic, guideTopics } from "../src/tools/guide";
import { ToolsService } from "../src/tools/service";
import { ToolRegistry } from "../src/tools/registry";
import { Broker } from "../src/secrets/broker";
import { ScriptRunner } from "../src/tools/scriptRunner";
import { AuditLog } from "../src/audit/auditLog";
import { handleMcpMessage } from "../src/server/mcp";
import { ClientContext } from "../src/server/clients";
import { MemorySource } from "./toolHelpers";

describe("Guide topics and indexing (Item 22)", () => {
  it("produces an index under 1,500 characters listing all slugs and the reading prompt", () => {
    for (const lang of ["en", "pt"] as const) {
      const index = guideIndex(lang);
      expect(index.length).toBeLessThan(1500);
      expect(index).toContain("Pass topic: <slug> to read a section.");

      const topics = guideTopics(lang);
      expect(topics.length).toBeGreaterThanOrEqual(6);
      for (const topic of topics) {
        expect(index).toContain(topic.slug);
        expect(index).toContain(topic.title);
      }
    }
  });

  it("returns non-empty content for each valid slug", () => {
    for (const lang of ["en", "pt"] as const) {
      const topics = guideTopics(lang);
      for (const { slug } of topics) {
        const content = guideTopic(lang, slug);
        expect(typeof content).toBe("string");
        expect(content.trim().length).toBeGreaterThan(0);
        expect(content).toContain("## ");
      }
    }
  });

  it("throws an error with the list of valid slugs for an invalid slug", () => {
    for (const lang of ["en", "pt"] as const) {
      const topics = guideTopics(lang);
      const invalidSlug = "invalid-non-existent-topic";
      expect(() => guideTopic(lang, invalidSlug)).toThrowError();

      try {
        guideTopic(lang, invalidSlug);
        expect.unreachable("Should have thrown");
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        expect(message).toContain("Unknown guide topic");
        expect(message).toContain(invalidSlug);
        for (const { slug } of topics) {
          expect(message).toContain(slug);
        }
      }
    }
  });

  it("ensures pt and en have identical slugs in the same order", () => {
    const enSlugs = guideTopics("en").map((t) => t.slug);
    const ptSlugs = guideTopics("pt").map((t) => t.slug);

    expect(ptSlugs).toEqual(enSlugs);

    // Expected standard slugs from requirements
    const requiredSlugs = ["note-formats", "service-notes", "tools", "scripts", "security", "plan"];
    for (const req of requiredSlugs) {
      expect(enSlugs).toContain(req);
    }
  });

  it("keeps all mandatory security keywords present in the guides", () => {
    const keywords = ["allowed hosts", "{{secret:", "never", "approval"];
    const enGuide = buildGuide("en");
    for (const kw of keywords) {
      expect(enGuide.toLowerCase()).toContain(kw.toLowerCase());
    }

    // Also check inside the security topic itself
    const enSecurity = guideTopic("en", "security");
    expect(enSecurity).toContain("allowed hosts");
    expect(enSecurity).toContain("{{secret:");
    expect(enSecurity).toContain("never");

    const ptSecurity = guideTopic("pt", "security");
    expect(ptSecurity).toContain("hosts permitidos");
    expect(ptSecurity).toContain("{{secret:");
    expect(ptSecurity).toContain("nunca");
    expect(ptSecurity).toContain("autorização");
  });

  describe("BDD criteria", () => {
    function setupTools(lang: "en" | "pt" = "en") {
      const source = new MemorySource();
      const registry = new ToolRegistry(
        source,
        () => ({ enabled: true, toolTag: "mcp/tool", scriptsEnabled: false }),
      );
      const broker = {} as Broker;
      const runner = new ScriptRunner();
      const audit = new AuditLog();
      const client: ClientContext = { id: "test-client", name: "test", access: { mode: "all" } };

      const guide = (topic?: string) => (topic ? guideTopic(lang, topic) : guideIndex(lang));
      const tools = new ToolsService({
        registry,
        source,
        broker,
        runner,
        audit,
        settings: () => ({
          toolsEnabled: true,
          scriptsEnabled: false,
          toolTag: "mcp/tool",
          requestTag: "api/request",
          scriptTimeoutSeconds: 30,
          maxResponseMB: 10,
        }),
        guide,
      });

      return { tools, client, guide, broker };
    }

    it("Dado get_tool_authoring_guide sem topic, Então a resposta tem menos de 1.500 caracteres e lista os slugs", async () => {
      const { tools, client } = setupTools("en");
      const res = await tools.callMcp("get_tool_authoring_guide", {}, client);
      expect(res.isError).toBe(false);
      expect(res.text).toBeDefined();
      expect(res.text!.length).toBeLessThan(1500);
      expect(res.text).toContain("security");
      expect(res.text).toContain("plan");
      expect(res.text).toContain("Pass topic: <slug> to read a section.");
    });

    it("Dado topic 'security', Então devolve só a seção de segurança", async () => {
      const { tools, client } = setupTools("en");
      const res = await tools.callMcp("get_tool_authoring_guide", { topic: "security" }, client);
      expect(res.isError).toBe(false);
      expect(res.text).toBeDefined();
      expect(res.text).toContain("Mandatory security rules");
      expect(res.text).toContain("allowed hosts");
      // Does not contain other topic headings
      expect(res.text).not.toContain("## Implementation Plan template");
      expect(res.text).not.toContain("## Script tools and ctx API");
    });

    it("Dado topic inexistente, Então erro com a lista de slugs", async () => {
      const { tools, client } = setupTools("en");
      const res = await tools.callMcp("get_tool_authoring_guide", { topic: "unknown-topic-xyz" }, client);
      expect(res.isError).toBe(true);
      const errorMsg = JSON.stringify(res.value);
      expect(errorMsg).toContain("Unknown guide topic");
      expect(errorMsg).toContain("security");
      expect(errorMsg).toContain("plan");
    });

    it("Dado configure_vault_tools com topic, Então devolve a mesma seção", async () => {
      const { tools, client, broker } = setupTools("en");
      const guideText = (req?: string, top?: string) => (top ? guideTopic("en", top) : req ? buildGuide("en", req) : guideIndex("en"));

      const ctx = {
        broker,
        client,
        version: "2.3.1",
        tools,
        guide: guideText,
      };

      const promptRes = (await handleMcpMessage(
        {
          jsonrpc: "2.0",
          id: 1,
          method: "prompts/get",
          params: { name: "configure_vault_tools", arguments: { topic: "security" } },
        },
        ctx,
      )) as { result?: { messages: Array<{ content: { text: string } }> } };

      const toolRes = await tools.callMcp("get_tool_authoring_guide", { topic: "security" }, client);

      expect(promptRes.result?.messages[0].content.text).toBe(toolRes.text);
    });
  });
});
