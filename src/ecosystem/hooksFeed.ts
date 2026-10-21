// What Environment Keys gives the AI Ecosystem `hooks` service: the hosts that have a secret (so the
// terminal hook can point `curl` at http_request) and the folders of tool notes. Names and values never
// leave this plugin. Also the set-up handler the guided configuration (skill configurar-environment-variables) talks to.

import { isValidPattern } from "../secrets/hosts";
import { SecretRecord, ValueRecord } from "../store/types";
import { HookRuleData, SetupHandler } from "./moduleConnector";

/**
 * Host patterns of the secrets that are tied to hosts, plus the hosts of values. A secret with Full access
 * or Any host has no host list to protect, so it adds nothing. Only hosts: no names, no values.
 */
export function hooksHosts(secrets: Pick<SecretRecord, "allowedHosts" | "allowAnyHost" | "fullAccess">[], values: Pick<ValueRecord, "allowedHosts">[]): string[] {
  const hosts = new Set<string>();
  const add = (raw: string) => {
    const pattern = raw.trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").replace(/\/\*$/, "").replace(/\/+$/, "");
    if (pattern && isValidPattern(pattern)) hosts.add(pattern);
  };
  for (const s of secrets) {
    if (s.fullAccess === true || s.allowAnyHost === true) continue;
    s.allowedHosts.forEach(add);
  }
  for (const v of values) v.allowedHosts.forEach(add);
  return [...hosts].sort();
}

/**
 * Folders where the tool notes live, so that Grep stays allowed there. The folder chosen in the settings wins;
 * without one, each top-level folder that holds tool notes gives the deepest folder all its tool notes share.
 */
export function toolNoteFolders(configured: string, notePaths: string[]): string[] {
  const chosen = cleanFolder(configured);
  if (chosen) return [chosen];
  const groups = new Map<string, string[][]>();
  for (const path of notePaths) {
    const dirs = path.split("/").slice(0, -1);
    if (dirs.length === 0) continue; // a note at the vault root says nothing about a folder
    const list = groups.get(dirs[0]);
    if (list) list.push(dirs);
    else groups.set(dirs[0], [dirs]);
  }
  const folders: string[] = [];
  for (const dirsList of groups.values()) {
    let common = dirsList[0];
    for (const dirs of dirsList) {
      let i = 0;
      while (i < common.length && i < dirs.length && common[i] === dirs[i]) i++;
      common = common.slice(0, i);
    }
    folders.push(common.join("/"));
  }
  return folders.sort();
}

/** A vault-relative folder path with "/" and no edges, or "" when it is not usable. */
export function cleanFolder(raw: string): string {
  const path = raw.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (!path || path.split("/").some((part) => part === ".." || part === "." || part === "")) return "";
  return path;
}

/** Hosts the agent may suggest for a service named during the set-up (they are only suggestions for env_criar_secret). */
export const SERVICE_HOSTS: Record<string, string[]> = {
  jira: ["*.atlassian.net"],
  confluence: ["*.atlassian.net"],
  bitbucket: ["api.bitbucket.org"],
  github: ["api.github.com"],
  trello: ["api.trello.com"],
};

export interface SetupDeps {
  isUnlocked(): boolean;
  /** Counts of secrets and values. Null while the vault is locked. */
  counts(): { secrets: number; values: number } | null;
  /** Counts from the name index (names only), used while the vault is locked. */
  indexedCounts(): { secrets: number; values: number };
  toolNotesFolder(): string;
  folderExists(path: string): boolean;
  setToolNotesFolder(path: string): Promise<void>;
  knownHosts(): string[];
  setServiceHosts(hosts: string[]): Promise<void>;
}

export function createSetupHandler(deps: SetupDeps): SetupHandler {
  return {
    async detect() {
      const counts = deps.counts() ?? deps.indexedCounts();
      return {
        vaultUnlocked: deps.isUnlocked(),
        secretCount: counts.secrets,
        valueCount: counts.values,
        toolNotesFolder: deps.toolNotesFolder(),
        knownHosts: deps.knownHosts(),
      };
    },

    async save(key, value) {
      if (key === "pasta_notas_tools") {
        const folder = typeof value === "string" ? cleanFolder(value) : "";
        if (!folder) return "pasta_notas_tools must be a folder path relative to the vault, e.g. MCP.";
        if (!deps.folderExists(folder)) return `The folder "${folder}" does not exist in the vault.`;
        await deps.setToolNotesFolder(folder);
        return;
      }
      if (key === "servicos") {
        if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) return "servicos must be a list of service names, e.g. [\"jira\", \"bitbucket\"].";
        const hosts = new Set<string>();
        const unknown: string[] = [];
        for (const raw of value as string[]) {
          const name = raw.trim().toLowerCase();
          if (SERVICE_HOSTS[name]) SERVICE_HOSTS[name].forEach((h) => hosts.add(h));
          else if (name.includes(".") && isValidPattern(name)) hosts.add(name);
          else unknown.push(raw);
        }
        if (unknown.length > 0) return `Unknown service: ${unknown.join(", ")}. Known: ${Object.keys(SERVICE_HOSTS).join(", ")}, or pass a host such as api.example.com.`;
        await deps.setServiceHosts([...hosts].sort());
        return;
      }
      return `Unknown key "${key}". Accepted: pasta_notas_tools, servicos.`;
    },

    async validate() {
      if (deps.isUnlocked()) return { ok: true };
      return { ok: false, missing: ["Secret vault locked: the user unlocks it in Obsidian (Environment Keys panel)."] };
    },
  };
}

/** Feeds the hooks service, skipping a push that would repeat the previous one. */
export class HooksDataPusher {
  private last = "";

  push(service: { setRuleData(moduleId: string, data: HookRuleData): void } | undefined, moduleId: string, data: HookRuleData): void {
    if (!service) return;
    const signature = JSON.stringify(data);
    if (signature === this.last) return;
    try {
      service.setRuleData(moduleId, data);
      this.last = signature;
    } catch (err) {
      console.error("[environment-variables] Failed to feed the hooks service:", err);
    }
  }

  /** Forget the previous push, e.g. after reconnecting to AI Ecosystem. */
  reset(): void {
    this.last = "";
  }
}
