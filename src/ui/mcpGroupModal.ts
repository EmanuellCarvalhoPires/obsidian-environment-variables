import { App, Modal, Setting } from "obsidian";
import { t } from "../i18n";
import { McpAppConfig, McpGroupConfig, parseLinkLines, validateMcpGroupName } from "../tools/mcpGroups";
import { addLogoSetting } from "./logoPicker";

/** Creates or edits an MCP: its logo, name, which app it belongs to (if any), and which tools count as members. */
export class McpGroupModal extends Modal {
  private name: string;
  private logo: string;
  private tag: string;
  private linksText: string;
  private appId: string | undefined;

  constructor(
    app: App,
    private readonly apps: McpAppConfig[],
    private readonly existing: McpGroupConfig[],
    private readonly group: McpGroupConfig,
    private readonly onSave: (group: McpGroupConfig) => void | Promise<void>,
  ) {
    super(app);
    this.name = group.name;
    this.logo = group.logo;
    this.tag = group.tag;
    this.linksText = group.links.join("\n");
    this.appId = group.appId;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass("ev-mcp-group-modal");
    this.titleEl.setText(this.group.name ? t("modal.mcpGroup.editTitle") : t("modal.mcpGroup.title"));

    const error = contentEl.createDiv({ cls: "ev-error" });
    addLogoSetting(contentEl, this.logo, (message) => error.setText(message), (uri) => (this.logo = uri));

    new Setting(contentEl)
      .setName(t("modal.mcpGroup.name"))
      .addText((txt) => txt.setValue(this.name).setPlaceholder("Jira cloud mcp").onChange((v) => (this.name = v)));

    new Setting(contentEl)
      .setName(t("modal.mcpGroup.app"))
      .setDesc(t("modal.mcpGroup.appDesc"))
      .addDropdown((dd) => {
        dd.addOption("", t("modal.mcpGroup.appNone"));
        for (const app of this.apps) dd.addOption(app.id, app.name);
        dd.setValue(this.appId ?? "");
        dd.onChange((v) => (this.appId = v || undefined));
      });

    new Setting(contentEl)
      .setName(t("modal.mcpGroup.tag"))
      .setDesc(t("modal.mcpGroup.tagDesc"))
      .addText((txt) => txt.setValue(this.tag).setPlaceholder("Mcp/tool/jira").onChange((v) => (this.tag = v)));

    new Setting(contentEl)
      .setName(t("modal.mcpGroup.links"))
      .setDesc(t("modal.mcpGroup.linksDesc"))
      .addTextArea((ta) => {
        ta.setValue(this.linksText)
          .setPlaceholder("[[jira - get issue]]\n[[jira - create issue]]")
          .onChange((v) => (this.linksText = v));
        ta.inputEl.rows = 5;
      });

    new Setting(contentEl).addButton((b) =>
      b
        .setButtonText(t("modal.mcpGroup.save"))
        .setCta()
        .onClick(() => {
          const message = validateMcpGroupName(this.name, this.existing, this.group.id);
          if (message) return error.setText(message);
          error.setText("");
          const updated: McpGroupConfig = {
            ...this.group,
            name: this.name.trim(),
            logo: this.logo,
            tag: this.tag.trim(),
            links: parseLinkLines(this.linksText),
            appId: this.appId,
          };
          void this.onSave(updated);
          this.close();
        }),
    );
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
