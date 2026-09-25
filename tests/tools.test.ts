import { describe, expect, it } from "vitest";
import { extractCodeBlock, inputSchema, parseToolNote, validateArgs } from "../src/tools/definition";
import { buildGuide, GuideMode } from "../src/tools/guide";
import { ToolRegistry } from "../src/tools/registry";
import { parseRequestBlock, resolveRequest } from "../src/tools/requestNote";
import { hasTag, linkTarget, ToolError, VaultNote } from "../src/tools/types";
import { fence, MemorySource } from "./toolHelpers";

const note = (frontmatter: Record<string, unknown>, body = "", name = "My tool"): Parameters<typeof parseToolNote>[0] => ({
  path: `Tools/${name}.md`,
  name,
  frontmatter,
  tags: ["mcp/tool"],
  body,
});

describe("tool notes", () => {
  it("parses a request tool", () => {
    const t = parseToolNote(
      note({
        tool: "jira_get_issue",
        kind: "request",
        request: "[[Jira - Get issue]]",
        description: "Gets an issue.",
        params: { key: { type: "string", required: true, description: "Issue key" }, max: "integer" },
        writes: false,
      }),
    );
    expect(t.problems).toEqual([]);
    expect(t.kind).toBe("request");
    expect(t.params.key).toEqual({ type: "string", required: true, description: "Issue key" });
    expect(t.params.max).toEqual({ type: "integer", required: false });
    expect(t.expose).toBe(true);
  });

  it("parses a script tool and extracts the js block", () => {
    const body = `Some text\n\n${fence}js\nexport default async function (ctx) {\n  return 1;\n}\n${fence}\n`;
    const t = parseToolNote(note({ tool: "digest", kind: "script", description: "d" }, body));
    expect(t.problems).toEqual([]);
    expect(t.code).toContain("export default async function");
  });

  it("collects every problem", () => {
    const t = parseToolNote(note({ tool: "Bad Name", kind: "other", params: { "x y": { type: "string" }, n: { type: "float" } } }));
    expect(t.problems.join(" ")).toMatch(/Invalid tool name/);
    expect(t.problems.join(" ")).toMatch(/description/);
    expect(t.problems.join(" ")).toMatch(/Invalid kind/);
    expect(t.problems.join(" ")).toMatch(/Invalid parameter name/);
    expect(t.problems.join(" ")).toMatch(/invalid type "float"/);
  });

  it("rejects reserved names and scripts that import", () => {
    expect(parseToolNote(note({ tool: "http_request", kind: "request", request: "x", description: "d" })).problems.join()).toMatch(/reserved/);
    const body = `${fence}js\nimport fs from "fs";\nexport default async () => 1;\n${fence}`;
    expect(parseToolNote(note({ tool: "a", kind: "script", description: "d" }, body)).problems.join()).toMatch(/cannot import/);
  });

  it("validates arguments and applies defaults", () => {
    const params = { key: { type: "string" as const, required: true }, n: { type: "integer" as const, required: false, default: 5 }, e: { type: "string" as const, required: false, enum: ["a", "b"] } };
    expect(validateArgs(params, { key: "X" })).toEqual({ ok: true, args: { key: "X", n: 5 } });
    expect(validateArgs(params, {}).ok).toBe(false);
    expect(validateArgs(params, { key: "X", n: 1.5 }).ok).toBe(false);
    expect(validateArgs(params, { key: "X", e: "c" }).ok).toBe(false);
    expect(validateArgs(params, { key: "X", other: 1 }).ok).toBe(false);
    expect(inputSchema(params)).toMatchObject({ type: "object", required: ["key"], additionalProperties: false });
  });

  it("reads links and tags", () => {
    expect(linkTarget("[[Jira - ACME|alias]]")).toBe("Jira - ACME");
    expect(linkTarget("[[Note#Heading]]")).toBe("Note");
    expect(hasTag(["mcp/tool/jira"], "#mcp/tool")).toBe(true);
    expect(hasTag(["mcp/toolbox"], "mcp/tool")).toBe(false);
    expect(extractCodeBlock("no code", ["js"])).toBeNull();
  });
});

