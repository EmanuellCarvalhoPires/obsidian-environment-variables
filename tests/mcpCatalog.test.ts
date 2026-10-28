import { describe, expect, it } from "vitest";
import { appForEntry } from "../src/tools/mcpCatalog";

describe("mcpCatalog", () => {
  describe("appForEntry", () => {
    it("groups a package under its service's app", () => {
      expect(appForEntry({ serviceTag: "atlassian/instance" })).toEqual({ name: "Atlassian", logo: "atlassian" });
      expect(appForEntry({ serviceTag: "bitbucket/workspace" })).toEqual({ name: "Atlassian", logo: "atlassian" });
      expect(appForEntry({ serviceTag: "trello/account" })).toBeUndefined();
    });

    it("is undefined for a package with no service tag", () => {
      expect(appForEntry({})).toBeUndefined();
    });

    it("is undefined for a service with no known app", () => {
      expect(appForEntry({ serviceTag: "acme/instance" })).toBeUndefined();
    });
  });
});
