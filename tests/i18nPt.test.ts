import { describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({ getLanguage: () => "pt-BR" }));

const { ptBR, setLanguage, t } = await import("../src/i18n");

describe("Portuguese (pt-BR) localization", () => {
  it("has the expected recovery title", () => {
    setLanguage("pt-BR");
    expect(t("view.recovery.showTitle")).toBe("Guarde sua chave de recuperação");
    expect(ptBR["view.recovery.showTitle"]).toBe("Guarde sua chave de recuperação");
  });

  it("contains 'área de transferência' in recovery.copied", () => {
    setLanguage("pt-BR");
    expect(t("view.recovery.copied")).toContain("área de transferência");
    expect(ptBR["view.recovery.copied"]).toContain("área de transferência");
  });

  it("does not contain corrupted letter-?-letter pattern in any pt string", () => {
    const entries = Object.entries(ptBR);
    expect(entries.length).toBeGreaterThan(0);
    for (const [key, text] of entries) {
      if (typeof text === "string") {
        expect(text, `Key "${key}" contains corrupted letter-?-letter`).not.toMatch(/\w\?\w/);
      }
    }
  });

  it("does not contain question marks mid-word in recovery screen texts", () => {
    setLanguage("pt-BR");
    const recoveryKeys = [
      "view.recovery.showTitle",
      "view.recovery.showBody",
      "view.recovery.copy",
      "view.recovery.copied",
      "view.recovery.savedConfirmation",
      "view.forgot.title",
      "view.forgot.recoverTab",
      "view.forgot.resetTab",
      "view.forgot.recoverDesc",
      "view.forgot.recoveryCode",
      "view.forgot.resetDesc",
      "view.forgot.resetWarning",
      "view.forgot.resetButton",
      "view.forgot.resetSuccess",
    ] as const;

    for (const key of recoveryKeys) {
      const text = t(key);
      expect(text, `Recovery key "${key}" contains corrupted letter-?-letter`).not.toMatch(/\w\?\w/);
      expect(text, `Recovery key "${key}" contains double question mark`).not.toContain("??");
    }
  });
});
