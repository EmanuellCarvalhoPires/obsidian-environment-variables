import { describe, expect, it } from "vitest";
import { appForEntry, fetchCatalog, fetchPackageManifest, filesToInstall, GithubReader, groupCatalogEntries, McpCatalogEntry, McpPackageManifest, needsServiceTemplate, serviceTemplateFileName } from "../src/tools/mcpCatalog";
import { VaultNote } from "../src/tools/types";

class FakeReader implements GithubReader {
  constructor(private readonly files: Record<string, string>) {}
  async fetchText(path: string): Promise<string> {
    const text = this.files[path];
    if (text === undefined) throw new Error(`404: ${path}`);
    return text;
  }
}

const MANIFEST: McpPackageManifest = {
  id: "jsm-assets",
  name: "JSM Assets MCP",
  tag: "api/app/assets",
  logo: "assets",
  index: "MCP - Assets.md",
  files: [
    { path: "MCP - Assets.md", kind: "index" },
    { path: "Tools/assets_get_object.md", kind: "tool", name: "assets_get_object", title: "Assets - GET object", writes: false, pair: "Requests/Assets - GET object.md" },
    { path: "Requests/Assets - GET object.md", kind: "request" },
    { path: "Tools/assets_delete_object.md", kind: "tool", name: "assets_delete_object", title: "Assets - DELETE object", writes: true, pair: null },
    { path: "Requests/Assets - Get tenant usage information.md", kind: "request-only" },
  ],
};

describe("mcpCatalog", () => {
  it("fetches and parses the top-level catalog", async () => {
    const reader = new FakeReader({
      "manifest.json": JSON.stringify({
        version: 1,
        packages: [{ id: "jsm-assets", name: "JSM Assets MCP", tag: "api/app/assets", logo: "assets", path: "packages/jsm-assets", toolCount: 60, requestOnlyCount: 1 }],
      }),
    });
    const catalog = await fetchCatalog(reader);
    expect(catalog.packages).toHaveLength(1);
    expect(catalog.packages[0].id).toBe("jsm-assets");
  });

  it("rejects a catalog without a packages list", async () => {
    const reader = new FakeReader({ "manifest.json": JSON.stringify({}) });
    await expect(fetchCatalog(reader)).rejects.toThrow();
  });

  it("fetches a package's own manifest", async () => {
    const reader = new FakeReader({ "packages/jsm-assets/manifest.json": JSON.stringify(MANIFEST) });
    const manifest = await fetchPackageManifest(reader, { path: "packages/jsm-assets" });
    expect(manifest.files).toHaveLength(5);
  });

  describe("filesToInstall", () => {
    it("returns every file for a whole-package download", () => {
      expect(filesToInstall(MANIFEST, "all")).toBe(MANIFEST.files);
    });

    it("returns the index, the tool and its paired request for a single tool", () => {
      const files = filesToInstall(MANIFEST, { toolPath: "Tools/assets_get_object.md" });
      expect(files.map((f) => f.path)).toEqual(["MCP - Assets.md", "Tools/assets_get_object.md", "Requests/Assets - GET object.md"]);
    });

    it("leaves out the pair when the tool has none", () => {
      const files = filesToInstall(MANIFEST, { toolPath: "Tools/assets_delete_object.md" });
      expect(files.map((f) => f.path)).toEqual(["MCP - Assets.md", "Tools/assets_delete_object.md"]);
    });

    it("returns nothing for a tool path that does not exist", () => {
      expect(filesToInstall(MANIFEST, { toolPath: "Tools/missing.md" })).toEqual([]);
    });
  });

  describe("needsServiceTemplate", () => {
    const entry: Pick<McpCatalogEntry, "serviceTag" | "serviceTemplate"> = {
      serviceTag: "atlassian/instance",
      serviceTemplate: "templates/atlassian-instance.md",
    };
    const note = (tags: string[]): VaultNote => ({ path: "x.md", name: "x", frontmatter: {}, tags });

    it("is false when the package has no service tag", () => {
      expect(needsServiceTemplate({}, [])).toBe(false);
    });

    it("is true when no service note exists yet", () => {
      expect(needsServiceTemplate(entry, [])).toBe(true);
    });

    it("is true when only real instances exist, none tagged template", () => {
      expect(needsServiceTemplate(entry, [note(["atlassian/instance", "company/acme"])])).toBe(true);
    });

    it("is false once a template note already exists", () => {
      expect(needsServiceTemplate(entry, [note(["atlassian/instance", "template"])])).toBe(false);
    });
  });

  describe("appForEntry", () => {
    it("groups a package under its service's app", () => {
      expect(appForEntry({ serviceTag: "atlassian/instance" })).toEqual({ name: "Atlassian", logo: "atlassian" });
    });

    it("is undefined for a package with no service tag", () => {
      expect(appForEntry({})).toBeUndefined();
    });

    it("is undefined for a service with no known app", () => {
      expect(appForEntry({ serviceTag: "acme/instance" })).toBeUndefined();
    });
  });

  describe("groupCatalogEntries", () => {
    const entry = (over: Partial<McpCatalogEntry>): McpCatalogEntry => ({
      id: "x",
      name: "X",
      tag: "api/app/x",
      logo: "x",
      path: "packages/x",
      toolCount: 0,
      requestOnlyCount: 0,
      ...over,
    });

    it("keeps ungrouped entries as their own row", () => {
      const groups = groupCatalogEntries([entry({ id: "a" }), entry({ id: "b" })]);
      expect(groups.map((g) => g.id)).toEqual(["a", "b"]);
      expect(groups.every((g) => g.entries.length === 1)).toBe(true);
    });

    it("merges entries sharing a groupId into one row with combined counts", () => {
      const v1 = entry({ id: "confluence-v1", groupId: "confluence", name: "Confluence MCP", toolCount: 121, requestOnlyCount: 9, requestCount: 130 });
      const v2 = entry({ id: "confluence-v2", groupId: "confluence", name: "Confluence MCP", toolCount: 218, requestOnlyCount: 0, requestCount: 218 });
      const groups = groupCatalogEntries([v1, v2]);
      expect(groups).toHaveLength(1);
      expect(groups[0]).toMatchObject({ id: "confluence", name: "Confluence MCP", toolCount: 339, requestOnlyCount: 9, requestCount: 348 });
      expect(groups[0].entries).toEqual([v1, v2]);
    });

    it("preserves catalog order for both grouped and ungrouped rows", () => {
      const a = entry({ id: "a" });
      const v1 = entry({ id: "confluence-v1", groupId: "confluence" });
      const b = entry({ id: "b" });
      const v2 = entry({ id: "confluence-v2", groupId: "confluence" });
      const groups = groupCatalogEntries([a, v1, b, v2]);
      expect(groups.map((g) => g.id)).toEqual(["a", "confluence", "b"]);
    });
  });

  describe("serviceTemplateFileName", () => {
    it("titles the service and keeps the tag's second part as the noun", () => {
      expect(serviceTemplateFileName("atlassian/instance")).toBe("Atlassian instance - Template.md");
      expect(serviceTemplateFileName("bitbucket/workspace")).toBe("Bitbucket workspace - Template.md");
    });

    it("falls back to \"instance\" when the tag has no second part", () => {
      expect(serviceTemplateFileName("atlassian")).toBe("Atlassian instance - Template.md");
    });
  });
});
