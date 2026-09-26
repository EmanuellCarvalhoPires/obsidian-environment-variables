import { ItemView, Notice, setIcon, Setting, setTooltip, ToggleComponent, WorkspaceLeaf } from "obsidian";
import { WrongPasswordError } from "../crypto/vaultFile";
import { t } from "../i18n";
import { Integration, IntegrationId, INTEGRATIONS } from "../integrations/integrations";
import type EnvironmentVariablesPlugin from "../main";
import { MIN_PASSWORD_LENGTH, passwordStrength } from "../store/secretStore";
import { SecretRecord } from "../store/types";
import { wildcardRisk } from "../engine/hosts";
import { accessOf, ClientAccess, ClientRecord } from "../server/clients";
import { AccessModal, ClientTokenModal, ConfirmModal, hostsLabel, PromptModal, referenceFor, SecretModal } from "./modals";
import { GUIDE_MODES, GuideMode } from "../tools/guide";
import { McpAppConfig, McpGroupConfig, McpGroupStats, newMcpApp, newMcpGroup } from "../tools/mcpGroups";
import { ToolEntry } from "../tools/types";
import { iconLine } from "./dom";
import { McpAppModal } from "./mcpAppModal";
import { McpDownloadModal } from "./mcpDownloadModal";
import { McpGroupModal } from "./mcpGroupModal";
import { ToolRunModal } from "./toolModals";

export const VIEW_TYPE = "environment-variables-view";
export const ICON_UNLOCKED = "key-round";
export const ICON_LOCKED = "lock";

export class EnvironmentVariablesView extends ItemView {
  private query = "";
  private unsubscribers: Array<() => void> = [];
  private vaultExists: boolean | null = null;
  private busy = false;
  private error = "";
  private clientsOpen: boolean | undefined;
  private toolsOpen: boolean | undefined;
  private logOpen = false;
  private guideVisible: GuideMode | null = null;
  private connecting: IntegrationId | null = null;
  private detected = new Map<IntegrationId, boolean>();

