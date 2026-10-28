import type { AuditEntry } from "./audit/auditLog";
import type { PluginData } from "./settings";
import { deduplicateMcpGroups, isBase64Logo, migrateLogos } from "./tools/mcpGroups";

export interface StorageAdapter {
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<string>;
  write(path: string, content: string): Promise<void>;
}

export interface StorageMigrationOptions {
  adapter: StorageAdapter;
  pluginDir: string;
  data: PluginData;
}

export interface StorageMigrationResult {
  data: PluginData;
  migratedAudit: boolean;
  migratedLogos: boolean;
  migratedGroups: boolean;
  createdBackup: boolean;
  auditEntries: AuditEntry[];
}

/**
 * Migrates data.json storage into split files:
 * 1. Creates data.json.bak before the first migration if it does not exist.
 * 2. Migrates audit log from data.audit into .obsidian/plugins/environment-variables/audit.json and removes it from data.json.
 * 3. Deduplicates base64 logos into data.logos keyed by content hash.
 * 4. Removes empty MCP groups and duplicate groups (same name and same tags/links).
 * Idempotent: repeated runs produce no further changes.
 */
export async function migrateStorage(options: StorageMigrationOptions): Promise<StorageMigrationResult> {
  const { adapter, pluginDir, data } = options;
  const dataPath = `${pluginDir}/data.json`;
  const backupPath = `${pluginDir}/data.json.bak`;
  const auditPath = `${pluginDir}/audit.json`;

  let createdBackup = false;
  let migratedAudit = false;
  let migratedLogos = false;
  let migratedGroups = false;

  // Determine whether any migration is needed
  const hasAuditInSource = Array.isArray(data.audit) && data.audit.length > 0;
  const hasBase64Logos =
    (data.mcpGroups ?? []).some((g) => isBase64Logo(g.logo)) ||
    (data.mcpApps ?? []).some((a) => isBase64Logo(a.logo));
  const cleanGroups = deduplicateMcpGroups(data.mcpGroups ?? []);
  const hasGroupChanges = cleanGroups.length !== (data.mcpGroups ?? []).length;

  const needsMigration = hasAuditInSource || hasBase64Logos || hasGroupChanges;

  // 1. Create data.json.bak before the first migration if it does not already exist
  if (needsMigration) {
    const backupExists = await adapter.exists(backupPath);
    if (!backupExists) {
      if (await adapter.exists(dataPath)) {
        const rawContent = await adapter.read(dataPath);
        await adapter.write(backupPath, rawContent);
        createdBackup = true;
      } else {
        await adapter.write(backupPath, JSON.stringify(data, null, 2));
        createdBackup = true;
      }
    }
  }

  // 2. Audit migration
  let auditEntries: AuditEntry[] = [];
  const auditFileExists = await adapter.exists(auditPath);
  if (auditFileExists) {
    try {
      const content = await adapter.read(auditPath);
      auditEntries = JSON.parse(content) as AuditEntry[];
    } catch {
      auditEntries = [];
    }
    if (data.audit !== undefined) {
      delete data.audit;
      migratedAudit = true;
    }
  } else if (Array.isArray(data.audit)) {
    auditEntries = data.audit;
    await adapter.write(auditPath, JSON.stringify(auditEntries, null, 2));
    delete data.audit;
    migratedAudit = true;
  }

  // 3. Logo migration
  const logoRes = migrateLogos(data);
  data.logos = logoRes.logos;
  if (logoRes.changed) {
    migratedLogos = true;
  }

  // 4. Group deduplication
  if (hasGroupChanges) {
    data.mcpGroups = cleanGroups;
    migratedGroups = true;
  }

  // Save updated data.json if anything changed
  if (migratedAudit || migratedLogos || migratedGroups) {
    if (await adapter.exists(dataPath)) {
      await adapter.write(dataPath, JSON.stringify(data, null, 2));
    }
  }

  return {
    data,
    migratedAudit,
    migratedLogos,
    migratedGroups,
    createdBackup,
    auditEntries,
  };
}
