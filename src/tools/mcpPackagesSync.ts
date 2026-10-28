// Keeps the MCP groups in step with the packages AI Ecosystem has installed.
// Pure: no Obsidian imports (the type import is erased), so it is tested on its own.

import type { InstalledMcpPackage } from "../ecosystem/moduleConnector";

export interface GroupSyncPlan {
  /** Installed packages that have no group yet. */
  toAdd: InstalledMcpPackage[];
  /** Groups of packages that are no longer installed. */
  toRemoveGroupIds: string[];
}

/** Compares the installed packages with the groups. Groups without a sourcePackageId are never touched. */
export function planGroupSync(installed: InstalledMcpPackage[], groups: Array<{ id: string; sourcePackageId?: string }>): GroupSyncPlan {
  const installedIds = new Set(installed.map((p) => p.id));
  const groupedIds = new Set(groups.map((g) => g.sourcePackageId).filter((id): id is string => !!id));
  const toAdd = installed.filter((p) => !groupedIds.has(p.id));
  const toRemoveGroupIds = groups.filter((g) => !!g.sourcePackageId && !installedIds.has(g.sourcePackageId)).map((g) => g.id);
  return { toAdd, toRemoveGroupIds };
}
