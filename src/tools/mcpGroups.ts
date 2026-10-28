// MCP groups: user-defined groupings that bundle vault tools under one name and logo
// (e.g. "Jira Cloud MCP"), so they can be shared or toggled as a unit.
// Membership is computed, not stored: a tag and/or a list of note links, resolved
// against the vault every time, like the generic tools' service_tag.

import { createHash } from "crypto";
import type { AuditEntry } from "../audit/auditLog";
import { normalizeMcpKey } from "./toolSearch";
import { NoteSource, ToolEntry } from "./types";

export const MCP_GROUP_NAME_MAX = 60;

/** The parent card of a two-level grouping (e.g. "Atlassian"), holding one or more MCPs. */
export interface McpAppConfig {
  id: string;
  name: string;
  /** Data URI or unique key of the logo the user picked, or "" for a generic icon. */
  logo: string;
  enabled: boolean;
}

export interface McpGroupConfig {
  id: string;
  name: string;
  /** Data URI or unique key of the logo the user picked, or "" for a generic icon. */
  logo: string;
  enabled: boolean;
  /** Notes with this tag (and its subtags) count as members. "" means no tag filter. */
  tag: string;
  /** Explicit note links or names, as the user wrote them (e.g. "[[Jira - Get issue]]"). */
  links: string[];
  /** The app card this MCP is listed under, or undefined when it stands on its own. */
  appId?: string;
  /** Id of the downloaded package this MCP came from, so downloading it again updates instead of duplicating it. */
  sourcePackageId?: string;
}

export interface McpGroupStats extends McpGroupConfig {
  toolCount: number;
  requestCount: number;
  /** Names of the matched tools, for a details view. */
  toolNames: string[];
}

export function randomGroupId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function newMcpGroup(): McpGroupConfig {
  return { id: randomGroupId(), name: "", logo: "", enabled: true, tag: "", links: [], appId: undefined };
}

export function newMcpApp(): McpAppConfig {
  return { id: randomGroupId(), name: "", logo: "", enabled: true };
}

/** Paths of the notes matched by a group's tag and/or links, resolved against the vault. */
export function matchedNotePaths(config: Pick<McpGroupConfig, "tag" | "links">, source: NoteSource): Set<string> {
  const paths = new Set<string>();
  if (config.tag.trim()) for (const note of source.byTag(config.tag)) paths.add(note.path);
  for (const link of config.links) {
    const note = source.resolve(link);
    if (note) paths.add(note.path);
  }
  return paths;
}

/** Tool entries (from the registry) whose note is matched by the group's tag and/or links. */
export function matchedTools(config: Pick<McpGroupConfig, "tag" | "links">, entries: ToolEntry[], source: NoteSource): ToolEntry[] {
  const paths = matchedNotePaths(config, source);
  return entries.filter((e) => paths.has(e.notePath));
}

/** Adds the tool count and the request count (from the audit log) to a group. Reads nothing. */
export function computeMcpGroupStats(config: McpGroupConfig, entries: ToolEntry[], source: NoteSource, audit: AuditEntry[]): McpGroupStats {
  const tools = matchedTools(config, entries, source);
  // Tools loaded from a downloaded package (mcp.db) have no note: they belong to the group by package id.
  if (config.sourcePackageId) {
    const key = normalizeMcpKey(config.sourcePackageId);
    const seen = new Set(tools.map((e) => e.name));
    for (const e of entries) if (!seen.has(e.name) && e.mcpKeys?.includes(key)) tools.push(e);
  }
  const names = new Set(tools.map((e) => e.name));
  const requestCount = audit.filter((a) => a.action === "tool" && a.tool !== undefined && names.has(a.tool)).length;
  return { ...config, toolCount: tools.length, requestCount, toolNames: tools.map((e) => e.name) };
}

/** Splits a textarea value into link/name entries, one per non-empty line. */
export function parseLinkLines(raw: string): string[] {
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export function validateMcpGroupName(name: string, others: McpGroupConfig[], ownId?: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return "A name is required.";
  if (trimmed.length > MCP_GROUP_NAME_MAX) return `Use at most ${MCP_GROUP_NAME_MAX} characters.`;
  if (others.some((g) => g.id !== ownId && g.name.trim().toLowerCase() === trimmed.toLowerCase())) return "There is already an MCP with this name.";
  return null;
}

export function validateMcpAppName(name: string, others: McpAppConfig[], ownId?: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return "A name is required.";
  if (trimmed.length > MCP_GROUP_NAME_MAX) return `Use at most ${MCP_GROUP_NAME_MAX} characters.`;
  if (others.some((a) => a.id !== ownId && a.name.trim().toLowerCase() === trimmed.toLowerCase())) return "There is already an app with this name.";
  return null;
}

/** Content hash for a base64 logo. */
export function hashLogo(content: string): string {
  if (!content) return "";
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

/** Checks whether a logo value is a base64 Data URI or raw base64 content rather than a stored key. */
export function isBase64Logo(val: string): boolean {
  return typeof val === "string" && (val.startsWith("data:") || val.length > 64);
}

/**
 * Migrates base64 logos in groups and apps into the central `logos` dictionary.
 * Idempotent: logos already referencing a key in `logos` remain untouched.
 */
export function migrateLogos(data: {
  mcpGroups?: McpGroupConfig[];
  mcpApps?: McpAppConfig[];
  logos?: Record<string, string>;
}): { logos: Record<string, string>; changed: boolean } {
  const logos: Record<string, string> = { ...(data.logos ?? {}) };
  let changed = false;

  const contentToKey = new Map<string, string>();
  for (const [key, content] of Object.entries(logos)) {
    contentToKey.set(content, key);
  }

  const processEntity = (entity: { logo: string }) => {
    if (!entity.logo) return;
    if (entity.logo in logos) return;

    if (isBase64Logo(entity.logo)) {
      let key = contentToKey.get(entity.logo);
      if (!key) {
        key = hashLogo(entity.logo);
        logos[key] = entity.logo;
        contentToKey.set(entity.logo, key);
      }
      if (entity.logo !== key) {
        entity.logo = key;
        changed = true;
      }
    }
  };

  for (const g of data.mcpGroups ?? []) processEntity(g);
  for (const a of data.mcpApps ?? []) processEntity(a);

  return { logos, changed };
}

/** True when a group has no name, or matches 0 tools (no tag, no links, and no package id). */
export function isGroupEmpty(group: McpGroupConfig): boolean {
  if (!group.name?.trim()) return true;
  if (!group.tag?.trim() && (!group.links || group.links.length === 0) && !group.sourcePackageId) {
    return true;
  }
  return false;
}

/**
 * Removes empty groups and duplicate groups (same name and same set of tags/links).
 * Idempotent.
 */
export function deduplicateMcpGroups(groups: McpGroupConfig[]): McpGroupConfig[] {
  if (!Array.isArray(groups)) return [];
  const out: McpGroupConfig[] = [];
  const seenSigs = new Set<string>();

  for (const g of groups) {
    if (isGroupEmpty(g)) continue;

    const canonicalName = g.name.trim().toLowerCase();
    const canonicalTag = (g.tag ?? "").trim().toLowerCase();
    const canonicalLinks = Array.from(new Set((g.links ?? []).map((l) => l.trim()).filter(Boolean)))
      .sort()
      .join("\n");
    const sig = `${canonicalName}||${canonicalTag}||${canonicalLinks}`;

    if (seenSigs.has(sig)) continue;
    seenSigs.add(sig);
    out.push(g);
  }

  return out;
}
