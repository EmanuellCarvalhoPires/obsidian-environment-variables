import { AuditEntry } from "./audit/auditLog";
import { ClientRecord } from "./server/clients";
import { SecretType } from "./store/types";

export interface Settings {
  serverEnabled: boolean;
  port: number;
  autoLockMinutes: number;
  approvalTimeoutSeconds: number;
  timeoutSeconds: number;
  maxResponseMB: number;
  warnOnTokenPaste: boolean;
  showNamesWhileLocked: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  serverEnabled: false,
  port: 27150,
  autoLockMinutes: 15,
  approvalTimeoutSeconds: 120,
  timeoutSeconds: 30,
  maxResponseMB: 10,
  warnOnTokenPaste: true,
  showNamesWhileLocked: true,
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
}

export function withDefaults(raw: Partial<PluginData> | null | undefined): PluginData {
  return {
    settings: { ...DEFAULT_SETTINGS, ...(raw?.settings ?? {}) },
    clients: Array.isArray(raw?.clients) ? raw.clients : [],
    audit: Array.isArray(raw?.audit) ? raw.audit : [],
    nameIndex: Array.isArray(raw?.nameIndex)
      ? raw.nameIndex.filter((e): e is NameEntry => typeof e?.name === "string" && typeof e?.type === "string")
      : [],
  };
}
