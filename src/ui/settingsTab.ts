import { App, Notice, PluginSettingTab, Setting, SettingDefinitionItem, TextComponent } from "obsidian";
import { describeVault } from "../crypto/vaultFile";
import { t } from "../i18n";
import type EnvironmentVariablesPlugin from "../main";
import { SERVER_NAME_PATTERN } from "../server/vaultIdentity";
import { LanguageSetting, Settings } from "../settings";

type NumberKey = { [K in keyof Settings]: Settings[K] extends number ? K : never }[keyof Settings];
type BooleanKey = { [K in keyof Settings]: Settings[K] extends boolean ? K : never }[keyof Settings];
type TextKey = Exclude<{ [K in keyof Settings]: Settings[K] extends string ? K : never }[keyof Settings], "language">;

const TAG_PATTERN = /^[\p{L}\p{N}_-]+(\/[\p{L}\p{N}_-]+)*$/u;

const RANGES: Record<NumberKey, [number, number]> = {
  port: [1024, 65535],
  autoLockMinutes: [0, 1440],
  approvalTimeoutSeconds: [10, 600],
  timeoutSeconds: [1, 600],
  maxResponseMB: [1, 200],
  scriptTimeoutSeconds: [1, 600],
};

export class EnvironmentVariablesSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly plugin: EnvironmentVariablesPlugin,
  ) {
    super(app, plugin);
  }

  getSettingDefinitions(): SettingDefinitionItem<keyof Settings>[] {
    return [
      {
        type: "group",
        heading: t("settings.languageGroup"),
        items: [
          {
            name: t("settings.language"),
            desc: t("settings.languageDesc"),
            control: {
              type: "dropdown",
              key: "language",
              options: { auto: t("settings.languageAuto"), en: "English", "pt-BR": "Português (Brasil)" },
            },
          },
        ],
      },
      {
        type: "group",
        heading: t("view.section.env"),
        items: [
          { name: t("settings.autoLock"), desc: t("settings.autoLockDesc"), control: numberControl("autoLockMinutes") },
          { name: t("settings.warnPaste"), desc: t("settings.warnPasteDesc"), control: { type: "toggle", key: "warnOnTokenPaste" } },
          { name: t("settings.namesLocked"), desc: t("settings.namesLockedDesc"), control: { type: "toggle", key: "showNamesWhileLocked" } },
          { name: t("settings.changePassword"), render: (setting) => this.renderPasswordChange(setting) },
          { name: t("settings.storageFile"), render: (setting) => this.renderStorage(setting), searchable: false },
        ],
      },
      {
        type: "group",
        heading: t("view.section.mcp"),
        items: [
          { name: t("settings.serverEnabled"), desc: t("settings.serverEnabledDesc"), control: { type: "toggle", key: "serverEnabled" } },
          { name: t("settings.port"), desc: t("settings.portDesc"), control: numberControl("port") },
          {
            name: t("settings.serverName"),
            desc: t("settings.serverNameDesc"),
            control: {
              type: "text",
              key: "mcpServerName",
              validate: (v: string) => (SERVER_NAME_PATTERN.test(v.trim()) ? undefined : t("settings.serverNameInvalid")),
            },
          },
          { name: t("settings.approvalTimeout"), control: numberControl("approvalTimeoutSeconds") },
          { name: t("settings.timeout"), control: numberControl("timeoutSeconds") },
          { name: t("settings.maxResponse"), control: numberControl("maxResponseMB") },
        ],
      },
      {
        type: "group",
        heading: t("settings.toolsGroup"),
        items: [
          { name: t("settings.toolsEnabled"), desc: t("settings.toolsEnabledDesc"), control: { type: "toggle", key: "toolsEnabled" } },
          { name: t("settings.scriptsEnabled"), desc: t("settings.scriptsEnabledDesc"), control: { type: "toggle", key: "scriptsEnabled" } },
          { name: t("settings.toolTag"), desc: t("settings.toolTagDesc"), control: tagControl("toolTag", "mcp/tool") },
          { name: t("settings.requestTag"), desc: t("settings.requestTagDesc"), control: tagControl("requestTag", "api/request") },
          { name: t("settings.scriptTimeout"), control: numberControl("scriptTimeoutSeconds") },
        ],
      },
      {
        type: "group",
        heading: t("view.section.logs"),
        items: [{ name: t("view.log.clear"), render: (setting) => this.renderLogClear(setting), searchable: false }],
      },
    ];
  }

  getControlValue(key: string): unknown {
    return this.plugin.data.settings[key as keyof Settings];
  }

  async setControlValue(key: string, value: unknown): Promise<void> {
    const s = this.plugin.data.settings;
    if (key === "language" && isLanguage(value)) {
      await this.plugin.setLanguageSetting(value);
      this.update(); // redraw the settings in the new language
    } else if (key === "serverEnabled") {
      await this.plugin.setServerEnabled(value === true);
    } else if (key === "mcpServerName" && typeof value === "string") {
      await this.plugin.setMcpServerName(value.trim());
    } else if (key === "toolsEnabled") {
      await this.plugin.setToolsEnabled(value === true);
    } else if (isTextKey(key) && typeof value === "string") {
      s[key] = value.trim().replace(/^#/, "");
      await this.plugin.saveAll();
      this.plugin.onToolSettingsChanged();
    } else if (isBooleanKey(key)) {
      s[key] = value === true;
      if (key === "showNamesWhileLocked") {
        // Off: forget the names now. On: rebuild them if the vault is unlocked.
        if (!s.showNamesWhileLocked) this.plugin.data.nameIndex = [];
        this.plugin.syncNameIndex();
      }
      await this.plugin.saveAll();
      if (key === "scriptsEnabled") this.plugin.onToolSettingsChanged();
    } else if (isNumberKey(key) && typeof value === "number") {
      s[key] = value;
      await this.plugin.saveAll();
      if (key === "port") await this.plugin.restartServer();
    }
  }

  private renderPasswordChange(setting: Setting): void {
    let current: TextComponent | null = null;
    let next: TextComponent | null = null;
    setting
      .setName(t("settings.changePassword"))
      .addText((txt) => {
        txt.inputEl.type = "password";
        txt.setPlaceholder(t("settings.current"));
        current = txt;
      })
      .addText((txt) => {
        txt.inputEl.type = "password";
        txt.setPlaceholder(t("settings.newPassword"));
        next = txt;
      })
      .addButton((b) =>
        b.setButtonText(t("settings.changePasswordButton")).onClick(() => {
          void (async () => {
            try {
              await this.plugin.store.changePassword(current?.getValue() ?? "", next?.getValue() ?? "");
              current?.setValue("");
              next?.setValue("");
              new Notice(t("settings.passwordChanged"));
            } catch (err) {
              new Notice(err instanceof Error ? err.message : String(err));
            }
          })();
        }),
      );
  }

  private renderLogClear(setting: Setting): void {
    const count = () => this.plugin.audit.list().length;
    setting
      .setName(t("view.log.clear"))
      .setDesc(t("settings.logCount", { n: count() }))
      .addButton((b) =>
        b.setButtonText(t("view.log.clear")).onClick(() => {
          this.plugin.audit.clear();
          setting.setDesc(t("settings.logCount", { n: count() }));
        }),
      );
  }

  private renderStorage(setting: Setting): void {
    const path = this.plugin.vaultFilePath;
    setting.setName(t("settings.storageFile")).setDesc(t("settings.storageDesc", { path }));
    void this.plugin.app.vault.adapter
      .read(path)
      .then((text) => setting.setDesc(`${t("settings.storageDesc", { path })} ${t("settings.format", { format: describeVault(text) })}`))
      .catch(() => undefined);
  }
}

function numberControl(key: NumberKey) {
  const [min, max] = RANGES[key];
  return {
    type: "number" as const,
    key,
    min,
    max,
    step: 1,
    validate: (v: number) => (Number.isInteger(v) && v >= min && v <= max ? undefined : t("settings.range", { min, max })),
  };
}

function tagControl(key: TextKey, placeholder: string) {
  return {
    type: "text" as const,
    key,
    placeholder,
    validate: (v: string) => (TAG_PATTERN.test(v.trim().replace(/^#/, "")) ? undefined : t("settings.tagInvalid")),
  };
}

function isLanguage(value: unknown): value is LanguageSetting {
  return value === "auto" || value === "en" || value === "pt-BR";
}

function isTextKey(key: string): key is TextKey {
  return key === "toolTag" || key === "requestTag";
}

function isNumberKey(key: string): key is NumberKey {
  return key in RANGES;
}

function isBooleanKey(key: string): key is BooleanKey {
  return key === "serverEnabled" || key === "warnOnTokenPaste" || key === "showNamesWhileLocked" || key === "toolsEnabled" || key === "scriptsEnabled";
}