  constructor(
    leaf: WorkspaceLeaf,
    private readonly plugin: EnvironmentVariablesPlugin,
  ) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE;
  }

  getDisplayText(): string {
    return t("plugin.name");
  }

  getIcon(): string {
    return ICON_UNLOCKED;
  }

  async onOpen(): Promise<void> {
    this.unsubscribers.push(
      this.plugin.store.onChange(() => void this.refresh()),
      this.plugin.audit.onChange(() => {
        if (this.plugin.store.isUnlocked) void this.refresh();
      }),
      this.plugin.onServerChange(() => void this.refresh()),
      this.plugin.registry.onChange(() => void this.refresh()),
    );
    this.containerEl.addEventListener("pointerdown", () => this.plugin.touch());
    await this.refresh();
  }

  async onClose(): Promise<void> {
    for (const u of this.unsubscribers) u();
    this.unsubscribers = [];
  }

  async refresh(): Promise<void> {
    this.vaultExists = await this.plugin.store.exists();
    this.render();
  }

  private render(): void {
    const root = this.contentEl;
    root.empty();
    root.addClass("ev-view");
    if (this.vaultExists === false) return this.renderCreate(root);
    if (!this.plugin.store.isUnlocked) return this.renderUnlock(root);
    this.renderUnlocked(root);
  }

  // ---------- locked states ----------

  private renderCreate(root: HTMLElement): void {
    const box = root.createDiv({ cls: "ev-lock-box" });
    const icon = box.createDiv({ cls: "ev-lock-icon" });
    setIcon(icon, ICON_UNLOCKED);
    box.createEl("h3", { text: t("view.create.title") });
    box.createEl("p", { text: t("view.create.body"), cls: "ev-muted" });
    const pass = passwordInput(box, t("view.create.password"));
    const meter = box.createDiv({ cls: "ev-meter" });
    const bar = meter.createDiv({ cls: "ev-meter-bar" });
    const label = box.createDiv({ cls: "ev-muted ev-meter-label" });
    const confirm = passwordInput(box, t("view.create.confirm"));
    const update = () => {
      const s = passwordStrength(pass.value);
      bar.style.width = `${pass.value ? Math.max(10, s * 25) : 0}%`;
      bar.dataset.score = String(s);
      label.setText(pass.value ? t(`strength.${s as 0 | 1 | 2 | 3 | 4}`) : "");
    };
    pass.addEventListener("input", update);
    this.renderError(box);
    const btn = box.createEl("button", { text: t("view.create.button"), cls: "mod-cta" });
    const submit = async () => {
      if (pass.value !== confirm.value) return this.showError(t("view.create.mismatch"));
      if (pass.value.length < MIN_PASSWORD_LENGTH) return this.showError(t("strength.0"));
      await this.runBusy(btn, async () => {
        await this.plugin.store.create(pass.value);
        pass.value = confirm.value = "";
      });
    };
    btn.addEventListener("click", () => void submit());
    confirm.addEventListener("keydown", (e) => e.key === "Enter" && void submit());
    window.setTimeout(() => pass.focus(), 0);
  }

  private renderUnlock(root: HTMLElement): void {
    const box = root.createDiv({ cls: "ev-lock-box" });
    const icon = box.createDiv({ cls: "ev-lock-icon" });
    setIcon(icon, ICON_LOCKED);
    box.createEl("h3", { text: t("view.unlock.title") });
    box.createEl("p", { text: t("view.unlock.body"), cls: "ev-muted" });
    const pass = passwordInput(box, t("view.unlock.password"));
    this.renderError(box);
    const btn = box.createEl("button", { text: t("view.unlock.button"), cls: "mod-cta" });
    const submit = async () => {
      await this.runBusy(btn, async () => {
        try {
          await this.plugin.store.unlock(pass.value);
          this.plugin.touch();
        } catch (err) {
          if (err instanceof WrongPasswordError) throw new Error(t("view.unlock.wrong"));
          throw err;
        } finally {
          pass.value = "";
        }
      });
    };
    btn.addEventListener("click", () => void submit());
    pass.addEventListener("keydown", (e) => e.key === "Enter" && void submit());
    window.setTimeout(() => pass.focus(), 0);
  }

  private renderError(parent: HTMLElement): void {
    if (this.error) parent.createDiv({ text: this.error, cls: "ev-error" });
  }

  private showError(message: string): void {
    this.error = message;
    this.render();
    this.error = "";
  }

  private async runBusy(btn: HTMLButtonElement, fn: () => Promise<void>): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    btn.disabled = true;
    btn.setText(t("view.unlocking"));
    try {
      await fn();
      this.error = "";
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
    } finally {
      this.busy = false;
    }
    await this.refresh();
    this.error = "";
  }


  // ---------- unlocked: three sections ----------

  private renderUnlocked(root: HTMLElement): void {
    this.renderServerHeader(root);
    this.renderSecrets(root);
    this.renderMcp(root);
    this.renderMcpGroups(root);
    this.renderLog(root);
  }

  /** The state of the local MCP server, always at the top of the panel. */
  private renderServerHeader(root: HTMLElement): void {
    const running = this.plugin.server?.running ?? false;
    const header = new Setting(root).setName(t("settings.server")).setClass("ev-server-header");
    header.nameEl.prepend(createSpan({ cls: `ev-dot ${running ? "is-on" : "is-off"}` }));
    header.setDesc(`${running ? `127.0.0.1:${this.plugin.data.settings.port}` : t("view.server.off")} · ${this.plugin.serverName}`);
    header.addButton((b) => {
      b.setButtonText(running ? t("view.server.stop") : t("view.server.start")).onClick(() => void this.plugin.setServerEnabled(!running));
      if (!running) b.setCta();
    });
  }

  // ---------- Environment Variables ----------

  private renderSecrets(root: HTMLElement): void {
    const section = root.createDiv({ cls: "ev-section" });
    const heading = sectionHeading(section, t("view.section.env"));
    badge(heading.nameEl, t("view.status.unlocked"), "ev-badge-ok", ICON_UNLOCKED);
    heading.addButton((b) => b.setButtonText(t("view.lockNow")).onClick(() => this.plugin.lock()));

    const toolbar = section.createDiv({ cls: "ev-toolbar" });
    const search = toolbar.createEl("input", { type: "search", placeholder: t("view.search"), value: this.query });
    search.addEventListener("input", () => {
      this.query = search.value;
      this.renderList(list);
    });
    const add = toolbar.createEl("button", { text: t("view.new"), cls: "mod-cta" });
    add.addEventListener("click", () => new SecretModal(this.app, this.plugin.store, null).open());

    const list = section.createDiv({ cls: "ev-rows" });
    this.renderList(list);
  }

  private renderList(list: HTMLElement): void {
    list.empty();
    const q = this.query.toLowerCase();
    const secrets = this.plugin.store
      .list()
      .filter((s) => !q || s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q) || s.allowedHosts.some((h) => h.includes(q)));
    if (secrets.length === 0) {
      list.createDiv({ text: t("view.empty"), cls: "ev-muted ev-empty" });
      return;
    }
    for (const secret of secrets) this.renderItem(list, secret);
  }

  private renderItem(list: HTMLElement, secret: SecretRecord): void {
    const row = new Setting(list).setClass("ev-row");
    const name = row.nameEl.createSpan({ text: secret.name, cls: "ev-item-name" });
    row.nameEl.createSpan({ text: t(`type.${secret.type}`), cls: "ev-badge" });
    const lastUsed = `${t("view.col.lastUsed")}: ${secret.lastUsedAt ? new Date(secret.lastUsedAt).toLocaleString() : t("view.never")}`;
    setTooltip(name, secret.description ? `${secret.description}\n${lastUsed}` : lastUsed);
    row.descEl.createSpan({
      text: hostsLabel(secret),
      cls: secret.allowAnyHost === true || secret.allowedHosts.length === 0 ? "ev-warning" : "",
    });
    const shared = secret.allowAnyHost === true ? [] : secret.allowedHosts.filter((h) => wildcardRisk(h) === "multitenant");
    if (shared.length) iconLine(row.descEl, "alert-triangle", t("view.multitenantWarning", { hosts: shared.join(", ") }), "ev-warning");

    row.addExtraButton((b) =>
      b.setIcon("copy").setTooltip(t("view.copyKey")).onClick(() => {
        const ref = referenceFor(secret);
        void navigator.clipboard.writeText(ref);
        new Notice(t("view.copied", { key: ref }));
      }),
    );
    row.addExtraButton((b) => b.setIcon("pencil").setTooltip(t("view.edit")).onClick(() => new SecretModal(this.app, this.plugin.store, secret).open()));
    row.addExtraButton((b) =>
      b
        .setIcon("trash-2")
        .setTooltip(t("view.delete"))
        .onClick(() => new ConfirmModal(this.app, t("view.deleteConfirm", { name: secret.name }), () => this.plugin.store.remove(secret.id)).open()),
    );
  }

  // ---------- Local MCP Settings ----------

  private renderMcp(root: HTMLElement): void {
    const section = root.createDiv({ cls: "ev-section" });
    sectionHeading(section, t("view.section.mcp"));

    const clients = this.plugin.data.clients;
    this.renderClients(collapsible(section, t("view.clients.title"), this.clientsOpen ?? clients.length === 0, (open) => (this.clientsOpen = open)));

    const settings = this.plugin.data.settings;
    const entries = this.plugin.registry.list();
    const toolsOpen = this.toolsOpen ?? (settings.toolsEnabled && entries.some((e) => e.status !== "ready"));
    this.renderTools(collapsible(section, t("view.tools.title"), toolsOpen, (open) => (this.toolsOpen = open)));
  }

  private renderTools(body: HTMLElement): void {
    const settings = this.plugin.data.settings;
    const entries = this.plugin.registry.list();

    const tools = new Setting(body)
      .setName(t("settings.toolsEnabled"))
      .setClass("ev-row")
      .addToggle((tg) => tg.setValue(settings.toolsEnabled).onChange((v) => void this.plugin.setToolsEnabled(v)));
    setTooltip(tools.nameEl, t("settings.toolsEnabledDesc"));
    const scripts = new Setting(body)
      .setName(t("settings.scriptsEnabled"))
      .setClass("ev-row")
      .setDisabled(!settings.toolsEnabled)
      .addToggle((tg) => tg.setValue(settings.scriptsEnabled).setDisabled(!settings.toolsEnabled).onChange((v) => void this.plugin.setScriptsEnabled(v)));
    setTooltip(scripts.nameEl, t("settings.scriptsEnabledDesc"));

    if (!settings.toolsEnabled) {
      body.createEl("p", { text: t("view.tools.off"), cls: "ev-muted" });
      return;
    }

    // The prompts for AI agents: how the tools work and the mandatory plan-first workflow, one per task.
    subHeading(body, t("view.tools.guideTitle"), { info: t("view.tools.guideBody") });
    for (const mode of GUIDE_MODES) this.renderPrompt(body, mode);

    subHeading(body, t("view.tools.listTitle"), { count: entries.length });
    if (entries.length === 0) {
      body.createDiv({ text: t("view.tools.empty", { tag: settings.toolTag }), cls: "ev-muted ev-empty" });
      return;
    }
    for (const entry of entries) this.renderTool(body, entry);
  }

  private renderPrompt(body: HTMLElement, mode: GuideMode): void {
    const shown = this.guideVisible === mode;
    const row = new Setting(body)
      .setName(t(`view.tools.prompt.${mode}`))
      .setClass("ev-row")
      .addExtraButton((b) =>
        b
          .setIcon(shown ? "eye-off" : "eye")
          .setTooltip(shown ? t("view.tools.hideGuide") : t("view.tools.showGuide"))
          .onClick(() => {
            this.guideVisible = shown ? null : mode;
            this.render();
          }),
      )
      .addButton((b) => b.setButtonText(t("view.tools.copy")).setCta().onClick(() => this.plugin.copyAgentGuide(mode)));
    setTooltip(row.nameEl, t(`view.tools.prompt.${mode}Desc`));
    if (shown) body.createEl("pre", { text: this.plugin.agentGuide(undefined, mode), cls: "ev-tool-guide" });
  }

  private renderTool(body: HTMLElement, entry: ToolEntry): void {
    const row = new Setting(body).setClass("ev-row");
    row.nameEl.createSpan({ text: entry.name, cls: "ev-item-name", attr: entry.description ? { title: entry.description } : {} });
    if (entry.kind) row.nameEl.createSpan({ text: entry.kind, cls: "ev-badge" });
    row.nameEl.createSpan({ text: t(`status.${entry.status}`), cls: `ev-badge ev-status-${entry.status}` });
    if (entry.writes) row.nameEl.createSpan({ text: t("view.tools.writes"), cls: "ev-badge ev-warning" });
    if (!entry.expose) row.nameEl.createSpan({ text: t("view.tools.hidden"), cls: "ev-badge" });
    for (const p of entry.problems) iconLine(row.descEl, "x-circle", p, "ev-error");
    for (const w of entry.warnings) iconLine(row.descEl, "alert-triangle", w, "ev-warning");

    row.addExtraButton((b) => b.setIcon("file-text").setTooltip(t("view.tools.open")).onClick(() => void this.app.workspace.openLinkText(entry.notePath, "", false)));
    if (entry.status === "ready") {
      row.addExtraButton((b) =>
        b
          .setIcon("play")
          .setTooltip(t("view.tools.run"))
          .onClick(() => new ToolRunModal(this.app, entry, (args) => this.plugin.tools.run(entry.name, args, this.plugin.localClient)).open()),
      );
    }
  }

  private renderClients(body: HTMLElement): void {
    for (const integration of INTEGRATIONS) this.renderIntegration(body, integration);

    const manual = this.plugin.data.clients.filter((c) => !c.integration);
    const other = subHeading(body, t("view.connect.manualTitle"), { info: t("view.clients.body") });
    const add = other.createEl("button", { cls: "clickable-icon ev-subheading-action", attr: { "aria-label": t("view.connect.manual") } });
    setIcon(add, "plus");
    add.addEventListener("click", () =>
      new PromptModal(this.app, t("view.clients.namePrompt"), (name) =>
        new AccessModal(this.app, this.plugin.store, name || "AI client", null, async (access) => {
          const token = await this.plugin.addClient(name, access);
          new ClientTokenModal(this.app, token, this.plugin.data.settings.port, this.plugin.server?.running ?? false, this.plugin.serverName).open();
        }).open(),
      ).open(),
    );
    if (manual.length === 0) body.createDiv({ text: t("view.clients.none"), cls: "ev-muted ev-empty" });
    for (const c of manual) {
      const row = new Setting(body).setClass("ev-row");
      const name = row.nameEl.createSpan({ text: c.name, cls: "ev-item-name" });
      this.accessBadge(row.nameEl, c);
      setTooltip(name, `${c.hint}… · ${t("view.col.lastUsed")}: ${c.lastUsedAt ? new Date(c.lastUsedAt).toLocaleString() : t("view.never")}`);
      row.addExtraButton((b) => b.setIcon("shield").setTooltip(t("view.access.edit")).onClick(() => this.editAccess(c)));
      row.addExtraButton((b) =>
        b
          .setIcon("x")
          .setTooltip(t("view.clients.revoke"))
          .onClick(() => new ConfirmModal(this.app, t("view.clients.revokeConfirm", { name: c.name }), () => this.plugin.revokeClient(c.id)).open()),
      );
    }
  }

  private renderIntegration(body: HTMLElement, integration: Integration): void {
    const row = new Setting(body).setName(integration.label).setClass("ev-row");
    const connected = this.plugin.connectedClient(integration.id);

    if (connected) {
      const status = badge(row.nameEl, t("view.connect.connected"), "ev-badge-ok", "check");
      setTooltip(status, `${t("view.col.lastUsed")}: ${connected.lastUsedAt ? new Date(connected.lastUsedAt).toLocaleString() : t("view.never")}`);
      this.accessBadge(row.nameEl, connected);
      row.addExtraButton((b) => b.setIcon("shield").setTooltip(t("view.access.edit")).onClick(() => this.editAccess(connected)));
      row.addExtraButton((b) =>
        b
          .setIcon("refresh-cw")
          .setTooltip(t("view.connect.reconnect"))
          .onClick(async () => {
            if (this.connecting) return;
            this.connecting = integration.id;
            b.setDisabled(true);
            try {
              await this.plugin.connectIntegration(integration.id);
            } finally {
              this.connecting = null;
              await this.refresh();
            }
          }),
      );
      row.addExtraButton((b) =>
        b
          .setIcon("unplug")
          .setTooltip(t("view.connect.disconnect"))
          .onClick(() =>
            new ConfirmModal(this.app, t("view.connect.disconnectConfirm", { client: integration.label }), () => this.plugin.revokeClient(connected.id)).open(),
          ),
      );
      return;
    }

    const known = this.detected.get(integration.id);
    if (known === undefined) {
      badge(row.nameEl, t("view.connect.checking"));
      void integration.detect().then((found) => {
        this.detected.set(integration.id, found);
        void this.refresh();
      });
      return;
    }
    if (!known) {
      badge(row.nameEl, t("view.connect.notFound"));
      row.settingEl.addClass("is-missing");
      return;
    }
    row.addButton((b) =>
      b
        .setButtonText(t("view.connect.connect"))
        .setCta()
        .onClick(() =>
          new AccessModal(this.app, this.plugin.store, integration.label, null, async (access) => {
            b.setDisabled(true).setButtonText(t("view.connect.connecting"));
            await this.plugin.connectIntegration(integration.id, access);
            await this.refresh();
          }).open(),
        ),
    );
  }

  private accessBadge(parent: HTMLElement, client: ClientRecord): void {
    const access = accessOf(client);
    const text = access.mode === "all" ? t("view.access.all") : t("view.access.some", { n: access.secretIds.length });
    parent.createSpan({ text, cls: "ev-badge" });
  }

  private editAccess(client: ClientRecord): void {
    new AccessModal(this.app, this.plugin.store, client.name, accessOf(client), (access: ClientAccess) =>
      this.plugin.setClientAccess(client.id, access),
    ).open();
  }

  // ---------- MCP groups (two levels: an optional app card lists one or more MCPs) ----------

  private renderMcpGroups(root: HTMLElement): void {
    const section = root.createDiv({ cls: "ev-section" });
    const heading = sectionHeading(section, t("view.section.mcpGroups"));
    heading.addButton((b) => b.setButtonText(t("view.mcpGroups.addApp")).onClick(() => this.openMcpAppModal(null)));
    heading.addButton((b) =>
      b.setButtonText(t("view.mcpGroups.download")).onClick(() => new McpDownloadModal(this.app, this.plugin, () => void this.refresh()).open()),
    );
    heading.addButton((b) =>
      b
        .setButtonText(t("view.mcpGroups.add"))
        .setCta()
        .onClick(() => this.openMcpGroupModal(null)),
    );

    const apps = this.plugin.data.mcpApps;
    const stats = this.plugin.mcpGroupStats();
    const byApp = new Map<string, McpGroupStats[]>();
    const standalone: McpGroupStats[] = [];
    for (const group of stats) {
      if (group.appId && apps.some((a) => a.id === group.appId)) {
        const list = byApp.get(group.appId);
        if (list) list.push(group);
        else byApp.set(group.appId, [group]);
      } else standalone.push(group);
    }

    if (apps.length === 0 && standalone.length === 0) {
      section.createDiv({ text: t("view.mcpGroups.empty"), cls: "ev-muted ev-empty" });
      return;
    }
    for (const app of apps) this.renderMcpAppCard(section, app, byApp.get(app.id) ?? []);
    for (const group of standalone) this.renderMcpGroupCard(section, group);
  }

  private openMcpGroupModal(existing: McpGroupStats | null): void {
    // Only the plain config fields go to the modal: the stats are computed, never edited or saved.
    const target: McpGroupConfig = existing
      ? {
          id: existing.id,
          name: existing.name,
          logo: existing.logo,
          enabled: existing.enabled,
          tag: existing.tag,
          links: existing.links,
          appId: existing.appId,
          sourcePackageId: existing.sourcePackageId,
        }
      : newMcpGroup();
    new McpGroupModal(this.app, this.plugin.data.mcpApps, this.plugin.data.mcpGroups, target, (updated) =>
      existing ? this.plugin.updateMcpGroup(updated) : this.plugin.addMcpGroup(updated),
    ).open();
  }

  private openMcpAppModal(existing: McpAppConfig | null): void {
    const target = existing ?? newMcpApp();
    new McpAppModal(this.app, this.plugin.data.mcpApps, target, (updated) =>
      existing ? this.plugin.updateMcpApp(updated) : this.plugin.addMcpApp(updated),
    ).open();
  }

  private renderMcpAppCard(parent: HTMLElement, app: McpAppConfig, items: McpGroupStats[]): void {
    const card = parent.createDiv({ cls: "ev-mcp-card" });
    const header = card.createDiv({ cls: "ev-mcp-card-header" });

    const title = header.createDiv({ cls: "ev-mcp-card-title" });
    const icon = title.createDiv({ cls: "ev-mcp-item-icon" });
    if (app.logo) icon.createEl("img", { attr: { src: app.logo, alt: "" } });
    else setIcon(icon, "boxes");
    const text = title.createDiv();
    text.createDiv({ text: app.name, cls: "ev-mcp-card-heading" });
    text.createDiv({ text: t(items.length === 1 ? "view.mcpGroups.appSubtitleOne" : "view.mcpGroups.appSubtitle", { n: items.length }), cls: "ev-mcp-card-subtitle" });

    const actions = header.createDiv({ cls: "ev-mcp-card-actions" });
    new ToggleComponent(actions).setValue(app.enabled).onChange((v) => void this.plugin.setMcpAppEnabled(app.id, v));
    const editBtn = actions.createEl("button", { cls: "clickable-icon", attr: { "aria-label": t("view.mcpGroups.edit") } });
    setIcon(editBtn, "pencil");
    editBtn.addEventListener("click", () => this.openMcpAppModal(app));
    const delBtn = actions.createEl("button", { cls: "clickable-icon", attr: { "aria-label": t("view.mcpGroups.delete") } });
    setIcon(delBtn, "trash-2");
    delBtn.addEventListener("click", () =>
      new ConfirmModal(this.app, t("view.mcpGroups.deleteAppConfirm", { name: app.name }), () => this.plugin.removeMcpApp(app.id)).open(),
    );

    if (items.length === 0) card.createDiv({ text: t("view.mcpGroups.appEmpty"), cls: "ev-muted ev-empty" });
    else {
      const list = card.createDiv({ cls: "ev-mcp-items" });
      for (const item of items) this.renderMcpItemRow(list, item);
    }
  }

  private renderMcpItemRow(parent: HTMLElement, item: McpGroupStats): void {
    const row = parent.createDiv({ cls: "ev-mcp-item" });

    const icon = row.createDiv({ cls: "ev-mcp-item-icon" });
    if (item.logo) icon.createEl("img", { attr: { src: item.logo, alt: "" } });
    else setIcon(icon, "layers");

    const info = row.createDiv({ cls: "ev-mcp-item-info" });
    info.createDiv({ text: item.name, cls: "ev-mcp-item-name" });
    const stats = info.createDiv({ cls: "ev-mcp-item-stats" });
    stats.createSpan({ text: t("view.mcpGroups.toolCount", { n: item.toolCount }) });
    stats.createSpan({ text: t("view.mcpGroups.requestCount", { n: item.requestCount }) });

    const controls = row.createDiv({ cls: "ev-mcp-item-controls" });
    new ToggleComponent(controls).setValue(item.enabled).onChange((v) => void this.plugin.setMcpGroupEnabled(item.id, v));
    const editBtn = controls.createEl("button", { cls: "clickable-icon", attr: { "aria-label": t("view.mcpGroups.edit") } });
    setIcon(editBtn, "pencil");
    editBtn.addEventListener("click", () => this.openMcpGroupModal(item));
    const delBtn = controls.createEl("button", { cls: "clickable-icon", attr: { "aria-label": t("view.mcpGroups.delete") } });
    setIcon(delBtn, "trash-2");
    delBtn.addEventListener("click", () =>
      new ConfirmModal(
        this.app,
        t("view.mcpGroups.deleteConfirm", { name: item.name }),
        (deleteNotes) => this.plugin.removeMcpGroup(item.id, deleteNotes),
        { label: t("view.mcpGroups.deleteNotesToo", { n: item.toolCount }) },
      ).open(),
    );
  }

  private renderMcpGroupCard(parent: HTMLElement, group: McpGroupStats): void {
    const card = parent.createDiv({ cls: "ev-mcp-card" });
    const header = card.createDiv({ cls: "ev-mcp-card-header" });

    const title = header.createDiv({ cls: "ev-mcp-card-title" });
    const icon = title.createDiv({ cls: "ev-mcp-item-icon" });
    if (group.logo) icon.createEl("img", { attr: { src: group.logo, alt: "" } });
    else setIcon(icon, "layers");
    const text = title.createDiv();
    text.createDiv({ text: group.name, cls: "ev-mcp-card-heading" });
    text.createDiv({ text: group.tag || t("view.mcpGroups.noTag"), cls: "ev-mcp-card-subtitle" });

    const actions = header.createDiv({ cls: "ev-mcp-card-actions" });
    new ToggleComponent(actions).setValue(group.enabled).onChange((v) => void this.plugin.setMcpGroupEnabled(group.id, v));
    const editBtn = actions.createEl("button", { cls: "clickable-icon", attr: { "aria-label": t("view.mcpGroups.edit") } });
    setIcon(editBtn, "pencil");
    editBtn.addEventListener("click", () => this.openMcpGroupModal(group));
    const delBtn = actions.createEl("button", { cls: "clickable-icon", attr: { "aria-label": t("view.mcpGroups.delete") } });
    setIcon(delBtn, "trash-2");
    delBtn.addEventListener("click", () =>
      new ConfirmModal(
        this.app,
        t("view.mcpGroups.deleteConfirm", { name: group.name }),
        (deleteNotes) => this.plugin.removeMcpGroup(group.id, deleteNotes),
        { label: t("view.mcpGroups.deleteNotesToo", { n: group.toolCount }) },
      ).open(),
    );

    const stats = card.createDiv({ cls: "ev-mcp-card-stats" });
    stats.createSpan({ text: t("view.mcpGroups.toolCount", { n: group.toolCount }) });
    stats.createSpan({ text: t("view.mcpGroups.requestCount", { n: group.requestCount }) });
  }

  // ---------- Logs ----------

  private renderLog(root: HTMLElement): void {
    const section = root.createDiv({ cls: "ev-section" });
    const entries = this.plugin.audit.list().slice(0, 100);
    const heading = sectionHeading(section, t("view.section.logs"));
    heading.addButton((b) =>
      b
        .setButtonText(t("view.log.clear"))
        .setDisabled(entries.length === 0)
        .onClick(() => this.plugin.audit.clear()),
    );
    if (entries.length === 0) {
      section.createDiv({ text: t("view.log.empty"), cls: "ev-muted ev-empty" });
      return;
    }
    const body = collapsible(section, t("view.log.show", { n: entries.length }), this.logOpen, (open) => (this.logOpen = open));
    const wrap = body.createDiv({ cls: "ev-log-wrap" });
    const table = wrap.createEl("table", { cls: "ev-log" });
    const head = table.createEl("thead").createEl("tr");
    for (const col of ["time", "client", "action", "variables", "result"] as const) head.createEl("th", { text: t(`view.log.col.${col}`) });
    const tbody = table.createEl("tbody");
    for (const e of entries) {
      const tr = tbody.createEl("tr", { cls: `ev-log-${e.outcome}` });
      tr.createEl("td", { text: new Date(e.time).toLocaleString() });
      tr.createEl("td", { text: e.client });
      tr.createEl("td", { text: e.action === "list" ? "list_secrets" : e.action === "tool" ? `tool ${e.tool ?? ""}` : `${e.method ?? ""} ${e.target ?? ""}` });
      tr.createEl("td", { text: e.secrets.join(", ") });
      tr.createEl("td", { text: e.status ? `${e.outcome} ${e.status}` : e.outcome, attr: { title: e.detail ?? "" } });
    }
  }
}

