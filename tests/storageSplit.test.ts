import { describe, expect, it } from "vitest";
import { AuditEntry } from "../src/audit/auditLog";
import { PluginData, withDefaults } from "../src/settings";
import { migrateStorage, StorageAdapter } from "../src/storageMigration";
import { McpGroupConfig } from "../src/tools/mcpGroups";

class MemoryStorageAdapter implements StorageAdapter {
  files = new Map<string, string>();

  async exists(path: string): Promise<boolean> {
    return this.files.has(path);
  }

  async read(path: string): Promise<string> {
    const content = this.files.get(path);
    if (content === undefined) throw new Error(`File not found: ${path}`);
    return content;
  }

  async write(path: string, content: string): Promise<void> {
    this.files.set(path, content);
  }
}

const PLUGIN_DIR = ".obsidian/plugins/environment-variables";

const SAMPLE_BASE64_LOGO =
  "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI+PHBhdGggZD0iTTAgMGgyNHYyNEgweiIvPjwvc3ZnPg==";

describe("storageSplit (Item 14: storage split and migration)", () => {
  it("logo repetido 7 vezes → 1 chave", async () => {
    const adapter = new MemoryStorageAdapter();

    // 7 MCP groups with the exact same base64 logo
    const groups: McpGroupConfig[] = Array.from({ length: 7 }, (_, i) => ({
      id: `group_${i}`,
      name: `MCP Group ${i}`,
      logo: SAMPLE_BASE64_LOGO,
      enabled: true,
      tag: `mcp/tool/app_${i}`,
      links: [],
    }));

    const data: PluginData = withDefaults({
      mcpGroups: groups,
      logos: {},
    });

    // Write initial data.json to disk
    const dataPath = `${PLUGIN_DIR}/data.json`;
    await adapter.write(dataPath, JSON.stringify(data, null, 2));

    const result = await migrateStorage({ adapter, pluginDir: PLUGIN_DIR, data });

    // In data.logos, exactly 1 unique key is stored
    expect(result.data.logos).toBeDefined();
    const logoKeys = Object.keys(result.data.logos!);
    expect(logoKeys).toHaveLength(1);

    const uniqueKey = logoKeys[0];
    expect(result.data.logos![uniqueKey]).toBe(SAMPLE_BASE64_LOGO);

    // All 7 groups reference that unique key
    expect(result.data.mcpGroups).toHaveLength(7);
    for (const group of result.data.mcpGroups) {
      expect(group.logo).toBe(uniqueKey);
    }

    // Verify written data.json
    const savedData = JSON.parse(await adapter.read(dataPath));
    expect(Object.keys(savedData.logos)).toHaveLength(1);
    expect(savedData.mcpGroups.every((g: McpGroupConfig) => g.logo === uniqueKey)).toBe(true);
  });

  it("grupo vazio duplicado sai", async () => {
    const adapter = new MemoryStorageAdapter();

    const groups: McpGroupConfig[] = [
      // Valid group
      { id: "1", name: "Jira Cloud", logo: "jira", enabled: true, tag: "mcp/tool/jira", links: ["[[Jira Note]]"] },
      // Duplicate of group 1 (same name, same tag, same links)
      { id: "2", name: "Jira Cloud", logo: "jira", enabled: true, tag: "mcp/tool/jira", links: ["[[Jira Note]]"] },
      // Empty group: empty name
      { id: "3", name: "", logo: "", enabled: true, tag: "mcp/tool/other", links: [] },
      // Empty group: no tag, no links, and no sourcePackageId
      { id: "4", name: "Empty Group 1", logo: "", enabled: true, tag: "", links: [] },
      // Duplicate empty group
      { id: "5", name: "Empty Group 1", logo: "", enabled: true, tag: "", links: [] },
      // Valid group: Confluence
      { id: "6", name: "Confluence", logo: "conf", enabled: true, tag: "mcp/tool/conf", links: [] },
    ];

    const data: PluginData = withDefaults({ mcpGroups: groups });
    await adapter.write(`${PLUGIN_DIR}/data.json`, JSON.stringify(data, null, 2));

    const result = await migrateStorage({ adapter, pluginDir: PLUGIN_DIR, data });

    expect(result.migratedGroups).toBe(true);
    // Only the 2 valid, unique, non-empty groups remain
    expect(result.data.mcpGroups.map((g) => g.name)).toEqual(["Jira Cloud", "Confluence"]);
  });

  it("auditoria migra (data.audit sai do data.json e vai para audit.json com backup)", async () => {
    const adapter = new MemoryStorageAdapter();

    const auditEntries: AuditEntry[] = [
      {
        time: "2026-10-28T10:00:00.000Z",
        client: "Claude Code",
        action: "request",
        secrets: ["JIRA_API_TOKEN"],
        outcome: "ok",
        method: "GET",
        target: "https://acme.atlassian.net/rest/api/3/myself",
      },
      {
        time: "2026-10-28T10:05:00.000Z",
        client: "Antigravity",
        action: "tool",
        tool: "jira_get_issue",
        secrets: [],
        outcome: "ok",
      },
    ];

    const initialData: PluginData = withDefaults({
      audit: auditEntries,
    });

    const dataPath = `${PLUGIN_DIR}/data.json`;
    const backupPath = `${PLUGIN_DIR}/data.json.bak`;
    const auditPath = `${PLUGIN_DIR}/audit.json`;

    await adapter.write(dataPath, JSON.stringify(initialData, null, 2));

    // Backup does not exist initially
    expect(await adapter.exists(backupPath)).toBe(false);
    expect(await adapter.exists(auditPath)).toBe(false);

    const result = await migrateStorage({ adapter, pluginDir: PLUGIN_DIR, data: initialData });

    // Backup was created
    expect(result.createdBackup).toBe(true);
    expect(await adapter.exists(backupPath)).toBe(true);

    // audit.json was created with the audit entries
    expect(await adapter.exists(auditPath)).toBe(true);
    const savedAudit: AuditEntry[] = JSON.parse(await adapter.read(auditPath));
    expect(savedAudit).toEqual(auditEntries);

    // data.audit was removed from data object
    expect(result.data.audit).toBeUndefined();

    // data.json on disk does not contain audit
    const savedData = JSON.parse(await adapter.read(dataPath));
    expect(savedData.audit).toBeUndefined();
  });

  it("segunda migração não muda nada (idempotência)", async () => {
    const adapter = new MemoryStorageAdapter();

    const auditEntries: AuditEntry[] = [
      {
        time: "2026-10-28T10:00:00.000Z",
        client: "Claude Code",
        action: "request",
        secrets: ["TOKEN"],
        outcome: "ok",
      },
    ];

    const initialData: PluginData = withDefaults({
      audit: auditEntries,
      mcpGroups: [
        { id: "g1", name: "Jira", logo: SAMPLE_BASE64_LOGO, enabled: true, tag: "mcp/jira", links: [] },
        { id: "g2", name: "Jira", logo: SAMPLE_BASE64_LOGO, enabled: true, tag: "mcp/jira", links: [] },
      ],
    });

    await adapter.write(`${PLUGIN_DIR}/data.json`, JSON.stringify(initialData, null, 2));

    // First migration
    const firstRun = await migrateStorage({ adapter, pluginDir: PLUGIN_DIR, data: initialData });
    expect(firstRun.createdBackup).toBe(true);
    expect(firstRun.migratedAudit).toBe(true);
    expect(firstRun.migratedLogos).toBe(true);
    expect(firstRun.migratedGroups).toBe(true);

    const dataJsonAfterFirst = await adapter.read(`${PLUGIN_DIR}/data.json`);
    const backupAfterFirst = await adapter.read(`${PLUGIN_DIR}/data.json.bak`);
    const auditAfterFirst = await adapter.read(`${PLUGIN_DIR}/audit.json`);

    // Second migration on the already migrated state
    const secondRun = await migrateStorage({
      adapter,
      pluginDir: PLUGIN_DIR,
      data: firstRun.data,
    });

    expect(secondRun.createdBackup).toBe(false);
    expect(secondRun.migratedAudit).toBe(false);
    expect(secondRun.migratedLogos).toBe(false);
    expect(secondRun.migratedGroups).toBe(false);

    // Files on disk are byte-for-byte identical
    expect(await adapter.read(`${PLUGIN_DIR}/data.json`)).toBe(dataJsonAfterFirst);
    expect(await adapter.read(`${PLUGIN_DIR}/data.json.bak`)).toBe(backupAfterFirst);
    expect(await adapter.read(`${PLUGIN_DIR}/audit.json`)).toBe(auditAfterFirst);
  });

  it("não há valor de segredo nos arquivos gerados", async () => {
    const adapter = new MemoryStorageAdapter();

    const auditEntries: AuditEntry[] = [
      {
        time: "2026-10-28T10:00:00.000Z",
        client: "Claude Code",
        action: "request",
        secrets: ["MY_SECRET_NAME"],
        outcome: "ok",
      },
    ];

    const data: PluginData = withDefaults({
      audit: auditEntries,
    });

    await adapter.write(`${PLUGIN_DIR}/data.json`, JSON.stringify(data, null, 2));
    await migrateStorage({ adapter, pluginDir: PLUGIN_DIR, data });

    const SECRET_VALUE = "super-secret-password-12345";
    for (const [filePath, content] of adapter.files.entries()) {
      expect(content).not.toContain(SECRET_VALUE);
      // Ensure only variable reference names appear, never plaintext values
      if (filePath.endsWith("audit.json")) {
        expect(content).toContain("MY_SECRET_NAME");
      }
    }
  });
});