describe("request notes", () => {
  const service: VaultNote = { path: "S.md", name: "Jira - ACME", frontmatter: { url: "https://acme.atlassian.net", auth: "{{basic:JIRA_ACME}}" }, tags: [] };
  const body = [
    "Doc",
    `${fence}http`,
    "GET {{service.url}}/rest/api/3/issue/{{param:key}}?fields={{param:fields}}&expand=names",
    "Authorization: {{service.auth}}",
    "Accept: application/json",
    fence,
  ].join("\n");

  it("fills service properties and encodes parameters", () => {
    const req = resolveRequest(parseRequestBlock(body), { params: { key: "A/B 1", fields: "summary,status" }, service });
    expect(req.url).toBe("https://acme.atlassian.net/rest/api/3/issue/A%2FB%201?fields=summary%2Cstatus&expand=names");
    expect(req.headers).toEqual({ Authorization: "{{basic:JIRA_ACME}}", Accept: "application/json" });
    expect(req.method).toBe("GET");
  });

  it("drops a query pair whose optional parameter is missing", () => {
    const req = resolveRequest(parseRequestBlock(body), { params: { key: "A-1" }, service });
    expect(req.url).toBe("https://acme.atlassian.net/rest/api/3/issue/A-1?expand=names");
  });

  it("refuses secret placeholders in arguments", () => {
    expect(() => resolveRequest(parseRequestBlock(body), { params: { key: "{{secret:OTHER}}" }, service })).toThrow(ToolError);
    expect(() => resolveRequest(parseRequestBlock(body), { params: { key: "x", fields: { a: "{{bearer:X}}" } as unknown as string }, service })).toThrow(/secret placeholder/);
  });

  it("escapes strings in JSON bodies and keeps numbers and objects raw", () => {
    const post = [`${fence}http`, "POST https://api.example.com/items", "Content-Type: application/json", "", '{ "title": "{{param:title}}", "n": {{param:n}}, "meta": {{param:meta}} }', fence].join("\n");
    const req = resolveRequest(parseRequestBlock(post), { params: { title: 'say "hi"\n', n: 3, meta: { a: [1] } } });
    expect(JSON.parse(req.body!)).toEqual({ title: 'say "hi"\n', n: 3, meta: { a: [1] } });
  });

  it("reports an invalid JSON body and missing service properties", () => {
    const post = [`${fence}http`, "POST https://api.example.com/items", "Content-Type: application/json", "", '{ "title": {{param:title}} }', fence].join("\n");
    expect(() => resolveRequest(parseRequestBlock(post), { params: { title: "unquoted" } })).toThrow(/not valid JSON/);
    const tpl = parseRequestBlock([`${fence}http`, "GET {{service.nope}}/x", fence].join("\n"));
    expect(() => resolveRequest(tpl, { params: {}, service })).toThrow(/no property "nope"/);
    expect(() => resolveRequest(tpl, { params: {} })).toThrow(/no service note/);
  });

  it("rejects malformed blocks", () => {
    expect(() => parseRequestBlock("no block")).toThrow(/no ```http block/);
    expect(() => parseRequestBlock(`${fence}http\nFETCH https://x\n${fence}`)).toThrow(/unsupported method/);
    expect(() => parseRequestBlock(`${fence}http\nGET https://x\nnot a header\n${fence}`)).toThrow(/invalid header line/);
  });
});

describe("registry", () => {
  function setup(scriptsEnabled = true) {
    const source = new MemorySource();
    const registry = new ToolRegistry(source, () => ({ enabled: true, toolTag: "mcp/tool", scriptsEnabled }));
    return { source, registry };
  }

  it("lists tools by tag with statuses", async () => {
    const { source, registry } = setup();
    source.add("A/get.md", { tags: ["mcp/tool"], tool: "get_x", kind: "request", request: "[[R]]", description: "d" });
    source.add("B/script.md", { tags: ["mcp/tool/sub"], tool: "script_x", kind: "script", description: "d" }, `${fence}js\nexport default async () => 1\n${fence}`);
    source.add("C/other.md", { tags: ["other"], tool: "ignored", kind: "request", request: "x", description: "d" });
    await registry.refresh();
    expect(registry.list().map((e) => [e.name, e.status])).toEqual([
      ["get_x", "ready"],
      ["script_x", "ready"], // no approval in the plugin: the AI client asks for permission
    ]);
  });

  it("marks duplicates invalid and reports scripts turned off", async () => {
    const { source, registry } = setup(false);
    source.add("a.md", { tags: ["mcp/tool"], tool: "dup", kind: "request", request: "x", description: "d" });
    source.add("b.md", { tags: ["mcp/tool"], tool: "dup", kind: "request", request: "y", description: "d" });
    source.add("c.md", { tags: ["mcp/tool"], tool: "s", kind: "script", description: "d" }, `${fence}js\nexport default () => 1\n${fence}`);
    await registry.refresh();
    expect(registry.list().filter((e) => e.name === "dup").every((e) => e.status === "invalid")).toBe(true);
    expect(registry.get("s")!.status).toBe("scripts-disabled");
  });

  it("notifies only when something changed", async () => {
    const { source, registry } = setup();
    let calls = 0;
    registry.onChange(() => calls++);
    source.add("a.md", { tags: ["mcp/tool"], tool: "a", kind: "request", request: "x", description: "d" });
    await registry.refresh();
    await registry.refresh();
    expect(calls).toBe(1);
  });
});

describe("agent guide", () => {
  const modes: GuideMode[] = ["setup", "single", "multiple"];

  it("keeps the mandatory workflow in every prompt and language", () => {
    for (const lang of ["pt", "en"] as const) {
      for (const mode of modes) {
        const text = buildGuide(lang, "tools for Google Drive", mode);
        expect(text).not.toMatch(/%[A-Z_]+%/);
        expect(text).toContain("tools for Google Drive");
        expect(text).toContain("OAuth");
        expect(text).toContain("service_tag");
      }
    }
    const pt = buildGuide("pt");
    expect(pt).toContain("pergunte ao usuário antes de montar o plano");
    expect(pt).toContain("Plano de Implementação");
    expect(pt).toContain("espere a aprovação explícita do usuário");
    expect(pt).toContain("As notas que você cria são genéricas");
    expect(pt).toContain("Segredos que permitem qualquer domínio: peça autorização sempre");
    const en = buildGuide("en");
    expect(en).toContain("ask the user before writing the plan");
    expect(en).toContain("Implementation Plan");
    expect(en).toContain("wait for the user's explicit approval");
    expect(en).toContain("The notes you create are generic");
    expect(en).toContain("Secrets that allow any host: always ask for permission");
  });

  it("is generic: the same text on any computer, with nothing of the user's vault", () => {
    for (const lang of ["pt", "en"] as const) {
      for (const mode of modes) {
        const text = buildGuide(lang, undefined, mode);
        expect(text).not.toMatch(/(^|[\s`(])[A-Za-z]:[\/]|\/Users\/|\/home\//m); // no folder path
        expect(text).not.toMatch(/environment-variables-[a-z0-9]/); // no server name of a vault
        expect(text).not.toMatch(/mcp__environment-variables/);
        expect(text).toContain("list_vault_tools");
      }
    }
  });

  it("builds one prompt per task that ends with the mandatory question", () => {
    const titles = { setup: "# Setar o ambiente MCP", single: "# Adicionar uma ferramenta", multiple: "# Adicionar várias ferramentas" };
    for (const [mode, title] of Object.entries(titles) as Array<[GuideMode, string]>) {
      const text = buildGuide("pt", "meu pedido", mode);
      expect(text.startsWith(title)).toBe(true);
      expect(text).toContain("As notas que você cria são genéricas");
      const question = text.indexOf("## Pergunta obrigatória antes de criar qualquer coisa");
      expect(question).toBeGreaterThan(text.indexOf("## Pedido do usuário"));
      expect(text.indexOf("## Pedido do usuário")).toBeGreaterThan(text.indexOf("## 9."));
      expect(text.slice(question)).toContain("não siga com a criação");
    }
    expect(buildGuide("pt", "meu pedido", "setup")).toContain("Quais variáveis de ambiente (segredos) devem ser configuradas?");
    expect(buildGuide("pt", "meu pedido", "setup")).toContain("Para qual app ou serviço elas são?");
    expect(buildGuide("en", undefined, "setup")).toContain("do not go on with the creation");
    expect(buildGuide("pt")).toBe(buildGuide("pt", undefined, "setup"));
    expect(buildGuide("pt")).not.toContain("## Pedido do usuário");
    expect(buildGuide("pt", undefined, "single")).toContain("Plano resumido em vez do modelo da seção 8");
    expect(buildGuide("en", undefined, "single")).toContain("Short plan instead of the template in section 8");
    expect(buildGuide("en", undefined, "multiple")).toContain("one row per tool");
  });
});
