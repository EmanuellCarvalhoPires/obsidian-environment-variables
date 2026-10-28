import { ItemView, Notice, setIcon, Setting, setTooltip, ToggleComponent, WorkspaceLeaf } from "obsidian";
import { AuditEntry } from "../audit/auditLog";
import { WrongPasswordError } from "../crypto/vaultFile";
import { t } from "../i18n";
import { Integration, IntegrationId, INTEGRATIONS } from "../integrations/integrations";
import type EnvironmentVariablesPlugin from "../main";
import { MIN_PASSWORD_LENGTH, passwordStrength } from "../store/secretStore";
import { SecretRecord, ValueRecord } from "../store/types";
import { wildcardRisk } from "../secrets/hosts";
import { accessOf, ClientAccess, ClientRecord } from "../server/clients";
import { AccessModal, ClientTokenModal, ConfirmModal, hostsLabel, PromptModal, referenceFor, SecretModal, ValueModal } from "./modals";
import { McpAppConfig, McpGroupConfig, McpGroupStats, newMcpApp, newMcpGroup } from "../tools/mcpGroups";
import { ToolEntry } from "../tools/types";
import { iconLine } from "./dom";
import { McpAppModal } from "./mcpAppModal";
import { McpGroupModal } from "./mcpGroupModal";
import { ToolRunModal } from "./toolModals";
import { ChangePasswordModal, ForgotPasswordModal, ShowRecoveryKeyModal } from "./recoveryModals";
import { lazySection } from "./lazySection";
import { paginate, renderPaginationControls } from "./pagination";

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
  private howToOpen = false;
  private mcpGroupsOpen: boolean | undefined;
  private logOpen = false;
  private guideVisible = false;
  private toolsQuery = "";
  private toolsPage = 1;
  private logPage = 1;
  private debounceTimer: number | undefined;
  private serverHeaderEl!: HTMLElement;
  private secretsEl!: HTMLElement;
  private valuesEl!: HTMLElement;
  private howToEl!: HTMLElement;
  private mcpEl?: HTMLElement;
  private mcpGroupsEl?: HTMLElement;
  private logEl?: HTMLElement;
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
      this.plugin.store.onChange(() => {
        this.debounce(() => {
          if (this.plugin.store.isUnlocked) {
            this.updateSecrets();
            this.updateValues();
          } else {
            void this.refresh();
          }
        });
      }),
      this.plugin.audit.onChange(() => {
        if (this.plugin.store.isUnlocked) {
          this.debounce(() => this.updateLog());
        }
      }),
      this.plugin.onServerChange(() => {
        this.debounce(() => {
          if (this.plugin.store.isUnlocked) {
            this.render();
          } else {
            void this.refresh();
          }
        });
      }),
      this.plugin.registry.onChange(() => {
        this.debounce(() => {
          this.updateMcp();
          this.updateMcpGroups();
        });
      }),
    );
    this.containerEl.addEventListener("pointerdown", () => this.plugin.touch());
    await this.refresh();
  }

  async onClose(): Promise<void> {
    if (this.debounceTimer !== undefined) {
      window.clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
    }
    for (const u of this.unsubscribers) u();
    this.unsubscribers = [];
  }

  private debounce(fn: () => void, ms = 150): void {
    if (this.debounceTimer !== undefined) window.clearTimeout(this.debounceTimer);
    this.debounceTimer = window.setTimeout(() => {
      this.debounceTimer = undefined;
      fn();
    }, ms);
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
        const recoveryKey = await this.plugin.store.create(pass.value);
        pass.value = confirm.value = "";
        new ShowRecoveryKeyModal(this.app, recoveryKey).open();
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

    const forgotLink = box.createEl("a", { text: t("view.unlock.forgot"), cls: "ev-muted ev-forgot-link" });
    forgotLink.addEventListener("click", (e) => {
      e.preventDefault();
      new ForgotPasswordModal(this.app, this.plugin.store, () => void this.refresh()).open();
    });

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
    this.serverHeaderEl = root.createDiv({ cls: "ev-section-server" });
    this.secretsEl = root.createDiv({ cls: "ev-section-secrets" });
    this.valuesEl = root.createDiv({ cls: "ev-section-values" });
    this.howToEl = root.createDiv({ cls: "ev-section-howto-wrap" });

    if (!this.plugin.isEcosystemConnected) {
      this.mcpEl = root.createDiv({ cls: "ev-section-mcp-wrap" });
      this.mcpGroupsEl = root.createDiv({ cls: "ev-section-mcpgroups-wrap" });
      this.logEl = root.createDiv({ cls: "ev-section-log-wrap" });
    } else {
      this.mcpEl = undefined;
      this.mcpGroupsEl = undefined;
      this.logEl = undefined;
    }

    this.updateServerHeader();
    this.updateSecrets();
    this.updateValues();
    this.updateHowTo();
    if (!this.plugin.isEcosystemConnected) {
      this.updateMcp();
      this.updateMcpGroups();
      this.updateLog();
    }
  }

  private updateServerHeader(): void {
    if (!this.serverHeaderEl) return;
    this.serverHeaderEl.empty();
    this.renderServerHeader(this.serverHeaderEl);
  }

  private updateSecrets(): void {
    if (!this.secretsEl) return;
    this.secretsEl.empty();
    this.renderSecrets(this.secretsEl);
  }

  private updateValues(): void {
    if (!this.valuesEl) return;
    this.valuesEl.empty();
    this.renderValues(this.valuesEl);
  }

  private updateHowTo(): void {
    if (!this.howToEl) return;
    this.howToEl.empty();
    this.renderHowToSection(this.howToEl);
  }

  private renderHowToSection(root: HTMLElement): void {
    const section = root.createDiv({ cls: "ev-section" });
    lazySection(
      section,
      t("view.howto.title"),
      this.howToOpen,
      (open) => (this.howToOpen = open),
      (body) => this.renderHowTo(body),
    );
  }

  private updateMcp(): void {
    if (!this.mcpEl) return;
    this.mcpEl.empty();
    this.renderMcp(this.mcpEl);
  }

  private updateMcpGroups(): void {
    if (!this.mcpGroupsEl) return;
    this.mcpGroupsEl.empty();
    this.renderMcpGroups(this.mcpGroupsEl);
  }

  private updateLog(): void {
    if (!this.logEl) return;
    this.logEl.empty();
    this.renderLog(this.logEl);
  }

  /** The state of the AI Ecosystem connection (or legacy transition server), always at the top of the panel. */
  private renderServerHeader(root: HTMLElement): void {
    if (this.plugin.isEcosystemConnected) {
      const header = new Setting(root).setName(t("settings.server")).setClass("ev-server-header");
      header.nameEl.prepend(createSpan({ cls: "ev-dot is-on" }));
      header.setDesc(t("view.server.ecosystem", { port: this.plugin.ecosystemPort }));
      header.addButton((b) => b.setButtonText(t("view.log.live")).onClick(() => void this.plugin.openEcosystemInspector()));
      return;
    }

    const banner = root.createDiv({ cls: "ev-transition-banner" });
    const titleRow = banner.createDiv({ cls: "ev-transition-title" });
    const icon = titleRow.createSpan({ cls: "ev-transition-icon" });
    setIcon(icon, "alert-triangle");
    titleRow.createSpan({ text: t("view.transition.title") });
    banner.createDiv({ text: t("view.transition.body"), cls: "ev-transition-body ev-muted" });
    const actions = banner.createDiv({ cls: "ev-transition-actions" });
    const installBtn = actions.createEl("button", { text: t("view.transition.install"), cls: "mod-cta" });
    installBtn.addEventListener("click", () => {
      installBtn.disabled = true;
      installBtn.setText(t("view.transition.installing"));
      void this.plugin.installAiEcosystem().finally(() => void this.refresh());
    });

    const running = this.plugin.server?.running ?? false;
    const header = new Setting(root).setName(t("settings.server")).setClass("ev-server-header");
    header.nameEl.prepend(createSpan({ cls: `ev-dot ${running ? "is-on" : "is-off"}` }));
    header.setDesc(
      running
        ? `${t("view.server.transition", { port: this.plugin.data.settings.port })} · ${this.plugin.serverName}`
        : `${t("view.server.off")} · ${this.plugin.serverName}`,
    );
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
    heading.addButton((b) => b.setButtonText(t("view.changePassword")).onClick(() => new ChangePasswordModal(this.app, this.plugin.store).open()));
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

  // ---------- Values ----------

  /** The Values section: configuration text that shares the {{secret:NAME}} key. The text itself is never listed. */
  private renderValues(root: HTMLElement): void {
    const section = root.createDiv({ cls: "ev-section" });
    const heading = sectionHeading(section, t("view.section.values"));
    heading.setDesc(t("view.values.desc"));
    heading.addButton((b) =>
      b
        .setButtonText(t("view.values.new"))
        .setCta()
        .onClick(() => new ValueModal(this.app, this.plugin.store).open()),
    );

    const list = section.createDiv({ cls: "ev-rows" });
    const values = this.plugin.store.listValues();
    if (values.length === 0) {
      list.createDiv({ text: t("view.values.empty"), cls: "ev-muted ev-empty" });
      return;
    }
    for (const value of values) this.renderValueItem(list, value);
  }

  private renderValueItem(list: HTMLElement, value: ValueRecord): void {
    const row = new Setting(list).setClass("ev-row");
    const name = row.nameEl.createSpan({ text: value.name, cls: "ev-item-name" });
    row.nameEl.createSpan({ text: t(`valueKind.${value.kind}`), cls: "ev-badge" });
    const lastUsed = `${t("view.col.lastUsed")}: ${value.lastUsedAt ? new Date(value.lastUsedAt).toLocaleString() : t("view.never")}`;
    setTooltip(name, value.description ? `${value.description}\n${lastUsed}` : lastUsed);
    row.descEl.createSpan({
      text: value.allowedHosts.length ? value.allowedHosts.join(", ") : t("view.values.noHosts"),
      cls: value.allowedHosts.length ? "" : "ev-warning",
    });

    row.addExtraButton((b) =>
      b.setIcon("copy").setTooltip(t("view.copyKey")).onClick(() => {
        const ref = referenceFor({ name: value.name, type: "value" });
        void navigator.clipboard.writeText(ref);
        new Notice(t("view.copied", { key: ref }));
      }),
    );
    row.addExtraButton((b) =>
      b
        .setIcon("trash-2")
        .setTooltip(t("view.delete"))
        .onClick(() => new ConfirmModal(this.app, t("view.values.deleteConfirm", { name: value.name }), () => this.plugin.store.removeValue(value.id)).open()),
    );
  }

  // ---------- Local MCP Settings ----------

  private renderMcp(root: HTMLElement): void {
    const section = root.createDiv({ cls: "ev-section" });
    sectionHeading(section, t("view.section.mcp"));

    if (!this.plugin.isEcosystemConnected) {
      const clients = this.plugin.data.clients;
      lazySection(
        section,
        t("view.clients.title"),
        this.clientsOpen ?? clients.length === 0,
        (open) => (this.clientsOpen = open),
        (body) => this.renderClients(body),
      );
    }

    const settings = this.plugin.data.settings;
    const entries = this.plugin.registry.list();
    const toolsOpen = this.toolsOpen ?? (settings.toolsEnabled && entries.some((e) => e.status !== "ready"));
    lazySection(
      section,
      t("view.tools.title"),
      toolsOpen,
      (open) => (this.toolsOpen = open),
      (body) => this.renderTools(body),
    );
  }

  /** Short instructions for each feature of the plugin, in the panel's language. */
  private renderHowTo(body: HTMLElement): void {
    // Tags are shown exactly as the plugin reads them (never translated), from the current settings.
    const settings = this.plugin.data.settings;
    const tags = { toolTag: settings.toolTag, requestTag: settings.requestTag };
    for (const [title, desc] of HOW_TO) {
      const item = body.createDiv({ cls: "ev-howto" });
      item.createDiv({ text: t(title), cls: "ev-howto-title" });
      item.createDiv({ text: t(desc, tags), cls: "ev-muted" });
    }
    subHeading(body, t("view.howto.templates"));
    body.createDiv({ text: t("view.howto.templatesDesc"), cls: "ev-muted ev-howto" });
    for (const [title, desc] of HOW_TO_TEMPLATES) {
      const item = body.createDiv({ cls: "ev-howto" });
      item.createDiv({ text: t(title), cls: "ev-howto-title" });
      item.createDiv({ text: t(desc), cls: "ev-muted" });
    }
  }

  private renderTools(body: HTMLElement): void {
    const settings = this.plugin.data.settings;
    const allEntries = this.plugin.registry.list();

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

    // The prompt for AI agents: how the tools work and the mandatory plan-first workflow.
    subHeading(body, t("view.tools.guideTitle"), { info: t("view.tools.guideBody") });
    this.renderPrompt(body);

    subHeading(body, t("view.tools.listTitle"), { count: allEntries.length });
    if (allEntries.length === 0) {
      body.createDiv({ text: t("view.tools.empty", { tag: settings.toolTag }), cls: "ev-muted ev-empty" });
      return;
    }

    // Filter toolbar
    const toolbar = body.createDiv({ cls: "ev-toolbar" });
    const search = toolbar.createEl("input", {
      type: "search",
      placeholder: t("view.search"),
      value: this.toolsQuery,
    });

    const tableContainer = body.createDiv({ cls: "ev-tools-container" });

    const updateToolList = () => {
      tableContainer.empty();
      const q = this.toolsQuery.trim().toLowerCase();
      const filtered = q
        ? allEntries.filter(
            (e) =>
              e.name.toLowerCase().includes(q) ||
              (e.mcpName && e.mcpName.toLowerCase().includes(q)) ||
              (e.description && e.description.toLowerCase().includes(q)),
          )
        : allEntries;

      const paginated = paginate(filtered, this.toolsPage, 50);
      this.renderToolTable(tableContainer, paginated.pageItems);

      renderPaginationControls(
        tableContainer,
        paginated.hasMore,
        paginated.shownCount,
        paginated.total,
        () => {
          this.toolsPage++;
          updateToolList();
        },
      );
    };

    search.addEventListener("input", () => {
      this.toolsQuery = search.value;
      this.toolsPage = 1;
      updateToolList();
    });

    updateToolList();
  }

  /** One table row per tool: optimized with event delegation and native controls */
  private renderToolTable(body: HTMLElement, entries: ToolEntry[]): void {
    const wrap = body.createDiv({ cls: "ev-log-wrap ev-tools-wrap" });
    const table = wrap.createEl("table", { cls: "ev-log ev-tools" });
    const head = table.createEl("thead").createEl("tr");
    for (const col of ["name", "package", "kind", "status", "flags", "problems", "actions"] as const) head.createEl("th", { text: t(`view.tools.col.${col}`) });
    const tbody = table.createEl("tbody");

    const entriesMap = new Map<string, ToolEntry>();

    for (const entry of entries) {
      entriesMap.set(entry.name, entry);
      const tr = tbody.createEl("tr", { attr: { "data-tool-name": entry.name } });
      tr.createEl("td", { cls: "ev-item-name", text: entry.name, attr: entry.description ? { title: entry.description } : {} });
      tr.createEl("td", { text: entry.mcpName ?? "" });
      tr.createEl("td", { text: entry.kind ?? "" });
      tr.createEl("td", { text: t(`status.${entry.status}`), cls: `ev-status-${entry.status}` });
      const flags = tr.createEl("td");
      if (entry.writes) flags.createSpan({ text: t("view.tools.writes"), cls: "ev-badge ev-warning" });
      if (!entry.expose) flags.createSpan({ text: t("view.tools.hidden"), cls: "ev-badge" });
      const problems = tr.createEl("td");
      for (const p of entry.problems) iconLine(problems, "x-circle", p, "ev-error");
      for (const w of entry.warnings) iconLine(problems, "alert-triangle", w, "ev-warning");
      const actions = tr.createEl("td", { cls: "ev-tools-actions" });
      const open = actions.createEl("button", {
        cls: "clickable-icon ev-action-open",
        attr: { "aria-label": t("view.tools.open"), "data-action": "open" },
      });
      setIcon(open, "file-text");
      if (entry.status === "ready") {
        const run = actions.createEl("button", {
          cls: "clickable-icon ev-action-run",
          attr: { "aria-label": t("view.tools.run"), "data-action": "run" },
        });
        setIcon(run, "play");
      }
    }

    // Event delegation on tbody instead of per-button listeners
    tbody.addEventListener("click", (evt: MouseEvent) => {
      const target = (evt.target as HTMLElement).closest<HTMLElement>("button[data-action]");
      if (!target) return;
      const tr = target.closest<HTMLElement>("tr[data-tool-name]");
      const toolName = tr?.getAttribute("data-tool-name");
      if (!toolName) return;
      const entry = entriesMap.get(toolName);
      if (!entry) return;

      const action = target.getAttribute("data-action");
      if (action === "open") {
        void this.app.workspace.openLinkText(entry.notePath, "", false);
      } else if (action === "run" && entry.status === "ready") {
        new ToolRunModal(this.app, entry, (args) => this.plugin.tools.run(entry.name, args, this.plugin.localClient)).open();
      }
    });
  }

  private renderPrompt(body: HTMLElement): void {
    const shown = this.guideVisible;
    const row = new Setting(body)
      .setName(t("view.tools.prompt.setup"))
      .setClass("ev-row")
      .addExtraButton((b) =>
        b
          .setIcon(shown ? "eye-off" : "eye")
          .setTooltip(shown ? t("view.tools.hideGuide") : t("view.tools.showGuide"))
          .onClick(() => {
            this.guideVisible = !shown;
            this.render();
          }),
      )
      .addButton((b) => b.setButtonText(t("view.tools.copy")).setCta().onClick(() => this.plugin.copyAgentGuide()));
    setTooltip(row.nameEl, t("view.tools.prompt.setupDesc"));
    if (shown) body.createEl("pre", { text: this.plugin.agentGuide(), cls: "ev-tool-guide" });
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
          const running = this.plugin.isEcosystemConnected || (this.plugin.server?.running ?? false);
          new ClientTokenModal(this.app, token, this.plugin.ecosystemPort, running, this.plugin.serverName).open();
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
      b
        .setButtonText(t("view.mcpGroups.openCatalog"))
        .setIcon("package-plus")
        .onClick(() => {
          // Packages are installed by AI Ecosystem: its catalog command opens the catalog.
          const commands = (this.app as unknown as { commands: { executeCommandById(id: string): boolean } }).commands;
          if (!commands.executeCommandById("ai-ecosystem:open-catalog")) new Notice(t("notice.ecosystemCatalogMissing"));
        }),
    );
    heading.addButton((b) =>
      b
        .setButtonText(t("view.mcpGroups.add"))
        .setCta()
        .onClick(() => this.openMcpGroupModal(null)),
    );

    const apps = this.plugin.data.mcpApps;
    const stats = this.plugin.mcpGroupStats();

    lazySection(
      section,
      t("view.section.mcpGroups"),
      this.mcpGroupsOpen ?? (apps.length + stats.length > 0),
      (open) => (this.mcpGroupsOpen = open),
      (body) => {
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
          body.createDiv({ text: t("view.mcpGroups.empty"), cls: "ev-muted ev-empty" });
          return;
        }
        for (const app of apps) this.renderMcpAppCard(body, app, byApp.get(app.id) ?? []);
        for (const group of standalone) this.renderMcpGroupCard(body, group);
      },
    );
  }

  private openMcpGroupModal(existing: McpGroupStats | null): void {
    // Only the plain config fields go to the modal: the stats are computed, never edited or saved.
    const target: McpGroupConfig = existing
      ? {
          id: existing.id,
          name: existing.name,
          logo: this.plugin.resolveLogo(existing.logo),
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
    const target = existing ? { ...existing, logo: this.plugin.resolveLogo(existing.logo) } : newMcpApp();
    new McpAppModal(this.app, this.plugin.data.mcpApps, target, (updated) =>
      existing ? this.plugin.updateMcpApp(updated) : this.plugin.addMcpApp(updated),
    ).open();
  }

  private renderMcpAppCard(parent: HTMLElement, app: McpAppConfig, items: McpGroupStats[]): void {
    const card = parent.createDiv({ cls: "ev-mcp-card" });
    const header = card.createDiv({ cls: "ev-mcp-card-header" });

    const title = header.createDiv({ cls: "ev-mcp-card-title" });
    const icon = title.createDiv({ cls: "ev-mcp-item-icon" });
    if (app.logo) icon.createEl("img", { attr: { src: this.plugin.resolveLogo(app.logo), alt: "" } });
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
    if (item.logo) icon.createEl("img", { attr: { src: this.plugin.resolveLogo(item.logo), alt: "" } });
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
    if (group.logo) icon.createEl("img", { attr: { src: this.plugin.resolveLogo(group.logo), alt: "" } });
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
    const entries = this.plugin.audit.listRecent(Math.max(50, this.logPage * 50));
    const heading = sectionHeading(section, t("view.section.logs"));
    if (this.plugin.isEcosystemConnected) {
      heading.addButton((b) => b.setButtonText(t("view.log.live")).onClick(() => void this.plugin.openEcosystemInspector()));
    }
    heading.addButton((b) =>
      b
        .setButtonText(t("view.log.clear"))
        .setDisabled(entries.length === 0)
        .onClick(() => {
          this.plugin.audit.clear();
          this.logPage = 1;
        }),
    );
    if (entries.length === 0) {
      section.createDiv({ text: t("view.log.empty"), cls: "ev-muted ev-empty" });
      return;
    }
    lazySection(
      section,
      t("view.log.show", { n: entries.length }),
      this.logOpen,
      (open) => (this.logOpen = open),
      (body) => {
        const tableContainer = body.createDiv();
        const renderAuditPage = () => {
          tableContainer.empty();
          const currentEntries = this.plugin.audit.listRecent(this.logPage * 50);
          const paginated = paginate(currentEntries, this.logPage, 50);
          const wrap = tableContainer.createDiv({ cls: "ev-log-wrap" });
          const table = wrap.createEl("table", { cls: "ev-log" });
          const head = table.createEl("thead").createEl("tr");
          for (const col of ["time", "client", "action", "variables", "result"] as const) head.createEl("th", { text: t(`view.log.col.${col}`) });
          const tbody = table.createEl("tbody");
          for (const e of paginated.pageItems) {
            const tr = tbody.createEl("tr", { cls: `ev-log-${e.outcome}` });
            tr.createEl("td", { text: new Date(e.time).toLocaleString() });
            tr.createEl("td", { text: e.client });
            tr.createEl("td", { text: auditActionLabel(e).trim() });
            tr.createEl("td", { text: e.secrets.join(", ") });
            tr.createEl("td", { text: e.status ? `${e.outcome} ${e.status}` : e.outcome, attr: { title: e.detail ?? "" } });
          }

          renderPaginationControls(
            tableContainer,
            paginated.hasMore,
            paginated.shownCount,
            paginated.total,
            () => {
              this.logPage++;
              renderAuditPage();
            },
          );
        };
        renderAuditPage();
      },
    );
  }
}

