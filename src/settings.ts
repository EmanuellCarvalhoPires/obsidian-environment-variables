import { AuditEntry } from "./audit/auditLog";
import { ClientRecord } from "./server/clients";

export interface Settings {
  serverEnabled: boolean;
  port: number;
  autoLockMinutes: number;
  approvalTimeoutSeconds: number;
  timeoutSeconds: number;
  maxResponseMB: number;
  warnOnTokenPaste: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  serverEnabled: false,
  port: 27150,
  autoLockMinutes: 15,
  approvalTimeoutSeconds: 120,
  timeoutSeconds: 30,
  maxResponseMB: 10,
  warnOnTokenPaste: true,
};

/** Contents of data.json. Holds no secret values. */
export interface PluginData {
  settings: Settings;
  clients: ClientRecord[];
  audit: AuditEntry[];
}

export function withDefaults(raw: Partial<PluginData> | null | undefined): PluginData {
  return {
    settings: { ...DEFAULT_SETTINGS, ...(raw?.settings ?? {}) },
    clients: Array.isArray(raw?.clients) ? raw.clients : [],
    audit: Array.isArray(raw?.audit) ? raw.audit : [],
  };
}
