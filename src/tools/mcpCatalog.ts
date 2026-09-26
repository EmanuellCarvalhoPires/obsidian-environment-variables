// Downloadable MCP packages: ready-made tool/request notes fetched from a GitHub repo
// (never bundled in the plugin) and copied into the vault as-is. A package's own manifest
// lists its files so a whole app, or a single tool, can be installed on its own.

import { hasTag, VaultNote } from "./types";

export interface McpCatalogEntry {
  id: string;
  name: string;
  /** Notes with this tag (and its subtags) belong to the package, e.g. api/app/assets. */
  tag: string;
  /** Id of a bundled default logo (see defaultLogos.ts), or unknown for a generic icon. */
  logo: string;
  /** Folder of this package inside the repo, e.g. packages/jsm-assets. */
  path: string;
  toolCount: number;
  requestOnlyCount: number;
  /** Total number of request notes the package has (paired to a tool, or request-only). */
  requestCount?: number;
  /** The service_tag its tools pick an instance through (e.g. atlassian/instance), if any. */
  serviceTag?: string;
  /** Repo-root-relative path of that service's template note, shared by every package that needs it. */
  serviceTemplate?: string;
  /**
   * Entries sharing this id are different versions of the same app (e.g. Confluence v1 and v2):
   * they show as one row in the download list, with combined counts, but each is still installed
   * (and can be deleted) as its own separate MCP group.
   */
  groupId?: string;
}

export interface McpCatalog {
  version: number;
  packages: McpCatalogEntry[];
}

/** One row of the download list: either a single package, or several version entries merged. */
export interface McpCatalogGroup {
  id: string;
  name: string;
  logo: string;
  toolCount: number;
  requestOnlyCount: number;
  requestCount: number;
  entries: McpCatalogEntry[];
}

/** Merges catalog entries that share a `groupId` into one row each; entries without one stand alone. */
export function groupCatalogEntries(entries: McpCatalogEntry[]): McpCatalogGroup[] {
  const order: string[] = [];
  const byKey = new Map<string, McpCatalogEntry[]>();
  for (const entry of entries) {
    const key = entry.groupId ?? entry.id;
    const list = byKey.get(key);
    if (list) list.push(entry);
    else {
      byKey.set(key, [entry]);
      order.push(key);
    }
  }
  return order.map((key) => {
    const list = byKey.get(key)!;
    return {
      id: key,
      name: list[0].name,
      logo: list[0].logo,
      toolCount: list.reduce((n, e) => n + e.toolCount, 0),
      requestOnlyCount: list.reduce((n, e) => n + e.requestOnlyCount, 0),
      requestCount: list.reduce((n, e) => n + (e.requestCount ?? 0), 0),
      entries: list,
    };
  });
}

export type McpPackageFileKind = "index" | "tool" | "request" | "request-only";

export interface McpPackageFile {
  path: string;
  kind: McpPackageFileKind;
  name?: string;
  title?: string;
  writes?: boolean;
  /** kind: tool — the request file it needs, or null when it has none. */
  pair?: string | null;
}

export interface McpPackageManifest {
  id: string;
  name: string;
  tag: string;
  logo: string;
  index: string;
  files: McpPackageFile[];
}

/** Reads a repo's raw files by path (relative to that repo's root). */
export interface GithubReader {
  fetchText(path: string): Promise<string>;
}

export async function fetchCatalog(reader: GithubReader): Promise<McpCatalog> {
  const parsed = JSON.parse(await reader.fetchText("manifest.json")) as Partial<McpCatalog>;
  if (!Array.isArray(parsed.packages)) throw new Error("Invalid catalog: missing \"packages\".");
  return { version: parsed.version ?? 1, packages: parsed.packages };
}

export async function fetchPackageManifest(reader: GithubReader, entry: Pick<McpCatalogEntry, "path">): Promise<McpPackageManifest> {
  const parsed = JSON.parse(await reader.fetchText(`${entry.path}/manifest.json`)) as Partial<McpPackageManifest>;
  if (!Array.isArray(parsed.files)) throw new Error("Invalid package: missing \"files\".");
  return parsed as McpPackageManifest;
}

/** True when the package needs a service note (has a serviceTag) and the vault has none tagged "template" for it. */
export function needsServiceTemplate(entry: Pick<McpCatalogEntry, "serviceTag" | "serviceTemplate">, existingServiceNotes: VaultNote[]): boolean {
  if (!entry.serviceTag || !entry.serviceTemplate) return false;
  return !existingServiceNotes.some((n) => hasTag(n.tags, "template"));
}

/** "atlassian/instance" -> "Atlassian instance - Template.md". */
export function serviceTemplateFileName(serviceTag: string): string {
  const [service, noun] = serviceTag.split("/");
  const label = service ? service.charAt(0).toUpperCase() + service.slice(1) : service;
  return `${label} ${noun ?? "instance"} - Template.md`;
}

/**
 * Apps a package's `serviceTag` groups it under (e.g. every Atlassian package shares the
 * "atlassian/instance" service, so they all belong to the "Atlassian" app card). Keyed by
 * the service prefix of that tag.
 */
const SERVICE_APPS: Record<string, { name: string; logo: string }> = {
  atlassian: { name: "Atlassian", logo: "atlassian" },
};

/** The two-level app (name + default logo id) a package should be grouped under, if any. */
export function appForEntry(entry: Pick<McpCatalogEntry, "serviceTag">): { name: string; logo: string } | undefined {
  if (!entry.serviceTag) return undefined;
  const service = entry.serviceTag.split("/")[0];
  return SERVICE_APPS[service];
}

export type McpDownloadSelection = "all" | { toolPath: string };

/**
 * Which files to fetch and write for a download: everything, or one tool with its index
 * (so its "up" link resolves) and its paired request note, if it has one.
 */
export function filesToInstall(manifest: McpPackageManifest, selection: McpDownloadSelection): McpPackageFile[] {
  if (selection === "all") return manifest.files;
  const tool = manifest.files.find((f) => f.kind === "tool" && f.path === selection.toolPath);
  if (!tool) return [];
  const index = manifest.files.find((f) => f.kind === "index");
  const pair = tool.pair ? manifest.files.find((f) => f.path === tool.pair) : undefined;
  return [index, tool, pair].filter((f): f is McpPackageFile => f !== undefined);
}
