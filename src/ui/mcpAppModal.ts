import { App, Modal, Setting } from "obsidian";
import { t } from "../i18n";
import { McpAppConfig, validateMcpAppName } from "../tools/mcpGroups";
import { addLogoSetting } from "./logoPicker";

/** Creates or edits an app card (e.g. "Atlassian"): a name and a logo, grouping one or more MCPs. */
export class McpAppModal extends Modal {
  private name: string;
  private logo: string;

  constructor(
    app: App,
    private readonly existing: McpAppConfig[],
    private readonly mcpApp: McpAppConfig,
    private readonly onSave: (app: McpAppConfig) => void | Promise<void>,
  ) {
    super(app);
    this.name = mcpApp.name;
    this.logo = mcpApp.logo;
  }

  onOpen(): void {
    const { contentEl } = this;
    this.titleEl.setText(this.mcpApp.name ? t("modal.mcpApp.editTitle") : t("modal.mcpApp.title"));

    const error = contentEl.createDiv({ cls: "ev-error" });
    addLogoSetting(contentEl, this.logo, (message) => error.setText(message), (uri) => (this.logo = uri));

    new Setting(contentEl)
      .setName(t("modal.mcpApp.name"))
      .addText((txt) => txt.setValue(this.name).setPlaceholder("Atlassian").onChange((v) => (this.name = v)));

    new Setting(contentEl).addButton((b) =>
      b
        .setButtonText(t("modal.mcpApp.save"))
        .setCta()
        .onClick(() => {
          const message = validateMcpAppName(this.name, this.existing, this.mcpApp.id);
          if (message) return error.setText(message);
          error.setText("");
          void this.onSave({ ...this.mcpApp, name: this.name.trim(), logo: this.logo });
          this.close();
        }),
    );
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
