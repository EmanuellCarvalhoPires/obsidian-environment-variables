import { Editor, FileSystemAdapter, getLanguage, Notice, Plugin, setIcon } from "obsidian";
import { AuditLog } from "./audit/auditLog";
import { Broker } from "./engine/broker";
import { detectToken } from "./engine/tokenPatterns";
import { nodeTransport } from "./engine/transport";
import { placeholderExtension, renderPlaceholders } from "./editor/render";
import { attachPropertySuggest, SecretNameSuggest, setPropertySuggestActive } from "./editor/suggest";
import { clearProperties, decorateProperties } from "./editor/properties";
import { t } from "./i18n";
import { Integration, IntegrationId, integrationById, MCP_SERVER_NAME } from "./integrations/integrations";
import { accessOf, ClientAccess, ClientContext, ClientRecord, contextOf, createClient, findClient } from "./server/clients";
import { LocalServer, PortInUseError, PortOwner, probePort } from "./server/localServer";
import { SERVER_NAME_PATTERN, serverNameFor, vaultIdOf } from "./server/vaultIdentity";
import { NameEntry, PluginData, withDefaults } from "./settings";
import { SecretStore, VaultIO } from "./store/secretStore";
import { buildGuide } from "./tools/guide";
import { ObsidianNoteSource } from "./tools/obsidianSource";
import { ToolRegistry } from "./tools/registry";
import { ScriptRunner } from "./tools/scriptRunner";
import { ToolsService } from "./tools/service";
import { ApprovalModal, referenceFor, SecretModal, SecretPickerModal } from "./ui/modals";
import { EnvironmentVariablesSettingTab } from "./ui/settingsTab";
import { EnvironmentVariablesView, ICON_LOCKED, ICON_UNLOCKED, VIEW_TYPE } from "./ui/view";

/** How many ports to try, upward from the configured one, when another vault or program holds it. */
const MAX_PORT_TRIES = 20;

export default class EnvironmentVariablesPlugin extends Plugin {
  data!: PluginData;
  store!: SecretStore;
  audit!: AuditLog;
  broker!: Broker;
  server: LocalServer | null = null;
  registry!: ToolRegistry;
  tools!: ToolsService;
  /** Who runs a tool from the panel: the user, with access to every variable. */
  readonly localClient: ClientContext = { id: "obsidian", name: "Obsidian", access: { mode: "all" } };

  private ribbon: HTMLElement | null = null;
  private lastActivity = Date.now();
  private serverListeners = new Set<() => void>();
  private saveTimer: number | undefined;
  private propertyTimer: number | undefined;
  private propertyDocs = new Set<Document>();
  private toolScanTimer: number | undefined;
  /** This vault's identity: its server, port and MCP server name are its own. */
  vaultId = "";
  vaultName = "";
  /** Connected AI clients still point at an old name or port: re-register them once the server runs. */
  private pendingReconnect = false;

