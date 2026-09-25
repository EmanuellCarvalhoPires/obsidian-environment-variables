import { ItemView, Notice, setIcon, ToggleComponent, WorkspaceLeaf } from "obsidian";
import { WrongPasswordError } from "../crypto/vaultFile";
import { t } from "../i18n";
import { Integration, IntegrationId, INTEGRATIONS } from "../integrations/integrations";
import type EnvironmentVariablesPlugin from "../main";
import { MIN_PASSWORD_LENGTH, passwordStrength } from "../store/secretStore";
import { SecretRecord } from "../store/types";
import { wildcardRisk } from "../engine/hosts";
import { accessOf, ClientAccess, ClientRecord } from "../server/clients";
import { AccessModal, ClientTokenModal, ConfirmModal, hostsLabel, PromptModal, referenceFor, SecretModal } from "./modals";
import { ToolEntry } from "../tools/types";
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
  private guideVisible = false;
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

  // ---------- unlocked ----------

  private renderUnlocked(root: HTMLElement): void {
    const header = root.createDiv({ cls: "ev-header" });
    const status = header.createDiv({ cls: "ev-status" });
    setIcon(status.createSpan({ cls: "ev-status-icon" }), ICON_UNLOCKED);
    status.createSpan({ text: t("view.status.unlocked") });
    const lockBtn = header.createEl("button", { text: t("view.lockNow") });
    lockBtn.addEventListener("click", () => this.plugin.lock());

    const server = root.createDiv({ cls: "ev-server" });
    const running = this.plugin.server?.running ?? false;
    server.createSpan({ cls: `ev-dot ${running ? "is-on" : "is-off"}` });
    server.createSpan({ text: running ? t("view.server.on", { port: this.plugin.data.settings.port }) : t("view.server.off") });
    server.createSpan({ text: t("view.server.name", { name: this.plugin.serverName }), cls: "ev-muted ev-server-name" });
    const toggle = server.createEl("button", { text: running ? t("view.server.stop") : t("view.server.start") });
    toggle.addEventListener("click", () => void this.plugin.setServerEnabled(!running));

    const toolbar = root.createDiv({ cls: "ev-toolbar" });
    const search = toolbar.createEl("input", { type: "search", placeholder: t("view.search"), value: this.query });
    search.addEventListener("input", () => {
      this.query = search.value;
      this.renderList(list);
    });
    const add = toolbar.createEl("button", { text: t("view.new"), cls: "mod-cta" });
    add.addEventListener("click", () => new SecretModal(this.app, this.plugin.store, null).open());

    const list = root.createDiv({ cls: "ev-list" });
    this.renderList(list);

    this.renderTools(root);
    this.renderClients(root);
    this.renderLog(root);
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
    const item = list.createDiv({ cls: "ev-item" });
    const top = item.createDiv({ cls: "ev-item-top" });
    top.createSpan({ text: secret.name, cls: "ev-item-name" });
    top.createSpan({ text: t(`type.${secret.type}`), cls: "ev-badge" });
    top.createSpan({ text: "••••••••", cls: "ev-mask" });
    if (secret.description) item.createDiv({ text: secret.description, cls: "ev-muted" });
    const meta = item.createDiv({ cls: "ev-item-meta" });
    meta.createSpan({
      text: `${t("view.col.hosts")}: ${hostsLabel(secret)}`,
      cls: secret.allowAnyHost === true || secret.allowedHosts.length === 0 ? "ev-warning" : "",
    });
    meta.createSpan({ text: `${t("view.col.lastUsed")}: ${secret.lastUsedAt ? new Date(secret.lastUsedAt).toLocaleString() : t("view.never")}` });
    const shared = secret.allowAnyHost === true ? [] : secret.allowedHosts.filter((h) => wildcardRisk(h) === "multitenant");
    if (shared.length) item.createDiv({ text: `⚠ ${t("view.multitenantWarning", { hosts: shared.join(", ") })}`, cls: "ev-warning ev-item-warning" });

    const actions = item.createDiv({ cls: "ev-actions" });
    iconButton(actions, "copy", t("view.copyKey"), () => {
      const ref = referenceFor(secret);
      void navigator.clipboard.writeText(ref);
      new Notice(t("view.copied", { key: ref }));
    });
    iconButton(actions, "pencil", t("view.edit"), () => new SecretModal(this.app, this.plugin.store, secret).open());
    iconButton(actions, "trash-2", t("view.delete"), () =>
      new ConfirmModal(this.app, t("view.deleteConfirm", { name: secret.name }), () => this.plugin.store.remove(secret.id)).open(),
    );
  }

  // ---------- vault tools ----------

  private renderTools(root: HTMLElement): void {
    const settings = this.plugin.data.settings;
    const entries = this.plugin.registry.list();
    const details = root.createEl("details", { cls: "ev-section" });
    details.open = this.toolsOpen ?? (settings.toolsEnabled && entries.some((e) => e.status !== "ready"));
    details.addEventListener("toggle", () => (this.toolsOpen = details.open));
    details.createEl("summary", { text: t("view.tools.title") });

    const switches = details.createDiv({ cls: "ev-tool-switches" });
    toolSwitch(switches, t("settings.toolsEnabled"), t("settings.toolsEnabledDesc"), settings.toolsEnabled, false, (v) => this.plugin.setToolsEnabled(v));
    toolSwitch(switches, t("settings.scriptsEnabled"), t("settings.scriptsEnabledDesc"), settings.scriptsEnabled, !settings.toolsEnabled, (v) =>
      this.plugin.setScriptsEnabled(v),
    );

    if (!settings.toolsEnabled) {
      details.createEl("p", { text: t("view.tools.off"), cls: "ev-muted" });
      return;
    }

    details.createEl("p", {
      text: t("view.tools.summary", { n: entries.length, scripts: settings.scriptsEnabled ? t("view.tools.on") : t("view.tools.off2") }),
      cls: "ev-muted",
    });

    // The prompt for AI agents: how the tools work and the mandatory plan-first workflow.
    details.createEl("h6", { text: t("view.tools.guideTitle"), cls: "ev-subtitle" });
    details.createEl("p", { text: t("view.tools.guideBody"), cls: "ev-muted" });
    const guideActions = details.createDiv({ cls: "ev-tool-actions" });
    const copy = guideActions.createEl("button", { text: t("view.tools.copyGuide"), cls: "mod-cta" });
    copy.addEventListener("click", () => this.plugin.copyAgentGuide());
    const toggle = guideActions.createEl("button", { text: this.guideVisible ? t("view.tools.hideGuide") : t("view.tools.showGuide") });
    toggle.addEventListener("click", () => {
      this.guideVisible = !this.guideVisible;
      this.render();
    });
    if (this.guideVisible) details.createEl("pre", { text: this.plugin.agentGuide(), cls: "ev-tool-guide" });

    details.createEl("h6", { text: t("view.tools.listTitle"), cls: "ev-subtitle" });
    if (entries.length === 0) {
      details.createDiv({ text: t("view.tools.empty", { tag: settings.toolTag }), cls: "ev-muted" });
      return;
    }
    const list = details.createDiv({ cls: "ev-list" });
    for (const entry of entries) this.renderTool(list, entry);
  }

  private renderTool(list: HTMLElement, entry: ToolEntry): void {
    const item = list.createDiv({ cls: `ev-item ev-tool ev-tool-${entry.status}` });
    const top = item.createDiv({ cls: "ev-item-top" });
    top.createSpan({ text: entry.name, cls: "ev-item-name", attr: entry.description ? { title: entry.description } : {} });
    if (entry.kind) top.createSpan({ text: entry.kind, cls: "ev-badge" });
    top.createSpan({ text: t(`status.${entry.status}`), cls: `ev-badge ev-status-badge ev-status-${entry.status}` });
    if (entry.writes) top.createSpan({ text: t("view.tools.writes"), cls: "ev-badge ev-warning" });
    if (!entry.expose) top.createSpan({ text: t("view.tools.hidden"), cls: "ev-badge" });
    const actions = top.createDiv({ cls: "ev-actions" });
    iconButton(actions, "file-text", t("view.tools.open"), () => void this.app.workspace.openLinkText(entry.notePath, "", false));
    if (entry.status === "ready") {
      iconButton(actions, "play", t("view.tools.run"), () =>
        new ToolRunModal(this.app, entry, (args) => this.plugin.tools.run(entry.name, args, this.plugin.localClient)).open(),
      );
    }
    for (const p of entry.problems) item.createDiv({ text: `✗ ${p}`, cls: "ev-error ev-item-warning" });
    for (const w of entry.warnings) item.createDiv({ text: `⚠ ${w}`, cls: "ev-warning ev-item-warning" });
  }

  private renderClients(root: HTMLElement): void {
    const details = root.createEl("details", { cls: "ev-section" });
    const clients = this.plugin.data.clients;
    details.open = this.clientsOpen ?? clients.length === 0;
    details.addEventListener("toggle", () => (this.clientsOpen = details.open));
    details.createEl("summary", { text: t("view.clients.title") });
    details.createEl("p", { text: t("view.connect.body"), cls: "ev-muted" });

    const cards = details.createDiv({ cls: "ev-integrations" });
    for (const integration of INTEGRATIONS) this.renderIntegration(cards, integration);

    const manual = clients.filter((c) => !c.integration);
    details.createEl("h6", { text: t("view.connect.manualTitle"), cls: "ev-subtitle" });
    details.createEl("p", { text: t("view.clients.body"), cls: "ev-muted" });
    if (manual.length === 0) details.createDiv({ text: t("view.clients.none"), cls: "ev-muted" });
    for (const c of manual) {
      const row = details.createDiv({ cls: "ev-client" });
      row.createSpan({ text: c.name, cls: "ev-item-name" });
      row.createSpan({ text: `${c.hint}…`, cls: "ev-muted" });
      row.createSpan({ text: c.lastUsedAt ? new Date(c.lastUsedAt).toLocaleString() : t("view.never"), cls: "ev-muted" });
      this.accessBadge(row, c);
      iconButton(row, "shield", t("view.access.edit"), () => this.editAccess(c));
      iconButton(row, "x", t("view.clients.revoke"), () =>
        new ConfirmModal(this.app, t("view.clients.revokeConfirm", { name: c.name }), () => this.plugin.revokeClient(c.id)).open(),
      );
    }
    const add = details.createEl("button", { text: t("view.connect.manual") });
    add.addEventListener("click", () =>
      new PromptModal(this.app, t("view.clients.namePrompt"), (name) =>
        new AccessModal(this.app, this.plugin.store, name || "AI client", null, async (access) => {
          const token = await this.plugin.addClient(name, access);
          new ClientTokenModal(this.app, token, this.plugin.data.settings.port, this.plugin.server?.running ?? false, this.plugin.serverName).open();
        }).open(),
      ).open(),
    );
  }

  private renderIntegration(parent: HTMLElement, integration: Integration): void {
    const card = parent.createDiv({ cls: "ev-integration" });
    card.createSpan({ text: integration.label, cls: "ev-item-name" });
    const status = card.createSpan({ cls: "ev-muted" });
    const actions = card.createDiv({ cls: "ev-integration-actions" });
    const connected = this.plugin.connectedClient(integration.id);

    const button = (label: string, cta: boolean, onClick: (btn: HTMLButtonElement) => Promise<void>) => {
      const btn = actions.createEl("button", { text: label, cls: cta ? "mod-cta" : "" });
      const run = async () => {
        if (this.connecting) return;
        this.connecting = integration.id;
        btn.disabled = true;
        btn.setText(t("view.connect.connecting"));
        try {
          await onClick(btn);
        } finally {
          this.connecting = null;
          await this.refresh();
        }
      };
      btn.addEventListener("click", () => void run());
    };

    if (connected) {
      status.setText(
        `✓ ${t("view.connect.connected")} · ${t("view.col.lastUsed")}: ${connected.lastUsedAt ? new Date(connected.lastUsedAt).toLocaleString() : t("view.never")}`,
      );
      status.addClass("ev-ok");
      this.accessBadge(card, connected);
      const edit = actions.createEl("button", { text: t("view.access.edit") });
      edit.addEventListener("click", () => this.editAccess(connected));
      button(t("view.connect.reconnect"), false, async () => void (await this.plugin.connectIntegration(integration.id)));
      const off = actions.createEl("button", { text: t("view.connect.disconnect") });
      off.addEventListener("click", () =>
        new ConfirmModal(this.app, t("view.connect.disconnectConfirm", { client: integration.label }), () => this.plugin.revokeClient(connected.id)).open(),
      );
      return;
    }

    const known = this.detected.get(integration.id);
    if (known === undefined) {
      status.setText(t("view.connect.checking"));
      void integration.detect().then((found) => {
        this.detected.set(integration.id, found);
        void this.refresh();
      });
      return;
    }
    if (!known) {
      status.setText(t("view.connect.notFound"));
      card.addClass("is-missing");
      return;
    }
    const connect = actions.createEl("button", { text: t("view.connect.connect"), cls: "mod-cta" });
    connect.addEventListener("click", () =>
      new AccessModal(this.app, this.plugin.store, integration.label, null, async (access) => {
        connect.disabled = true;
        connect.setText(t("view.connect.connecting"));
        await this.plugin.connectIntegration(integration.id, access);
        await this.refresh();
      }).open(),
    );
  }

  private accessBadge(parent: HTMLElement, client: ClientRecord): void {
    const access = accessOf(client);
    const text = access.mode === "all" ? t("view.access.all") : t("view.access.some", { n: access.secretIds.length });
    parent.createSpan({ text, cls: `ev-badge ${access.mode === "all" ? "ev-badge-wide" : ""}` });
  }

  private editAccess(client: ClientRecord): void {
    new AccessModal(this.app, this.plugin.store, client.name, accessOf(client), (access: ClientAccess) =>
      this.plugin.setClientAccess(client.id, access),
    ).open();
  }

  private renderLog(root: HTMLElement): void {
    const details = root.createEl("details", { cls: "ev-section" });
    details.createEl("summary", { text: t("view.log.title") });
    const entries = this.plugin.audit.list().slice(0, 100);
    if (entries.length === 0) {
      details.createDiv({ text: t("view.log.empty"), cls: "ev-muted" });
      return;
    }
    const table = details.createEl("table", { cls: "ev-log" });
    for (const e of entries) {
      const tr = table.createEl("tr", { cls: `ev-log-${e.outcome}` });
      tr.createEl("td", { text: new Date(e.time).toLocaleString() });
      tr.createEl("td", { text: e.client });
      tr.createEl("td", { text: e.action === "list" ? "list_secrets" : e.action === "tool" ? `tool ${e.tool ?? ""}` : `${e.method ?? ""} ${e.target ?? ""}` });
      tr.createEl("td", { text: e.secrets.join(", ") });
      tr.createEl("td", { text: e.status ? `${e.outcome} ${e.status}` : e.outcome, attr: { title: e.detail ?? "" } });
    }
    const clear = details.createEl("button", { text: t("view.log.clear") });
    clear.addEventListener("click", () => this.plugin.audit.clear());
  }
}

