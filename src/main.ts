import { Editor, Notice, Plugin, setIcon } from "obsidian";
import { AuditLog } from "./audit/auditLog";
import { Broker } from "./engine/broker";
import { detectToken } from "./engine/tokenPatterns";
import { nodeTransport } from "./engine/transport";
import { placeholderHighlighter, renderPlaceholders } from "./editor/render";
import { attachPropertySuggest, SecretNameSuggest, setPropertySuggestActive } from "./editor/suggest";
import { clearProperties, decorateProperties } from "./editor/properties";
import { t } from "./i18n";
import { IntegrationId, integrationById } from "./integrations/integrations";
import { accessOf, ClientAccess, ClientRecord, contextOf, createClient, findClient } from "./server/clients";
import { LocalServer } from "./server/localServer";
import { PluginData, withDefaults } from "./settings";
import { SecretStore, VaultIO } from "./store/secretStore";
import { ApprovalModal, referenceFor, SecretModal, SecretPickerModal } from "./ui/modals";
import { EnvironmentVariablesSettingTab } from "./ui/settingsTab";
import { EnvironmentVariablesView, ICON_LOCKED, ICON_UNLOCKED, VIEW_TYPE } from "./ui/view";

export default class EnvironmentVariablesPlugin extends Plugin {
  data!: PluginData;
  store!: SecretStore;
  audit!: AuditLog;
  broker!: Broker;
  server: LocalServer | null = null;

  private ribbon: HTMLElement | null = null;
  private lastActivity = Date.now();
  private serverListeners = new Set<() => void>();
  private saveTimer: number | undefined;
  private propertyTimer: number | undefined;
  private propertyDocs = new Set<Document>();

