import { App, Notice, PluginSettingTab, Setting, TextComponent } from "obsidian";
import { describeVault } from "../crypto/vaultFile";
import { cleanFolder } from "../ecosystem/hooksFeed";
import { t } from "../i18n";
import type EnvironmentVariablesPlugin from "../main";
import { SERVER_NAME_PATTERN } from "../server/vaultIdentity";
import { LanguageSetting, Settings } from "../settings";

type NumberKey = { [K in keyof Settings]: Settings[K] extends number ? K : never }[keyof Settings];
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

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    const s = this.plugin.data.settings;

    // --- Language ---
    new Setting(containerEl).setHeading().setName(t("settings.languageGroup"));

    new Setting(containerEl)
      .setName(t("settings.language"))
      .setDesc(t("settings.languageDesc"))
      .addDropdown((drop) => {
        drop
          .addOption("auto", t("settings.languageAuto"))
          .addOption("en", "English")
          .addOption("pt-BR", "Português (Brasil)")
          .setValue(s.language)
          .onChange(async (value) => {
            if (isLanguage(value)) {
              await this.plugin.setLanguageSetting(value);
              this.display();
            }
          });
      });

    // --- Vault & Storage ---
    new Setting(containerEl).setHeading().setName(t("view.section.env"));

    this.addNumberSetting(
      containerEl,
      t("settings.autoLock"),
      t("settings.autoLockDesc"),
      "autoLockMinutes",
    );

    new Setting(containerEl)
      .setName(t("settings.warnPaste"))
      .setDesc(t("settings.warnPasteDesc"))
      .addToggle((toggle) => {
        toggle.setValue(s.warnOnTokenPaste).onChange(async (val) => {
          s.warnOnTokenPaste = val;
          await this.plugin.saveAll();
        });
      });

    new Setting(containerEl)
      .setName(t("settings.namesLocked"))
      .setDesc(t("settings.namesLockedDesc"))
      .addToggle((toggle) => {
        toggle.setValue(s.showNamesWhileLocked).onChange(async (val) => {
          s.showNamesWhileLocked = val;
          if (!val) this.plugin.data.nameIndex = [];
          this.plugin.syncNameIndex();
          await this.plugin.saveAll();
        });
      });

    this.renderPasswordChange(new Setting(containerEl));
    this.renderStorage(new Setting(containerEl));

    // --- MCP Server (shown only in standalone transition mode) ---
    if (!this.plugin.isEcosystemConnected) {
      new Setting(containerEl).setHeading().setName(t("view.section.mcp"));

      new Setting(containerEl)
        .setName(t("settings.serverEnabled"))
        .setDesc(t("settings.serverEnabledDesc"))
        .addToggle((toggle) => {
          toggle.setValue(s.serverEnabled).onChange(async (val) => {
            await this.plugin.setServerEnabled(val);
          });
        });

      this.addNumberSetting(
        containerEl,
        t("settings.port"),
        t("settings.portDesc"),
        "port",
        async () => {
          await this.plugin.restartServer();
        },
      );

      new Setting(containerEl)
        .setName(t("settings.serverName"))
        .setDesc(t("settings.serverNameDesc"))
        .addText((text) => {
          text.setValue(s.mcpServerName).onChange(async (val) => {
            const trimmed = val.trim();
            if (SERVER_NAME_PATTERN.test(trimmed)) {
              text.inputEl.removeClass("has-error");
              await this.plugin.setMcpServerName(trimmed);
            } else {
              text.inputEl.addClass("has-error");
            }
          });
        });
    }

    this.addNumberSetting(containerEl, t("settings.approvalTimeout"), "", "approvalTimeoutSeconds");
    this.addNumberSetting(containerEl, t("settings.timeout"), "", "timeoutSeconds");
    this.addNumberSetting(containerEl, t("settings.maxResponse"), "", "maxResponseMB");

    // --- Vault Tools & Scripts ---
    new Setting(containerEl).setHeading().setName(t("settings.toolsGroup"));

    new Setting(containerEl)
      .setName(t("settings.toolsEnabled"))
      .setDesc(t("settings.toolsEnabledDesc"))
      .addToggle((toggle) => {
        toggle.setValue(s.toolsEnabled).onChange(async (val) => {
          await this.plugin.setToolsEnabled(val);
        });
      });

    new Setting(containerEl)
      .setName(t("settings.scriptsEnabled"))
      .setDesc(t("settings.scriptsEnabledDesc"))
      .addToggle((toggle) => {
        toggle.setValue(s.scriptsEnabled).onChange(async (val) => {
          s.scriptsEnabled = val;
          await this.plugin.saveAll();
          this.plugin.onToolSettingsChanged();
        });
      });

    this.addTagSetting(containerEl, t("settings.toolTag"), t("settings.toolTagDesc"), "toolTag", "mcp/tool");
    this.addTagSetting(containerEl, t("settings.requestTag"), t("settings.requestTagDesc"), "requestTag", "api/request");

    new Setting(containerEl)
      .setName(t("settings.toolNotesFolder"))
      .setDesc(t("settings.toolNotesFolderDesc"))
      .addText((text) => {
        text
          .setPlaceholder("MCP")
          .setValue(s.toolNotesFolder)
          .onChange(async (raw) => {
            const folder = cleanFolder(raw);
            if (raw.trim() === "" || folder) {
              text.inputEl.removeClass("has-error");
              await this.plugin.setToolNotesFolder(folder);
            } else {
              text.inputEl.addClass("has-error");
            }
          });
      });
    this.addNumberSetting(containerEl, t("settings.scriptTimeout"), "", "scriptTimeoutSeconds");

    // --- Logs ---
    new Setting(containerEl).setHeading().setName(t("view.section.logs"));
    this.renderLogClear(new Setting(containerEl));
  }

  private addNumberSetting(
    containerEl: HTMLElement,
    name: string,
    desc: string,
    key: NumberKey,
    onValidChange?: (val: number) => Promise<void> | void,
  ): void {
    const s = this.plugin.data.settings;
    const [min, max] = RANGES[key];
    const setting = new Setting(containerEl).setName(name);
    if (desc) setting.setDesc(desc);

    setting.addText((text) => {
      text.inputEl.type = "number";
      text.inputEl.min = String(min);
      text.inputEl.max = String(max);
      text.setValue(String(s[key]));
      text.onChange(async (raw) => {
        const val = parseInt(raw, 10);
        if (Number.isInteger(val) && val >= min && val <= max) {
          text.inputEl.removeClass("has-error");
          s[key] = val;
          await this.plugin.saveAll();
          if (onValidChange) await onValidChange(val);
        } else {
          text.inputEl.addClass("has-error");
        }
      });
    });
  }

  private addTagSetting(
    containerEl: HTMLElement,
    name: string,
    desc: string,
    key: TextKey,
    placeholder: string,
  ): void {
    const s = this.plugin.data.settings;
    new Setting(containerEl)
      .setName(name)
      .setDesc(desc)
      .addText((text) => {
        text
          .setPlaceholder(placeholder)
          .setValue(s[key])
          .onChange(async (raw) => {
            const cleaned = raw.trim().replace(/^#/, "");
            if (TAG_PATTERN.test(cleaned)) {
              text.inputEl.removeClass("has-error");
              s[key] = cleaned;
              await this.plugin.saveAll();
              this.plugin.onToolSettingsChanged();
            } else {
              text.inputEl.addClass("has-error");
            }
          });
      });
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

function isLanguage(value: unknown): value is LanguageSetting {
  return value === "auto" || value === "en" || value === "pt-BR";
}