function auditActionLabel(e: AuditEntry): string {
  switch (e.action) {
    case "list":
      return "list_secrets";
    case "tool":
      return `tool ${e.tool ?? ""}`;
    case "adopt":
      return `adopt ${e.target ?? ""}`;
    case "create":
      return `create ${e.target ?? ""}`;
    case "template":
      return "template";
    case "spawn":
      return "spawn";
    default:
      return `${e.method ?? ""} ${e.target ?? ""}`;
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
/** The features listed in How to use, in the order of the panel. */
const HOW_TO = [
  ["view.howto.vault", "view.howto.vaultDesc"],
  ["view.howto.variables", "view.howto.variablesDesc"],
  ["view.howto.values", "view.howto.valuesDesc"],
  ["view.howto.references", "view.howto.referencesDesc"],
  ["view.howto.hosts", "view.howto.hostsDesc"],
  ["view.howto.clients", "view.howto.clientsDesc"],
  ["view.howto.tools", "view.howto.toolsDesc"],
  ["view.howto.prompt", "view.howto.promptDesc"],
  ["view.howto.groups", "view.howto.groupsDesc"],
  ["view.howto.download", "view.howto.downloadDesc"],
  ["view.howto.logs", "view.howto.logsDesc"],
  ["view.howto.settings", "view.howto.settingsDesc"],
] as const;

/** The bundled instance templates, in How to use → How to fill in each template. */
const HOW_TO_TEMPLATES = [
  ["view.howto.tplAtlassian", "view.howto.tplAtlassianDesc"],
  ["view.howto.tplBitbucket", "view.howto.tplBitbucketDesc"],
  ["view.howto.tplTrello", "view.howto.tplTrelloDesc"],
] as const;
