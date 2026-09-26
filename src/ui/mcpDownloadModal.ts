import { App, Modal, Setting, setIcon, setTooltip } from "obsidian";
import { t } from "../i18n";
import type EnvironmentVariablesPlugin from "../main";
import {
  filesToInstall,
  groupCatalogEntries,
  McpCatalogEntry,
  McpCatalogGroup,
  McpDownloadSelection,
  McpPackageFile,
  McpPackageManifest,
} from "../tools/mcpCatalog";
import { defaultLogoFor } from "./defaultLogos";
import { ConfirmModal } from "./modals";

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Browses the "Download MCP" catalog and installs a whole package, or one tool at a time. */
export class McpDownloadModal extends Modal {
  constructor(
    app: App,
    private readonly plugin: EnvironmentVariablesPlugin,
    private readonly onInstalled: () => void,
  ) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText(t("modal.mcpDownload.title"));
    this.contentEl.addClass("ev-mcp-download-modal");
    void this.loadCatalog();
  }

  private async loadCatalog(): Promise<void> {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createDiv({ text: t("modal.mcpDownload.loading"), cls: "ev-muted" });
    try {
      const catalog = await this.plugin.fetchMcpCatalog();
      contentEl.empty();
      if (catalog.packages.length === 0) {
        contentEl.createDiv({ text: t("modal.mcpDownload.empty"), cls: "ev-muted ev-empty" });
        return;
      }
      const list = contentEl.createDiv({ cls: "ev-rows" });
      for (const group of groupCatalogEntries(catalog.packages)) this.renderPackageRow(list, group);
    } catch (err) {
      contentEl.empty();
      contentEl.createDiv({ text: t("modal.mcpDownload.error", { error: errorMessage(err) }), cls: "ev-error" });
      new Setting(contentEl).addButton((b) => b.setButtonText(t("modal.mcpDownload.retry")).onClick(() => void this.loadCatalog()));
    }
  }

  /**
   * A row for one download-list entry. When several catalog entries share a `groupId` (e.g. two
   * API versions of the same app), `group.entries` has more than one — they show as a single row
   * with combined counts, but each is still fetched, downloaded and deleted on its own.
   */
  private renderPackageRow(parent: HTMLElement, group: McpCatalogGroup): void {
    const wrap = parent.createDiv({ cls: "ev-mcp-download-item" });
    const row = new Setting(wrap).setClass("ev-row");

    const icon = createDiv({ cls: "ev-mcp-item-icon ev-mcp-row-icon" });
    const logo = defaultLogoFor(group.logo);
    if (logo) icon.createEl("img", { attr: { src: logo, alt: "" } });
    else setIcon(icon, "package");
    row.nameEl.prepend(icon);
    row.nameEl.createSpan({ text: group.name });

    const toolsBody = wrap.createDiv({ cls: "ev-mcp-download-tools" });
    toolsBody.hide();
    let loaded = false;
    let expanded = false;

    row.addExtraButton((b) =>
      b
        .setIcon("list")
        .setTooltip(t("modal.mcpDownload.showTools"))
        .onClick(() => {
          expanded = !expanded;
          setTooltip(b.extraSettingsEl, expanded ? t("modal.mcpDownload.hideTools") : t("modal.mcpDownload.showTools"));
          b.setIcon(expanded ? "list-x" : "list");
          toolsBody.toggle(expanded);
          if (expanded && !loaded) {
            loaded = true;
            void this.loadTools(toolsBody, group);
          }
        }),
    );

    this.attachDownload(
      wrap,
      row,
      group.entries,
      (entry) => this.plugin.fetchMcpPackageManifest(entry),
      "all",
      group.name,
      group.toolCount,
      true,
    );
  }

  /** The tool/request counts and the tool list itself only show once the row is expanded. */
  private async loadTools(container: HTMLElement, group: McpCatalogGroup): Promise<void> {
    container.empty();
    const stats = container.createDiv({ cls: "ev-mcp-download-stats" });
    stats.createSpan({ text: t("modal.mcpDownload.toolCount", { n: group.toolCount }) });
    stats.createSpan({ text: t("modal.mcpDownload.requestCount", { n: group.requestCount }) });
    container.createEl("hr", { cls: "ev-mcp-download-divider" });

    const body = container.createDiv();
    body.createDiv({ text: t("modal.mcpDownload.loadingTools"), cls: "ev-muted" });
    try {
      const manifests = await Promise.all(group.entries.map((entry) => this.plugin.fetchMcpPackageManifest(entry)));
      body.empty();
      const list = body.createDiv({ cls: "ev-rows" });
      group.entries.forEach((entry, i) => {
        for (const file of manifests[i].files) {
          if (file.kind !== "tool") continue;
          this.renderToolRow(list, entry, manifests[i], file);
        }
      });
    } catch (err) {
      body.empty();
      body.createDiv({ text: t("modal.mcpDownload.toolsError", { error: errorMessage(err) }), cls: "ev-error" });
    }
  }

  private renderToolRow(parent: HTMLElement, entry: McpCatalogEntry, manifest: McpPackageManifest, file: McpPackageFile): void {
    const wrap = parent.createDiv({ cls: "ev-mcp-download-item" });
    const row = new Setting(wrap).setClass("ev-row").setName(file.title ?? file.name ?? file.path);
    if (file.writes) row.nameEl.createSpan({ text: t("modal.mcpDownload.writes"), cls: "ev-badge ev-warning" });
    this.attachDownload(wrap, row, [entry], () => Promise.resolve(manifest), { toolPath: file.path }, file.title ?? file.name ?? file.path, 0);
  }

  /** True once every entry behind this row has a matching installed MCP group. */
  private isInstalled(entries: McpCatalogEntry[]): boolean {
    return entries.every((e) => this.plugin.data.mcpGroups.some((g) => g.sourcePackageId === e.id));
  }

  /**
   * Adds a "Download" button to `row` with its own progress bar and status line in `wrap`.
   * `entries` is one catalog entry, or several sharing a `groupId` — each is fetched and
   * downloaded on its own, but the button and its progress bar are shared.
   * For a whole package (`isPackage`), once every entry is installed the button turns into
   * "Excluir": the MCP is confirmed installed, so removing it (all of its entries) is one click away.
   */
  private attachDownload(
    wrap: HTMLElement,
    row: Setting,
    entries: McpCatalogEntry[],
    getManifest: (entry: McpCatalogEntry) => Promise<McpPackageManifest>,
    selection: McpDownloadSelection,
    displayName: string,
    confirmToolCount: number,
    isPackage = false,
  ): void {
    const progress = wrap.createDiv({ cls: "ev-progress" });
    const bar = progress.createDiv({ cls: "ev-progress-bar" });
    progress.hide();
    const status = wrap.createDiv({ cls: "ev-mcp-download-status" });

    row.addButton((b) => {
      const setDownloadMode = () => b.setButtonText(t("modal.mcpDownload.download")).setCta().buttonEl.removeClass("mod-warning");
      const setDeleteMode = () => b.setButtonText(t("modal.mcpDownload.delete")).buttonEl.addClass("mod-warning");

      const download = async () => {
        b.setDisabled(true);
        status.removeClass("ev-error");
        status.setText(t("modal.mcpDownload.installing"));
        bar.setCssProps({ width: "0%" });
        progress.show();
        try {
          const manifests = await Promise.all(entries.map((entry) => getManifest(entry)));
          const fileCounts = manifests.map((m) => filesToInstall(m, selection).length);
          const totalCount = fileCounts.reduce((a, n) => a + n, 0);
          let doneSoFar = 0;
          let written = 0;
          let skipped = 0;
          let templateCreated = false;
          for (let i = 0; i < entries.length; i++) {
            const before = doneSoFar;
            const res = await this.plugin.downloadMcpPackage(entries[i], manifests[i], selection, (done) => {
              bar.setCssProps({ width: `${totalCount > 0 ? Math.round(((before + done) / totalCount) * 100) : 100}%` });
            });
            doneSoFar += fileCounts[i];
            written += res.written;
            skipped += res.skipped;
            templateCreated = templateCreated || res.templateCreated;
          }
          let message = t("modal.mcpDownload.installed", { written, skipped });
          if (templateCreated) message += t("modal.mcpDownload.templateCreated");
          status.setText(message);
          if (isPackage) setDeleteMode();
          this.onInstalled();
        } catch (err) {
          status.setText(errorMessage(err));
          status.addClass("ev-error");
        } finally {
          b.setDisabled(false);
        }
      };

      const remove = () => {
        const groups = entries.map((e) => this.plugin.data.mcpGroups.find((g) => g.sourcePackageId === e.id));
        if (groups.some((g) => !g)) return;
        new ConfirmModal(
          this.app,
          t("modal.mcpDownload.deleteConfirm", { name: displayName }),
          (deleteNotes) => {
            void Promise.all(groups.map((g) => this.plugin.removeMcpGroup(g!.id, deleteNotes))).then(() => {
              progress.hide();
              status.setText("");
              setDownloadMode();
              this.onInstalled();
            });
          },
          { label: t("modal.mcpDownload.deleteNotesToo", { n: confirmToolCount }) },
        ).open();
      };

      b.onClick(() => void (isPackage && this.isInstalled(entries) ? remove() : download()));

      if (isPackage && this.isInstalled(entries)) setDeleteMode();
      else setDownloadMode();
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