function passwordInput(parent: HTMLElement, placeholder: string): HTMLInputElement {
  const input = parent.createEl("input", { type: "password", placeholder, cls: "ev-password" });
  input.autocomplete = "off";
  return input;
}

/** A section title in the style of Obsidian's settings headings, with a short description. */
function sectionHeading(parent: HTMLElement, title: string): Setting {
  return new Setting(parent).setName(title).setHeading().setClass("ev-section-heading");
}

/** A small label next to a name, optionally with an icon. */
function badge(parent: HTMLElement, text: string, cls = "", icon?: string): HTMLElement {
  const el = parent.createSpan({ cls: `ev-badge ${cls}`.trim() });
  if (icon) setIcon(el.createSpan({ cls: "ev-badge-icon" }), icon);
  el.createSpan({ text });
  return el;
}

/** A smaller title inside a section, with an optional count, an info icon (text on hover) and room for actions. */
function subHeading(parent: HTMLElement, title: string, opts: { count?: number; info?: string } = {}): HTMLElement {
  const el = parent.createDiv({ cls: "ev-subheading" });
  el.createSpan({ text: title, cls: "ev-subheading-title" });
  if (opts.count !== undefined) el.createSpan({ text: String(opts.count), cls: "ev-badge" });
  if (opts.info) {
    const info = el.createSpan({ cls: "ev-subheading-info", attr: { tabindex: "0", "aria-label": opts.info } });
    setIcon(info, "info");
    setTooltip(info, opts.info);
  }
  return el;
}

/** A group that opens and closes, with a chevron like Obsidian's collapsible lists. Returns its body. */
function collapsible(parent: HTMLElement, title: string, open: boolean, onToggle: (open: boolean) => void): HTMLElement {
  const details = parent.createEl("details", { cls: "ev-group" });
  details.open = open;
  details.addEventListener("toggle", () => onToggle(details.open));
  const summary = details.createEl("summary", { cls: "ev-group-title" });
  setIcon(summary.createSpan({ cls: "ev-group-chevron" }), "chevron-right");
  summary.createSpan({ text: title });
  return details.createDiv({ cls: "ev-group-body" });
}
