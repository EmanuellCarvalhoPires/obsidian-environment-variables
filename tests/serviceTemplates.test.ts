import { describe, expect, it } from "vitest";
import { SERVICE_TEMPLATES, serviceTemplateFor, templatesToCreate, templateText } from "../src/tools/serviceTemplates";
import { VaultNote } from "../src/tools/types";

const note = (path: string, tags: string[]): VaultNote => ({ path, name: path, tags, frontmatter: {} });

describe("service templates", () => {
  it("bundles one template per service, in both languages, tagged with its service and template", () => {
    expect(SERVICE_TEMPLATES.map((t) => t.serviceTag)).toEqual(["atlassian/instance", "bitbucket/workspace", "trello/account"]);
    for (const template of SERVICE_TEMPLATES) {
      for (const lang of ["en", "pt"] as const) {
        const text = templateText(template, lang);
        expect(text.startsWith("---\ntags:\n")).toBe(true);
        expect(text).toContain(`  - ${template.serviceTag}\n  - template\n`);
        expect(text).toContain("auth_token:");
        expect(text).not.toContain("\r");
        expect(text).not.toMatch(/\{\{(secret|basic|bearer):(?!NAME\}\}|NOME\}\})/); // only NAME/NOME examples, no real key
      }
    }
    expect(templateText(serviceTemplateFor("bitbucket/workspace")!, "pt")).toContain("## Como preencher");
    expect(templateText(serviceTemplateFor("bitbucket/workspace")!, "en")).toContain("## How to fill it in");
  });

  it("creates only the templates never created and missing from the vault", () => {
    const vault: Record<string, VaultNote[]> = {
      "atlassian/instance": [note("Jira Access - Template.md", ["atlassian/instance", "template"])],
      "bitbucket/workspace": [note("Bitbucket Access - Company.md", ["bitbucket/workspace"])],
    };
    const notesOf = (tag: string) => vault[tag] ?? [];
    expect(templatesToCreate([], notesOf).map((t) => t.id)).toEqual(["bitbucket", "trello"]);
    expect(templatesToCreate(["trello"], notesOf).map((t) => t.id)).toEqual(["bitbucket"]);
    expect(templatesToCreate(["atlassian", "bitbucket", "trello"], () => [])).toEqual([]);
  });
});