  get vaultFilePath(): string {
    return `${this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`}/vault.enc`;
  }

  async onload(): Promise<void> {
    this.data = withDefaults((await this.loadData()) as Partial<PluginData> | null);
    const vaultAdapter = this.app.vault.adapter;
    this.vaultName = this.app.vault.getName();
    this.vaultId = vaultIdOf(vaultAdapter instanceof FileSystemAdapter ? vaultAdapter.getBasePath() : this.vaultName);
    await this.ensureServerName();

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

    // Vault tools: MCP tools defined by notes, found by tag.
    const source = new ObsidianNoteSource(this.app);
    const s = () => this.data.settings;
    this.registry = new ToolRegistry(
      source,
      () => ({ enabled: s().toolsEnabled, toolTag: s().toolTag, scriptsEnabled: s().scriptsEnabled }),
    );
    this.tools = new ToolsService({
      registry: this.registry,
      source,
      broker: this.broker,
      runner: new ScriptRunner(),
      audit: this.audit,
      settings: () => ({ ...s() }),
      guide: () => this.agentGuide(),
    });
    this.registerEvent(this.app.metadataCache.on("changed", () => this.scheduleToolScan()));
    this.registerEvent(this.app.metadataCache.on("resolved", () => this.scheduleToolScan()));
    this.registerEvent(this.app.vault.on("delete", () => this.scheduleToolScan()));
    this.registerEvent(this.app.vault.on("rename", () => this.scheduleToolScan()));
    this.register(() => {
      if (this.toolScanTimer !== undefined) window.clearTimeout(this.toolScanTimer);
    });

    this.registerView(VIEW_TYPE, (leaf) => new EnvironmentVariablesView(leaf, this));

    // Left ribbon icon: key when unlocked, lock when locked.
    this.ribbon = this.addRibbonIcon(ICON_LOCKED, t("ribbon.locked"), () => void this.activateView());
    this.ribbon.addClass("ev-ribbon");
    this.register(this.store.onChange(() => this.updateRibbon()));
    this.register(this.store.onChange(() => this.syncNameIndex()));
    // Editor chips turn red or back when names change (unlock, lock, add, remove).
    this.register(this.store.onChange(() => this.app.workspace.updateOptions()));
    this.updateRibbon();

    this.addCommand({ id: "open-panel", name: t("cmd.open"), callback: () => void this.activateView() });
    this.addCommand({ id: "lock", name: t("cmd.lock"), callback: () => this.lock() });
    this.addCommand({
      id: "insert-reference",
      name: t("cmd.insert"),
      editorCallback: (editor: Editor) => {
        // A reference holds no value, so it can be inserted while the vault is locked.
        if (this.variableNames().length === 0) {
          if (!this.requireUnlocked()) return;
        }
        new SecretPickerModal(this.app, () => this.variableNames(), (entry) => editor.replaceSelection(referenceFor(entry))).open();
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

    this.addCommand({ id: "copy-agent-guide", name: t("cmd.copyGuide"), callback: () => this.copyAgentGuide() });

    this.addSettingTab(new EnvironmentVariablesSettingTab(this.app, this));
    this.registerEditorSuggest(new SecretNameSuggest(this));
    // Properties panel: attach the same autocomplete to a value field when it gets focus.
    setPropertySuggestActive(true);
    this.register(() => setPropertySuggestActive(false));
    const watchDocument = (doc: Document) => {
      if (this.propertyDocs.has(doc)) return;
      this.propertyDocs.add(doc);
      this.registerDomEvent(doc, "focusin", (evt) => attachPropertySuggest(this, evt.target));
      // After editing, show the chip again once Obsidian has saved the value.
      this.registerDomEvent(doc, "focusout", () => this.schedulePropertyChips());
    };
    // Not activeDocument: when the plugin is enabled from Settings, that is not the main window.
    watchDocument(this.app.workspace.containerEl.ownerDocument);
    this.app.workspace.iterateAllLeaves((leaf) => watchDocument(leaf.view.containerEl.ownerDocument));
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
    this.app.workspace.onLayoutReady(() => this.schedulePropertyChips());
    this.registerMarkdownPostProcessor(renderPlaceholders);
    this.registerEditorExtension(placeholderExtension(() => this.knownNames()));
    this.registerEvent(this.app.workspace.on("editor-paste", (evt, editor) => this.onPaste(evt, editor)));

    this.registerInterval(window.setInterval(() => this.checkAutoLock(), 30_000));

    this.app.workspace.onLayoutReady(() => {
      if (this.data.settings.serverEnabled) void this.startServer();
      this.scheduleToolScan();
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
      for (const doc of this.propertyDocs) decorateProperties(doc, () => this.knownNames());
    }, 150);
  }

  // ---------- variable names ----------

  /** Names and types for writing references: from the vault when unlocked, else from the index. */
  variableNames(): NameEntry[] {
    if (this.store.isUnlocked) return this.store.list().map((s) => ({ name: s.name, type: s.type }));
    return this.data.settings.showNamesWhileLocked ? this.data.nameIndex : [];
  }

  /** Names to check chips against, or null when unknown (locked with the name index turned off). */
  knownNames(): Set<string> | null {
    if (!this.store.isUnlocked && !this.data.settings.showNamesWhileLocked) return null;
    return new Set(this.variableNames().map((e) => e.name));
  }

  /** Keeps the name index in data.json in step with the vault. Runs only while unlocked. */
  syncNameIndex(): void {
    if (!this.store.isUnlocked) return;
    const next = this.data.settings.showNamesWhileLocked ? this.store.list().map((s) => ({ name: s.name, type: s.type })) : [];
    if (JSON.stringify(next) === JSON.stringify(this.data.nameIndex)) return;
    this.data.nameIndex = next;
    this.scheduleSave();
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

  private createServer(port: number): LocalServer {
    return new LocalServer({
      port,
      broker: this.broker,
      version: this.manifest.version,
      tools: this.tools,
      guide: (request) => this.agentGuide(request),
      vault: { id: this.vaultId, name: this.vaultName },
      authenticate: async (token) => {
        const client = await findClient(this.data.clients, token);
        if (!client) return null;
        client.lastUsedAt = new Date().toISOString();
        this.scheduleSave();
        return contextOf(client);
      },
    });
  }

  /**
   * Starts this vault's server. When the port belongs to another vault (or another program), the
   * server moves to the next free port and the connected AI clients are re-registered with it.
   */
  private async startServer(): Promise<void> {
    if (this.server?.running) return;
    const requested = this.data.settings.port;
    let port = requested;
    let owner: PortOwner | null = null;
    let ownRetries = 0;
    let lastError = "";
    for (let tries = 0; tries < MAX_PORT_TRIES && !this.server?.running; tries++) {
      const server = this.createServer(port);
      try {
        await server.start();
        this.server = server;
      } catch (err) {
        if (!(err instanceof PortInUseError)) {
          lastError = err instanceof Error ? err.message : String(err);
          break;
        }
        const found = await probePort(port);
        // Our own previous server, still closing after a plugin reload: wait for it instead of moving.
        if (found?.vaultId === this.vaultId && ownRetries < 6) {
          ownRetries++;
          tries--;
          await new Promise((r) => window.setTimeout(r, 500));
          continue;
        }
        if (port === requested) owner = found;
        lastError = err.message;
        if (port >= 65535) break;
        port++;
      }
    }
    if (!this.server?.running) {
      this.server = null;
      new Notice(t("notice.serverError", { error: lastError }));
    } else if (port !== requested) {
      this.data.settings.port = port;
      await this.saveAll();
      this.pendingReconnect = true;
      new Notice(t("notice.portMoved", { from: requested, to: port, owner: this.describeOwner(owner) }), 12_000);
    }
    this.emitServerChange();
    if (this.server?.running && this.pendingReconnect) {
      this.pendingReconnect = false;
      await this.reconnectIntegrations();
    }
  }

  private describeOwner(owner: PortOwner | null): string {
    if (owner?.isPlugin && owner.vaultName) return t("notice.portOwnerVault", { name: owner.vaultName });
    if (owner?.isPlugin) return t("notice.portOwnerOtherVault");
    return t("notice.portOwnerProgram");
  }

  // ---------- MCP server name ----------

  get serverName(): string {
    return this.data.settings.mcpServerName;
  }

  /**
   * Gives the vault its own MCP server name on first load. A vault connected before 1.3.0 keeps the
   * old shared name only if the registration under it is its own (same token); otherwise another vault
   * owns it, and this vault's clients are re-registered under the new name when the server starts.
   */
  private async ensureServerName(): Promise<void> {
    const s = this.data.settings;
    if (SERVER_NAME_PATTERN.test(s.mcpServerName)) return;
    const connected = this.data.clients.filter((c) => c.integration);
    let ownsLegacy = false;
    for (const c of connected) {
      if (await this.ownsRegistration(integrationById(c.integration!), MCP_SERVER_NAME, c)) ownsLegacy = true;
    }
    s.mcpServerName = ownsLegacy ? MCP_SERVER_NAME : serverNameFor(this.vaultName, this.vaultId);
    if (!ownsLegacy && connected.length > 0) this.pendingReconnect = true;
    await this.saveAll();
  }

  /** True when the entry registered under `name` in that AI client holds this vault's token. */
  private async ownsRegistration(integration: Integration | undefined, name: string, client: ClientRecord): Promise<boolean> {
    if (!integration) return false;
    const token = await integration.registeredToken(name).catch(() => null);
    return !!token && !!(await findClient([client], token));
  }

  /** Renames this vault's server in every connected AI client. */
  async setMcpServerName(name: string): Promise<void> {
    const old = this.serverName;
    if (name === old || !SERVER_NAME_PATTERN.test(name)) return;
    for (const c of this.data.clients.filter((x) => x.integration)) {
      const integration = integrationById(c.integration!);
      // Never remove an entry that another vault registered under the old name.
      if (await this.ownsRegistration(integration, old, c)) await integration?.disconnect(old).catch(() => undefined);
    }
    this.data.settings.mcpServerName = name;
    await this.saveAll();
    if (this.server?.running) await this.reconnectIntegrations();
    else this.pendingReconnect = true;
    this.emitServerChange();
  }

  private async stopServer(): Promise<void> {
    await this.server?.stop();
    this.server = null;
    this.emitServerChange();
  }

  // ---------- vault tools ----------

  async setToolsEnabled(enabled: boolean): Promise<void> {
    this.data.settings.toolsEnabled = enabled;
    await this.saveAll();
    this.onToolSettingsChanged();
  }

  async setScriptsEnabled(enabled: boolean): Promise<void> {
    this.data.settings.scriptsEnabled = enabled;
    await this.saveAll();
    this.onToolSettingsChanged();
  }

  /** Tags, the scripts switch or the feature switch changed: rescan and tell connected clients. */
  onToolSettingsChanged(): void {
    void this.registry.refresh().then(() => {
      this.registry.updateStatuses();
      this.server?.notifyToolsChanged();
      this.emitServerChange();
    });
  }

  private scheduleToolScan(): void {
    if (!this.data.settings.toolsEnabled) return;
    if (this.toolScanTimer !== undefined) window.clearTimeout(this.toolScanTimer);
    this.toolScanTimer = window.setTimeout(() => {
      this.toolScanTimer = undefined;
      void this.registry.refresh();
    }, 300);
  }

  /** The guide for AI agents, in the language of Obsidian, with the current settings. */
  agentGuide(request?: string): string {
    const s = this.data.settings;
    return buildGuide(
      getLanguage().toLowerCase().startsWith("pt") ? "pt" : "en",
      {
        vaultName: this.vaultName,
        vaultPath: this.app.vault.adapter instanceof FileSystemAdapter ? this.app.vault.adapter.getBasePath() : this.vaultName,
        mcpServerName: s.mcpServerName,
        toolsEnabled: s.toolsEnabled,
        scriptsEnabled: s.scriptsEnabled,
        toolTag: s.toolTag,
        requestTag: s.requestTag,
        scriptTimeoutSeconds: s.scriptTimeoutSeconds,
        serverUrl: this.serverUrl,
        serverRunning: this.server?.running ?? false,
        tools: this.registry.list().map((e) => ({ name: e.name, status: e.status })),
      },
      request,
    );
  }

  copyAgentGuide(): void {
    void navigator.clipboard.writeText(this.agentGuide());
    new Notice(t("notice.guideCopied"), 8_000);
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
      const integration = integrationById(client.integration);
      // Only remove the entry if it is this vault's: under a shared old name it may belong to another vault.
      if (await this.ownsRegistration(integration, this.serverName, client)) await integration?.disconnect(this.serverName).catch(() => undefined);
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
      await integration.connect(this.serverUrl, token, this.serverName);
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

  /** After a port or name change, re-register every connected AI client with the new URL and name. */
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
