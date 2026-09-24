import { App, Notice, PluginSettingTab, Setting, SettingDefinitionItem, TextComponent } from "obsidian";
import { describeVault } from "../crypto/vaultFile";
import { t } from "../i18n";
import type EnvironmentVariablesPlugin from "../main";
import { Settings } from "../settings";

type NumberKey = { [K in keyof Settings]: Settings[K] extends number ? K : never }[keyof Settings];
type BooleanKey = { [K in keyof Settings]: Settings[K] extends boolean ? K : never }[keyof Settings];

const RANGES: Record<NumberKey, [number, number]> = {
  port: [1024, 65535],
  autoLockMinutes: [0, 1440],
  approvalTimeoutSeconds: [10, 600],
  timeoutSeconds: [1, 600],
  maxResponseMB: [1, 200],
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
        heading: t("settings.server"),
        items: [
          { name: t("settings.serverEnabled"), desc: t("settings.serverEnabledDesc"), control: { type: "toggle", key: "serverEnabled" } },
          { name: t("settings.port"), control: numberControl("port") },
        ],
      },
      {
        type: "group",
        heading: t("settings.security"),
        items: [
          { name: t("settings.autoLock"), desc: t("settings.autoLockDesc"), control: numberControl("autoLockMinutes") },
          { name: t("settings.approvalTimeout"), control: numberControl("approvalTimeoutSeconds") },
          { name: t("settings.warnPaste"), desc: t("settings.warnPasteDesc"), control: { type: "toggle", key: "warnOnTokenPaste" } },
          { name: t("settings.namesLocked"), desc: t("settings.namesLockedDesc"), control: { type: "toggle", key: "showNamesWhileLocked" } },
          { name: t("settings.changePassword"), render: (setting) => this.renderPasswordChange(setting) },
        ],
      },
      {
        type: "group",
        heading: t("settings.limits"),
        items: [
          { name: t("settings.timeout"), control: numberControl("timeoutSeconds") },
          { name: t("settings.maxResponse"), control: numberControl("maxResponseMB") },
        ],
      },
      {
        type: "group",
        heading: t("settings.storage"),
        items: [{ name: t("settings.storageFile"), render: (setting) => this.renderStorage(setting), searchable: false }],
      },
    ];
  }

  getControlValue(key: string): unknown {
    return this.plugin.data.settings[key as keyof Settings];
  }

  async setControlValue(key: string, value: unknown): Promise<void> {
    const s = this.plugin.data.settings;
    if (key === "serverEnabled") {
      await this.plugin.setServerEnabled(value === true);
    } else if (isBooleanKey(key)) {
      s[key] = value === true;
      if (key === "showNamesWhileLocked") {
        // Off: forget the names now. On: rebuild them if the vault is unlocked.
        if (!s.showNamesWhileLocked) this.plugin.data.nameIndex = [];
        this.plugin.syncNameIndex();
      }
      await this.plugin.saveAll();
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

function isNumberKey(key: string): key is NumberKey {
  return key in RANGES;
}

function isBooleanKey(key: string): key is BooleanKey {
  return key === "serverEnabled" || key === "warnOnTokenPaste" || key === "showNamesWhileLocked";
}
