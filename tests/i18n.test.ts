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
