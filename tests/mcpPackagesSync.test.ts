import { describe, expect, it } from "vitest";
import type { InstalledMcpPackage } from "../src/ecosystem/moduleConnector";
import { planGroupSync } from "../src/tools/mcpPackagesSync";

function pkg(id: string): InstalledMcpPackage {
  return { id, name: id, app: "", tag: `api/${id}`, logo: "", toolCount: 1, dbPath: `${id}.db` };
}

describe("mcpPackagesSync", () => {
  it("adds a group only for installed packages that have none", () => {
    const installed = [pkg("jira"), pkg("confluence"), pkg("bitbucket")];
    const groups = [
      { id: "g1", sourcePackageId: "jira" },
      { id: "g2", sourcePackageId: "confluence" },
    ];

    const plan = planGroupSync(installed, groups);

    expect(plan.toAdd.map((p) => p.id)).toEqual(["bitbucket"]);
    expect(plan.toRemoveGroupIds).toEqual([]);
  });

  it("removes the group of a package that is no longer installed", () => {
    const installed = [pkg("jira")];
    const groups = [
      { id: "g1", sourcePackageId: "jira" },
      { id: "g2", sourcePackageId: "confluence" },
    ];

    const plan = planGroupSync(installed, groups);

    expect(plan.toAdd).toEqual([]);
    expect(plan.toRemoveGroupIds).toEqual(["g2"]);
  });

  it("never removes a group without a sourcePackageId", () => {
    const installed = [pkg("jira")];
    const groups = [
      { id: "manual", sourcePackageId: undefined },
      { id: "g1", sourcePackageId: "jira" },
    ];

    const plan = planGroupSync(installed, groups);

    expect(plan.toRemoveGroupIds).not.toContain("manual");
    expect(plan.toRemoveGroupIds).toEqual([]);
  });

  it("removes every package group when the list is empty, and keeps the others", () => {
    const groups = [
      { id: "g1", sourcePackageId: "jira" },
      { id: "g2", sourcePackageId: "confluence" },
      { id: "manual" },
    ];

    const plan = planGroupSync([], groups);

    expect(plan.toAdd).toEqual([]);
    expect(plan.toRemoveGroupIds).toEqual(["g1", "g2"]);
  });
});