function passwordInput(parent: HTMLElement, placeholder: string): HTMLInputElement {
  const input = parent.createEl("input", { type: "password", placeholder, cls: "ev-password" });
  input.autocomplete = "off";
  return input;
}

/** A checkbox with a label; the description shows on hover. */
function toolSwitch(parent: HTMLElement, label: string, desc: string, checked: boolean, disabled: boolean, onChange: (value: boolean) => Promise<void>): void {
  const row = parent.createDiv({ cls: "ev-tool-switch", attr: { title: desc } });
  const toggle = new ToggleComponent(row).setValue(checked).setDisabled(disabled);
  row.createSpan({ text: label });
  if (disabled) row.addClass("is-disabled");
  let busy = false;
  toggle.onChange((value) => {
    if (busy) return;
    busy = true;
    toggle.setDisabled(true);
    void onChange(value);
  });
  // Clicking the label switches too, like a label next to a checkbox.
  row.addEventListener("click", (evt) => {
    if (disabled || busy || toggle.toggleEl.contains(evt.target as Node)) return;
    toggle.toggleEl.click();
  });
}

function iconButton(parent: HTMLElement, icon: string, label: string, onClick: () => void): void {
  const btn = parent.createEl("button", { cls: "clickable-icon ev-icon-btn", attr: { "aria-label": label } });
  setIcon(btn, icon);
  btn.addEventListener("click", onClick);
}