  get vaultFilePath(): string {
    return `${this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`}/vault.enc`;
  }

  async onload(): Promise<void> {
    this.data = withDefaults((await this.loadData()) as Partial<PluginData> | null);

    const adapter = this.app.vault.adapter;
    const path = this.vaultFilePath;
    const io: VaultIO = {
      read: async () => ((await adapter.exists(path)) ? adapter.read(path) : null),
      write: (content) => adapter.write(path, content),
    };
    this.store = new SecretStore(io);
    this.audit = new AuditLog(this.data.audit, (entries) => {
      this.data.audit = entries;
      this.scheduleSave();
    });
    this.broker = new Broker(
      this.store,
      nodeTransport,
      (req) => this.askApproval(req),
      this.audit,
      () => ({
        timeoutMs: this.data.settings.timeoutSeconds * 1000,
        maxResponseBytes: this.data.settings.maxResponseMB * 1024 * 1024,
        maxRedirects: 5,
      }),
      () => this.touch(),
    );

    this.registerView(VIEW_TYPE, (leaf) => new EnvironmentVariablesView(leaf, this));

    // Left ribbon icon: key when unlocked, lock when locked.
    this.ribbon = this.addRibbonIcon(ICON_LOCKED, t("ribbon.locked"), () => void this.activateView());
    this.ribbon.addClass("ev-ribbon");
    this.register(this.store.onChange(() => this.updateRibbon()));
    this.updateRibbon();

    this.addCommand({ id: "open-panel", name: t("cmd.open"), callback: () => void this.activateView() });
    this.addCommand({ id: "lock", name: t("cmd.lock"), callback: () => this.lock() });
    this.addCommand({
      id: "insert-reference",
      name: t("cmd.insert"),
      editorCallback: (editor: Editor) => {
        if (!this.requireUnlocked()) return;
        new SecretPickerModal(this.app, this.store, (secret) => editor.replaceSelection(referenceFor(secret))).open();
      },
    });
    this.addCommand({
      id: "convert-selection",
      name: t("cmd.convert"),
      editorCallback: (editor: Editor) => {
        if (!this.requireUnlocked()) return;
        const selected = editor.getSelection();
        if (!selected) return;
        const from = editor.getCursor("from");
        const to = editor.getCursor("to");
        new SecretModal(this.app, this.store, null, (secret) => editor.replaceRange(referenceFor(secret), from, to), selected.trim()).open();
      },
    });

    this.addSettingTab(new EnvironmentVariablesSettingTab(this.app, this));
    this.registerEditorSuggest(new SecretNameSuggest(this));
    // Properties panel: attach the same autocomplete to a value field when it gets focus.
    setPropertySuggestActive(true);
    this.register(() => setPropertySuggestActive(false));
    const watchDocument = (doc: Document) => {
      this.propertyDocs.add(doc);
      this.registerDomEvent(doc, "focusin", (evt) => attachPropertySuggest(this, evt.target));
      // After editing, show the chip again once Obsidian has saved the value.
      this.registerDomEvent(doc, "focusout", () => this.schedulePropertyChips());
    };
    watchDocument(activeDocument);
    this.registerEvent(this.app.workspace.on("window-open", (win) => watchDocument(win.doc)));
    this.registerEvent(this.app.workspace.on("window-close", (win) => this.propertyDocs.delete(win.doc)));
    this.registerEvent(this.app.workspace.on("layout-change", () => this.schedulePropertyChips()));
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.schedulePropertyChips()));
    this.registerEvent(this.app.metadataCache.on("changed", () => this.schedulePropertyChips()));
    this.register(this.store.onChange(() => this.schedulePropertyChips()));
    this.register(() => {
      if (this.propertyTimer !== undefined) window.clearTimeout(this.propertyTimer);
      for (const doc of this.propertyDocs) clearProperties(doc);
    });
    this.registerMarkdownPostProcessor(renderPlaceholders);
    this.registerEditorExtension(placeholderHighlighter);
    this.registerEvent(this.app.workspace.on("editor-paste", (evt, editor) => this.onPaste(evt, editor)));

    this.registerInterval(window.setInterval(() => this.checkAutoLock(), 30_000));

    this.app.workspace.onLayoutReady(() => {
      if (this.data.settings.serverEnabled) void this.startServer();
    });
  }

  onunload(): void {
    void this.server?.stop();
    this.server = null;
    this.store.lock();
    if (this.saveTimer !== undefined) window.clearTimeout(this.saveTimer);
    void this.saveData(this.data);
  }

  // ---------- view & ribbon ----------

  async activateView(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE);
    if (existing.length > 0) {
      await this.app.workspace.revealLeaf(existing[0]);
      return;
    }
    const leaf = this.app.workspace.getLeaf("tab");
    await leaf.setViewState({ type: VIEW_TYPE, active: true });
    await this.app.workspace.revealLeaf(leaf);
  }

  private updateRibbon(): void {
    if (!this.ribbon) return;
    const unlocked = this.store.isUnlocked;
    setIconSafe(this.ribbon, unlocked ? ICON_UNLOCKED : ICON_LOCKED, unlocked ? "key" : "lock");
    this.ribbon.setAttribute("aria-label", unlocked ? t("ribbon.unlocked") : t("ribbon.locked"));
    this.ribbon.toggleClass("is-unlocked", unlocked);
  }

  // ---------- properties ----------

  private schedulePropertyChips(): void {
    if (this.propertyTimer !== undefined) window.clearTimeout(this.propertyTimer);
    this.propertyTimer = window.setTimeout(() => {
      this.propertyTimer = undefined;
      const known = () => (this.store.isUnlocked ? new Set(this.store.names()) : null);
      for (const doc of this.propertyDocs) decorateProperties(doc, known);
    }, 150);
  }

  // ---------- pasted tokens ----------

  /** A token pasted into a note: let the paste happen, then offer to move it into the vault. */
  private onPaste(evt: ClipboardEvent, editor: Editor): void {
    if (!this.data.settings.warnOnTokenPaste || evt.defaultPrevented) return;
    const raw = evt.clipboardData?.getData("text/plain") ?? "";
    const kind = detectToken(raw);
    if (!kind) return;
    const token = raw.trim();
    const start = editor.posToOffset(editor.getCursor("from")) + raw.indexOf(token);

    const message = createFragment();
    message.createDiv({ text: t("notice.tokenPasted", { kind }) });
    const button = message.createEl("button", { text: t("notice.tokenPastedConvert"), cls: "mod-cta ev-notice-button" });
    const notice = new Notice(message, 15_000);
    button.addEventListener("click", () => {
      notice.hide();
      this.convertPastedToken(editor, token, start);
    });
  }

  private convertPastedToken(editor: Editor, token: string, start: number): void {
    if (!this.requireUnlocked()) return;
    // The note may have changed since the paste: only replace the exact token.
    let offset = start;
    if (editor.getRange(editor.offsetToPos(offset), editor.offsetToPos(offset + token.length)) !== token) {
      offset = editor.getValue().indexOf(token);
      if (offset < 0) {
        new Notice(t("notice.tokenNotFound"), 10_000);
        return;
      }
    }
    const from = editor.offsetToPos(offset);
    const to = editor.offsetToPos(offset + token.length);
    new SecretModal(this.app, this.store, null, (secret) => editor.replaceRange(referenceFor(secret), from, to), token).open();
  }

  // ---------- lock state ----------

  touch(): void {
    this.lastActivity = Date.now();
  }

  lock(): void {
    this.store.lock();
    new Notice(t("notice.locked"));
  }

  private checkAutoLock(): void {
    const minutes = this.data.settings.autoLockMinutes;
    if (!minutes || !this.store.isUnlocked) return;
    if (Date.now() - this.lastActivity > minutes * 60_000) {
      this.store.lock();
      new Notice(t("notice.autoLocked"));
    }
  }

  private requireUnlocked(): boolean {
    if (this.store.isUnlocked) return true;
    new Notice(t("notice.lockedFirst"));
    void this.activateView();
    return false;
  }

  private askApproval(req: Parameters<ConstructorParameters<typeof Broker>[2]>[0]): Promise<boolean> {
    new Notice(t("notice.approvalPending"));
    return new Promise((resolve) => new ApprovalModal(this.app, req, this.data.settings.approvalTimeoutSeconds, resolve).open());
  }

  // ---------- server ----------

  onServerChange(listener: () => void): () => void {
    this.serverListeners.add(listener);
    return () => this.serverListeners.delete(listener);
  }

  private emitServerChange(): void {
    for (const l of this.serverListeners) l();
  }

  async setServerEnabled(enabled: boolean): Promise<void> {
    this.data.settings.serverEnabled = enabled;
    await this.saveAll();
    if (enabled) await this.startServer();
    else await this.stopServer();
  }

  async restartServer(): Promise<void> {
    await this.stopServer();
    if (this.data.settings.serverEnabled) await this.startServer();
    if (this.server?.running) await this.reconnectIntegrations();
  }

  private async startServer(): Promise<void> {
    if (this.server?.running) return;
    const server = new LocalServer({
      port: this.data.settings.port,
      broker: this.broker,
      version: this.manifest.version,
      authenticate: async (token) => {
        const client = await findClient(this.data.clients, token);
        if (!client) return null;
        client.lastUsedAt = new Date().toISOString();
        this.scheduleSave();
        return contextOf(client);
      },
    });
    try {
      await server.start();
      this.server = server;
    } catch (err) {
      this.server = null;
      new Notice(t("notice.serverError", { error: err instanceof Error ? err.message : String(err) }));
    }
    this.emitServerChange();
  }

  private async stopServer(): Promise<void> {
    await this.server?.stop();
    this.server = null;
    this.emitServerChange();
  }

  // ---------- clients ----------

  get serverUrl(): string {
    return `http://127.0.0.1:${this.data.settings.port}/mcp`;
  }

  async addClient(name: string, access: ClientAccess): Promise<string> {
    const { record, token } = await createClient(name, access);
    this.data.clients.push(record);
    await this.saveAll();
    this.emitServerChange();
    return token;
  }

  async revokeClient(id: string): Promise<void> {
    const client = this.data.clients.find((c) => c.id === id);
    if (client?.integration) {
      await integrationById(client.integration)?.disconnect().catch(() => undefined);
    }
    this.data.clients = this.data.clients.filter((c) => c.id !== id);
    await this.saveAll();
    this.emitServerChange();
  }

  async setClientAccess(clientId: string, access: ClientAccess): Promise<void> {
    const client = this.data.clients.find((c) => c.id === clientId);
    if (!client) return;
    client.access = access;
    await this.saveAll();
    this.emitServerChange();
  }

  connectedClient(id: IntegrationId): ClientRecord | undefined {
    return this.data.clients.find((c) => c.integration === id);
  }

  /**
   * One click: turns the server on, creates a token and registers it in the AI client.
   * The token never appears on screen. Returns false (after a notice) on failure.
   */
  async connectIntegration(id: IntegrationId, access?: ClientAccess, quiet = false): Promise<boolean> {
    const integration = integrationById(id);
    if (!integration) return false;
    if (!this.data.settings.serverEnabled || !this.server?.running) {
      await this.setServerEnabled(true);
      if (!this.server?.running) return false;
    }
    // Reconnecting keeps the access list the user chose before.
    const previous = this.connectedClient(id);
    const grant = access ?? (previous ? accessOf(previous) : { mode: "some" as const, secretIds: [] });
    const { record, token } = await createClient(integration.label, grant, id);
    try {
      await integration.connect(this.serverUrl, token);
    } catch (err) {
      new Notice(t("notice.connectFailed", { client: integration.label, error: err instanceof Error ? err.message : String(err) }), 10_000);
      return false;
    }
    // Replace the previous token of this integration only after the new one is in place.
    this.data.clients = this.data.clients.filter((c) => c.integration !== id);
    this.data.clients.push(record);
    await this.saveAll();
    this.emitServerChange();
    if (!quiet) new Notice(t("notice.connected", { client: integration.label }), 8_000);
    return true;
  }

  /** After a port change, re-register every connected AI client with the new URL. */
  private async reconnectIntegrations(): Promise<void> {
    const ids = this.data.clients.map((c) => c.integration).filter((i): i is IntegrationId => !!i);
    for (const id of ids) await this.connectIntegration(id, undefined, true);
  }

  // ---------- persistence ----------

  async saveAll(): Promise<void> {
    await this.saveData(this.data);
  }

  private scheduleSave(): void {
    if (this.saveTimer !== undefined) window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = undefined;
      void this.saveData(this.data);
    }, 1000);
  }
}

/** Uses the preferred icon, or a fallback on older Obsidian versions that lack it. */
function setIconSafe(el: HTMLElement, icon: string, fallback: string): void {
  setIcon(el, icon);
  if (!el.querySelector("svg")) setIcon(el, fallback);
}
