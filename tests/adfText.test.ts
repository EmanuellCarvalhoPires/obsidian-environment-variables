import { describe, expect, it } from "vitest";
import { adfToMarkdown, convertAdfFields } from "../src/tools/adfText";

describe("adfText unit tests", () => {
  describe("adfToMarkdown", () => {
    it("converts paragraph with bold and link to markdown correctly", () => {
      // Given ADF with paragraph in bold and a link, Then adfToMarkdown returns **texto** [rótulo](url) in the right place.
      const node = {
        type: "paragraph",
        content: [
          { type: "text", text: "texto", marks: [{ type: "strong" }] },
          { type: "text", text: " " },
          { type: "text", text: "rótulo", marks: [{ type: "link", attrs: { href: "url" } }] },
        ],
      };

      expect(adfToMarkdown(node)).toBe("**texto** [rótulo](url)");
    });

    it("converts heading level 2 correctly", () => {
      const node = {
        type: "heading",
        attrs: { level: 2 },
        content: [{ type: "text", text: "Título Nível 2" }],
      };

      expect(adfToMarkdown(node)).toBe("## Título Nível 2");
    });

    it("converts bullet list and ordered list correctly", () => {
      const bulletList = {
        type: "bulletList",
        content: [
          {
            type: "listItem",
            content: [{ type: "paragraph", content: [{ type: "text", text: "Primeiro item" }] }],
          },
          {
            type: "listItem",
            content: [{ type: "paragraph", content: [{ type: "text", text: "Segundo item" }] }],
          },
        ],
      };

      expect(adfToMarkdown(bulletList)).toBe("- Primeiro item\n- Segundo item");

      const orderedList = {
        type: "orderedList",
        content: [
          {
            type: "listItem",
            content: [{ type: "paragraph", content: [{ type: "text", text: "Passo 1" }] }],
          },
          {
            type: "listItem",
            content: [{ type: "paragraph", content: [{ type: "text", text: "Passo 2" }] }],
          },
        ],
      };

      expect(adfToMarkdown(orderedList)).toBe("1. Passo 1\n2. Passo 2");
    });

    it("converts code block with language correctly", () => {
      const node = {
        type: "codeBlock",
        attrs: { language: "typescript" },
        content: [{ type: "text", text: "const answer = 42;" }],
      };

      expect(adfToMarkdown(node)).toBe("```typescript\nconst answer = 42;\n```");
    });

    it("handles unknown node by returning children's text without error", () => {
      // Given unknown node with text children, Then returns the children's text, without error.
      const unknownNode = {
        type: "customWidgetOrPanel",
        attrs: { color: "blue" },
        content: [
          { type: "text", text: "Texto do filho 1 " },
          { type: "text", text: "e filho 2" },
        ],
      };

      expect(adfToMarkdown(unknownNode)).toBe("Texto do filho 1 e filho 2");
    });

    it("handles italic, inline code, mentions, and hard breaks", () => {
      const node = {
        type: "paragraph",
        content: [
          { type: "text", text: "itálico", marks: [{ type: "em" }] },
          { type: "hardBreak" },
          { type: "text", text: "código", marks: [{ type: "code" }] },
          { type: "text", text: " com " },
          { type: "mention", attrs: { id: "user-123", text: "@maria" } },
        ],
      };

      expect(adfToMarkdown(node)).toBe("*itálico*\n`código` com @maria");
    });

    it("converts doc root separating blocks with double newline", () => {
      const doc = {
        type: "doc",
        version: 1,
        content: [
          {
            type: "heading",
            attrs: { level: 1 },
            content: [{ type: "text", text: "Header" }],
          },
          {
            type: "paragraph",
            content: [{ type: "text", text: "First paragraph" }],
          },
        ],
      };

      expect(adfToMarkdown(doc)).toBe("# Header\n\nFirst paragraph");
    });
  });

  describe("convertAdfFields", () => {
    it("converts ADF fields at specified paths", () => {
      const obj = {
        key: "JIRA-123",
        fields: {
          summary: "Summary text",
          description: {
            type: "doc",
            version: 1,
            content: [
              {
                type: "paragraph",
                content: [{ type: "text", text: "Descricao em ", marks: [{ type: "strong" }] }],
              },
            ],
          },
        },
      };

      const result = convertAdfFields(obj, ["fields.description"]) as typeof obj;
      expect(result.key).toBe("JIRA-123");
      expect(result.fields.summary).toBe("Summary text");
      expect(result.fields.description).toBe("**Descricao em **");
    });

    it("converts ADF fields without paths by auto-detecting doc roots", () => {
      const obj = {
        key: "JIRA-123",
        fields: {
          description: {
            type: "doc",
            version: 1,
            content: [
              {
                type: "paragraph",
                content: [{ type: "text", text: "Auto converted" }],
              },
            ],
          },
        },
      };

      const result = convertAdfFields(obj) as any;
      expect(result.fields.description).toBe("Auto converted");
    });

    it("leaves non-ADF fields and missing fields intact", () => {
      const obj = {
        key: "JIRA-123",
        status: "Done",
        plainText: "Already text",
      };

      const result = convertAdfFields(obj, ["plainText", "missing"]);
      expect(result).toEqual(obj);
    });
  });
});
