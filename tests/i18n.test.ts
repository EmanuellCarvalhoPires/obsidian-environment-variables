import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

let obsidianLanguage = "en";
vi.mock("obsidian", () => ({ getLanguage: () => obsidianLanguage }));

const { currentLanguage, setLanguage, t } = await import("../src/i18n");

describe("language", () => {
  afterEach(() => {
    setLanguage("auto");
    obsidianLanguage = "en";
  });

  it("follows Obsidian's language by default", () => {
    expect(currentLanguage()).toBe("en");
    expect(t("view.new")).toBe("New variable");
    obsidianLanguage = "pt-BR";
    expect(currentLanguage()).toBe("pt-BR");
    expect(t("view.new")).toBe("Nova variável");
    obsidianLanguage = "pt";
    expect(currentLanguage()).toBe("pt-BR");
    obsidianLanguage = "de";
    expect(currentLanguage()).toBe("en");
  });

  it("uses the language chosen in the settings, whatever Obsidian's language is", () => {
    obsidianLanguage = "pt-BR";
    setLanguage("en");
    expect(t("view.section.env")).toBe("Environment Variables");
    obsidianLanguage = "en";
    setLanguage("pt-BR");
    expect(t("view.section.env")).toBe("Variáveis de ambiente");
    expect(t("view.section.mcp")).toBe("Configurações do MCP local");
  });

  it("fills variables in both languages", () => {
    setLanguage("pt-BR");
    expect(t("view.log.show", { n: 3 })).toBe("Registros do log (3)");
    setLanguage("en");
    expect(t("view.log.show", { n: 3 })).toBe("Log entries (3)");
  });
});

describe("How to use", () => {
  it("shows the real tags, never translated", () => {
    for (const lang of ["en", "pt-BR"] as const) {
      setLanguage(lang);
      const tags = { toolTag: "mcp/tool", requestTag: "api/request" };
      expect(t("view.howto.toolsDesc", tags)).toContain("#mcp/tool");
      expect(t("view.howto.toolsDesc", tags)).toContain("#api/request");
      expect(t("view.howto.groupsDesc", tags)).toContain("#mcp/tool/jira");
      expect(t("view.howto.templatesDesc")).toContain("#template");
    }
    setLanguage("pt-BR");
    expect(t("view.howto.toolsDesc", { toolTag: "x", requestTag: "y" })).not.toContain("tag de ferramenta");
    setLanguage("en");
  });
});

describe("live activity texts", () => {
  /** The keys of one table in src/i18n.ts, read from the source: the tables are not exported. */
  function keysOf(table: "en" | "ptBR"): string[] {
    const source = readFileSync(new URL("../src/i18n.ts", import.meta.url), "utf8");
    const start = source.indexOf(table === "en" ? "const en = {" : "const ptBR: Partial<Record<Key, string>> = {");
    const end = source.indexOf("\n};", start);
    return [...source.slice(start, end).matchAll(/^ {2}"((?:act\.line|view\.act|cmd\.openActivity|view\.log\.live|view\.howto\.activity)[\w.]*)":/gm)].map((m) => m[1]);
  }

  it("has every activity text in both languages", () => {
    const en = keysOf("en");
    expect(en.length).toBeGreaterThan(60);
    expect(keysOf("ptBR").sort()).toEqual(en.sort());
  });

  it("keeps the same variables in both languages", () => {
    const vars = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const key of keysOf("en")) {
      setLanguage("en");
      const en = t(key as never, {});
      setLanguage("pt-BR");
      const pt = t(key as never, {});
      expect(vars(pt), key).toEqual(vars(en));
    }
    setLanguage("en");
  });

  it("shows the terminal lines in the chosen language", () => {
    setLanguage("pt-BR");
    expect(t("act.line.substituted", { where: "header Authorization", raw: "{{basic:A}}", mask: "Basic ********" })).toBe("header Authorization: {{basic:A}}  ->  Basic ********");
    expect(t("act.line.approvalWaiting")).toContain("aprovação");
    setLanguage("en");
    expect(t("act.line.approvalWaiting")).toContain("approval");
  });
});
