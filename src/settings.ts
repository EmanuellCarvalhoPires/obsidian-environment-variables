import { AuditEntry } from "./audit/auditLog";
import { ClientRecord } from "./server/clients";
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
}

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
};

/** Name and type of a variable: enough to write a reference, never the value. */
export interface NameEntry {
  name: string;
  type: SecretType;
}

/** Contents of data.json. Holds no secret values. */
export interface PluginData {
  settings: Settings;
  clients: ClientRecord[];
  audit: AuditEntry[];
  /** Names and types only, so references can be inserted while the vault is locked. */
  nameIndex: NameEntry[];
  /** Settings migrations already applied (see migrate). */
  settingsRevision: number;
}

/** Auto-lock used to be on (15 minutes) by default. */
const OLD_AUTO_LOCK_DEFAULT = 15;
const SETTINGS_REVISION = 1;

export function withDefaults(raw: Partial<PluginData> | null | undefined): PluginData {
  const settings = { ...DEFAULT_SETTINGS, ...(raw?.settings ?? {}) };
  const revision = typeof raw?.settingsRevision === "number" ? raw.settingsRevision : 0;
  // Revision 1: auto-lock is off by default. Only data still on the old default changes.
  if (revision < 1 && raw?.settings && settings.autoLockMinutes === OLD_AUTO_LOCK_DEFAULT) settings.autoLockMinutes = 0;
  return {
    settings,
    settingsRevision: SETTINGS_REVISION,
    clients: Array.isArray(raw?.clients) ? raw.clients : [],
    audit: Array.isArray(raw?.audit) ? raw.audit : [],
    nameIndex: Array.isArray(raw?.nameIndex)
      ? raw.nameIndex.filter((e): e is NameEntry => typeof e?.name === "string" && typeof e?.type === "string")
      : [],
  };
}
