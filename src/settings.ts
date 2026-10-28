import { AuditEntry } from "./audit/auditLog";
import { ClientRecord } from "./server/clients";
import { McpAppConfig, McpGroupConfig } from "./tools/mcpGroups";
import { SecretType } from "./store/types";

export interface Settings {
  serverEnabled: boolean;
  port: number;
  /**
   * Name this vault's server is registered under in AI clients. Each vault has its own, so two open
   * vaults never replace each other's registration. Set on first load (see main.ts).
   */
  mcpServerName: string;
  autoLockMinutes: number;
  approvalTimeoutSeconds: number;
  timeoutSeconds: number;
  maxResponseMB: number;
  warnOnTokenPaste: boolean;
  showNamesWhileLocked: boolean;
  /** Vault tools: MCP tools defined by notes. Off by default. */
  toolsEnabled: boolean;
  /** kind: script tools (code in the note, run in a worker). Off by default, even with tools on. */
  scriptsEnabled: boolean;
  /** Tag of tool notes (subtags included). */
  toolTag: string;
  /** Tag of request notes, for discovery. */
  requestTag: string;
  scriptTimeoutSeconds: number;
  /** Language of the plugin: "auto" follows Obsidian's language. */
  language: LanguageSetting;
  /**
   * Vault folder where the tool notes live, shared with AI Ecosystem's hooks so Grep stays allowed there.
   * Empty: worked out from where the tool notes are.
   */
  toolNotesFolder: string;
}

export type LanguageSetting = "auto" | "en" | "pt-BR";

export const DEFAULT_SETTINGS: Settings = {
  serverEnabled: false,
  port: 27150,
  mcpServerName: "",
  autoLockMinutes: 0,
  approvalTimeoutSeconds: 120,
  timeoutSeconds: 30,
  maxResponseMB: 10,
  warnOnTokenPaste: true,
  showNamesWhileLocked: true,
  toolsEnabled: false,
  scriptsEnabled: false,
  toolTag: "mcp/tool",
  requestTag: "api/request",
  scriptTimeoutSeconds: 30,
  language: "auto",
  toolNotesFolder: "",
};

/** Name and type of a variable: enough to write a reference, never the value. */
export interface NameEntry {
  name: string;
  /** "value" marks an entry of the Values section. */
  type: SecretType | "value";
}

/** Contents of data.json. Holds no secret values. */
export interface PluginData {
  settings: Settings;
  clients: ClientRecord[];
  audit?: AuditEntry[];
  /** Names and types only, so references can be inserted while the vault is locked. */
  nameIndex: NameEntry[];
  /** User-defined MCP groupings (e.g. "Jira Cloud MCP"): a name, a logo and which tools count as members. */
  mcpGroups: McpGroupConfig[];
  /** Two-level grouping: an app card (e.g. "Atlassian") that lists one or more of the MCPs above. */
  mcpApps: McpAppConfig[];
  /** Deduplicated base64 logos keyed by content hash. */
  logos?: Record<string, string>;
  /** Settings migrations already applied (see migrate). */
  settingsRevision: number;
  /** Ids of the bundled instance templates already created once (see serviceTemplates.ts). */
  createdTemplates: string[];
  /** Host patterns of the secrets and values (hosts only), so the terminal hook still knows them while the vault is locked. */
  hostIndex: string[];
  /** Hosts for the services named during the guided set-up: only suggestions for env_criar_secret. */
  serviceHosts: string[];
}

/** Auto-lock used to be on (15 minutes) by default. */
const OLD_AUTO_LOCK_DEFAULT = 15;
const SETTINGS_REVISION = 1;

export function withDefaults(raw: Partial<PluginData> | null | undefined): PluginData {
  const settings: Settings & { mcpCatalogUrl?: unknown } = { ...DEFAULT_SETTINGS, ...(raw?.settings ?? {}) };
  // Legacy key from an older version: dropped so it is not written back to data.json.
  delete settings.mcpCatalogUrl;
  const revision = typeof raw?.settingsRevision === "number" ? raw.settingsRevision : 0;
  // Revision 1: auto-lock is off by default. Only data still on the old default changes.
  if (revision < 1 && raw?.settings && settings.autoLockMinutes === OLD_AUTO_LOCK_DEFAULT) settings.autoLockMinutes = 0;
  return {
    settings,
    settingsRevision: SETTINGS_REVISION,
    clients: Array.isArray(raw?.clients) ? raw.clients : [],
    audit: Array.isArray(raw?.audit) ? raw.audit : undefined,
    nameIndex: Array.isArray(raw?.nameIndex)
      ? raw.nameIndex.filter((e): e is NameEntry => typeof e?.name === "string" && typeof e?.type === "string")
      : [],
    mcpGroups: Array.isArray(raw?.mcpGroups)
      ? raw.mcpGroups.filter((g): g is McpGroupConfig => typeof g?.id === "string" && typeof g?.name === "string" && Array.isArray(g?.links))
      : [],
    mcpApps: Array.isArray(raw?.mcpApps) ? raw.mcpApps.filter((a): a is McpAppConfig => typeof a?.id === "string" && typeof a?.name === "string") : [],
    logos: typeof raw?.logos === "object" && raw?.logos !== null ? raw.logos : {},
    createdTemplates: Array.isArray(raw?.createdTemplates) ? raw.createdTemplates.filter((id): id is string => typeof id === "string") : [],
    hostIndex: Array.isArray(raw?.hostIndex) ? raw.hostIndex.filter((h): h is string => typeof h === "string") : [],
    serviceHosts: Array.isArray(raw?.serviceHosts) ? raw.serviceHosts.filter((h): h is string => typeof h === "string") : [],
  };
}
