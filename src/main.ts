import { Editor, FileSystemAdapter, Notice, normalizePath, Plugin, setIcon, TFolder } from "obsidian";
import { AuditLog } from "./audit/auditLog";
import { createSetupHandler, HooksDataPusher, hooksHosts, toolNoteFolders } from "./ecosystem/hooksFeed";
import { installAndEnableEcosystem } from "./ecosystem/installEcosystem";
import {
  AIEcosystemAPI,
  EcosystemClientContext,
  EcosystemConnector,
  getEcosystemPlugin,
  HubPrompt,
  HubRequest,
  HubResponse,
  HubRoute,
  HOOKS_SERVICE,
  HooksService,
  HubTool,
  IndexedToolRunner,
  InstalledMcpPackage,
  isEcosystemEnabled,
  listEcosystemServiceNames,
  MCP_PACKAGES_SERVICE,
  McpPackagesService,
  MODULE_ID,
  ModuleRegistration,
  SUPPORTED_API_VERSION,
  TOOL_RUNNER_SERVICE,
} from "./ecosystem/moduleConnector";
import { clearProperties, decorateProperties } from "./editor/properties";
import { placeholderExtension, renderPlaceholders } from "./editor/render";
import { attachPropertySuggest, SecretNameSuggest, setPropertySuggestActive } from "./editor/suggest";
import { currentLanguage, setLanguage, t } from "./i18n";
import { Integration, IntegrationId, integrationById, MCP_SERVER_NAME } from "./integrations/integrations";
import { Broker, BrokerActivityEvent } from "./secrets/broker";
import { SecretAdoptionCoordinator } from "./secrets/secretAdoption";
import { createSecretVaultService, SecretVaultService } from "./secrets/secretVaultService";
import { detectToken } from "./secrets/tokenPatterns";
import { nodeTransport } from "./secrets/transport";
import { accessOf, ClientAccess, ClientContext, ClientRecord, contextOf, createClient, findClient } from "./server/clients";
import { LocalServer, PortInUseError, PortOwner, probePort, statusFor } from "./server/localServer";
import { buildMcpInstructions, BUILT_IN_TOOLS, executeMcpToolCall, executeVaultToolRun, PROMPTS } from "./server/mcp";
import { SERVER_NAME_PATTERN, serverNameFor, vaultIdOf } from "./server/vaultIdentity";
import { LanguageSetting, NameEntry, PluginData, withDefaults } from "./settings";
import { SecretStore, VaultIO } from "./store/secretStore";
import { buildGuide, guideIndex, guideTopic } from "./tools/guide";
import { appForEntry, McpCatalogEntry } from "./tools/mcpCatalog";
import { migrateStorage } from "./storageMigration";
import { computeMcpGroupStats, hashLogo, matchedNotePaths, McpAppConfig, McpGroupConfig, McpGroupStats, randomGroupId } from "./tools/mcpGroups";
import { McpDbManager } from "./tools/mcpDb";
import { planGroupSync } from "./tools/mcpPackagesSync";
import { metadataFor, NATIVE_TOOL_METADATA } from "./tools/hubMetadata";
import { CREATE_SECRET_TOOL_NAME, createSecretHubTool, CreateSecretPrefill, CreateSecretScreen } from "./tools/createSecretTool";
import { ObsidianNoteSource } from "./tools/obsidianSource";
import { ToolRegistry } from "./tools/registry";
import { ScriptRunner } from "./tools/scriptRunner";
import { ToolsService } from "./tools/service";
import { computeSyncHash } from "./tools/syncHash";
import { templatesToCreate, templateText } from "./tools/serviceTemplates";
import { NoteSource } from "./tools/types";
import { defaultLogoFor } from "./ui/defaultLogos";
import { ApprovalModal, referenceFor, SecretModal, SecretPickerModal } from "./ui/modals";
import { EnvironmentVariablesSettingTab } from "./ui/settingsTab";
import { EnvironmentVariablesView, ICON_LOCKED, ICON_UNLOCKED, VIEW_TYPE } from "./ui/view";

/** Note that anchors every downloaded MCP package: reused by name if the vault already has one. */
const MCP_HUB_NOTE_NAME = "MCP Tools";

/** How many ports to try, upward from the configured one, when another vault or program holds it. */
const MAX_PORT_TRIES = 20;

export default class EnvironmentVariablesPlugin extends Plugin {
  data!: PluginData;
  store!: SecretStore;
  audit!: AuditLog;
  broker!: Broker;
  secretService!: SecretVaultService;
  adoption!: SecretAdoptionCoordinator;
  connector!: EcosystemConnector;
  server: LocalServer | null = null;
  registry!: ToolRegistry;
  tools!: ToolsService;
  mcpDb!: McpDbManager;
  /** Read access to the vault's notes, shared with MCP groups to resolve their tag/link filters. */
  toolSource!: NoteSource;
  /** Who runs a tool from the panel: the user, with access to every variable. */
  readonly localClient: ClientContext = { id: "obsidian", name: "Obsidian", access: { mode: "all" } };

  private ribbon: HTMLElement | null = null;
  private lastActivity = Date.now();
  private serverListeners = new Set<() => void>();
  private saveTimer: number | undefined;
  private propertyTimer: number | undefined;
  private propertyDocs = new Set<Document>();
  private toolScanTimer: number | undefined;
  private disposeSecretService: (() => void) | undefined;
  private disposeToolRunner: (() => void) | undefined;
  private disposeServiceListener: (() => void) | undefined;
  private disposeMcpPackagesWatch: (() => void) | undefined;
  private mcpPackagesUnsub: (() => void) | undefined;
  private disposeSetupHandler: (() => void) | undefined;
  private readonly hooksPusher = new HooksDataPusher();
  private transitionNoticeShown = false;
  /** This vault's identity: its server, port and MCP server name are its own. */
  vaultId = "";
  vaultName = "";
  /** Connected AI clients still point at an old name or port: re-register them once the server runs. */
  private pendingReconnect = false;
  /** In-memory last hash of tools and instances pushed to AI Ecosystem. */
  private lastSyncHash: string | null = null;

  get pluginDirPath(): string {
    return this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`;
  }

  get vaultFilePath(): string {
    return `${this.pluginDirPath}/vault.enc`;
  }

  get auditFilePath(): string {
    return `${this.pluginDirPath}/audit.json`;
  }

  get dataFilePath(): string {
    return `${this.pluginDirPath}/data.json`;
  }

  get backupDataFilePath(): string {
    return `${this.pluginDirPath}/data.json.bak`;
  }

  get isEcosystemConnected(): boolean {
    return this.connector?.status === "connected" && Boolean(this.connector.api);
  }

  get ecosystemPort(): number {
    return this.connector?.api?.getServerStatus().port ?? this.data.settings.port;
  }

  async onload(): Promise<void> {
    this.data = withDefaults((await this.loadData()) as Partial<PluginData> | null);
    setLanguage(this.data.settings.language);
    const vaultAdapter = this.app.vault.adapter;
    this.vaultName = this.app.vault.getName();
    this.vaultId = vaultIdOf(vaultAdapter instanceof FileSystemAdapter ? vaultAdapter.getBasePath() : this.vaultName);
    await this.ensureServerName();

    const adapter = this.app.vault.adapter;
    const migration = await migrateStorage({
      adapter,
      pluginDir: this.pluginDirPath,
      data: this.data,
    });
    this.data = migration.data;

    const path = this.vaultFilePath;
    const io: VaultIO = {
      read: async () => ((await adapter.exists(path)) ? adapter.read(path) : null),
      write: (content) => adapter.write(path, content),
    };
    this.store = new SecretStore(io);
    this.audit = new AuditLog(migration.auditEntries, (entries) => {
      void adapter.write(this.auditFilePath, JSON.stringify(entries, null, 2)).catch((err) => {
        console.error("[environment-variables] Failed to write audit.json:", err);
      });
    });

    const limits = () => ({
      timeoutMs: this.data.settings.timeoutSeconds * 1000,
      maxResponseBytes: this.data.settings.maxResponseMB * 1024 * 1024,
      maxRedirects: 5,
    });
    const forwardActivity = (evt: BrokerActivityEvent, kind: "http" | "service") => {
      this.connector?.api?.logActivity({
        kind,
        method: evt.method ?? "GET",
        target: evt.target,
        moduleId: MODULE_ID,
        client: evt.client,
        status: evt.status ?? 0,
        durationMs: evt.durationMs ?? 0,
        payload: evt.payload,
        response: evt.response,
      });
    };

    this.broker = new Broker(
      this.store,
      nodeTransport,
      (req) => this.askApproval(req),
      this.audit,
      limits,
      () => this.touch(),
      (evt) => forwardActivity(evt, "http"),
    );

    this.secretService = createSecretVaultService({
      store: this.store,
      transport: nodeTransport,
      audit: this.audit,
      limits,
      onSecretsUsed: () => this.touch(),
      onActivity: (evt) => forwardActivity(evt, "service"),
    });

    this.adoption = new SecretAdoptionCoordinator({
      service: this.secretService,
      audit: this.audit,
      isUnlocked: () => this.store.isUnlocked,
      onAdopted: (evt) => {
        new Notice(t("notice.secretAdopted", { module: evt.ownerModuleId, placeholder: evt.placeholder }), 8_000);
      },
    });

    // Vault tools: MCP tools defined by notes or SQLite databases (mcp.db)
    const source = new ObsidianNoteSource(this.app);
    this.toolSource = source;
    this.mcpDb = new McpDbManager(this.app);
    const s = () => this.data.settings;
    this.registry = new ToolRegistry(
      source,
      () => ({ enabled: s().toolsEnabled, toolTag: s().toolTag, scriptsEnabled: s().scriptsEnabled }),
      () => this.mcpDb.getTools(),
    );
    this.tools = new ToolsService({
      registry: this.registry,
      source,
      broker: this.broker,
      runner: new ScriptRunner(),
      audit: this.audit,
      settings: () => ({ ...s() }),
      guide: (topic?: string) => this.agentGuide(undefined, topic),
      dbManager: this.mcpDb,
    });
    this.register(this.registry.onChange(() => this.syncEcosystemTools()));
    this.register(this.registry.onChange(() => this.syncHooksData()));
    // Only tool notes, instance notes and package databases (*.db) trigger updates.
    this.registerEvent(this.app.metadataCache.on("changed", (file) => this.onNoteEvent(() => this.registry.noteChanged(file.path))));
    this.registerEvent(this.app.metadataCache.on("resolved", () => this.scheduleToolScan()));
    this.registerEvent(this.app.vault.on("delete", (file) => {
      if (file.name.endsWith(".db")) {
        this.mcpDb.refresh();
        void this.registry.refresh();
      } else {
        this.onNoteEvent(() => this.registry.noteDeleted(file.path));
      }
    }));
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
      if (file.name.endsWith(".db") || oldPath.endsWith(".db")) {
        this.mcpDb.refresh();
        void this.registry.refresh();
      } else {
        this.onNoteEvent(() => this.registry.noteRenamed(oldPath, file.path));
      }
    }));
    this.registerEvent(this.app.vault.on("create", (file) => {
      if (file.name.endsWith(".db")) {
        this.mcpDb.refresh();
        void this.registry.refresh();
      }
    }));
    this.register(() => {
      this.mcpDb.close();
      if (this.toolScanTimer !== undefined) window.clearTimeout(this.toolScanTimer);
    });

    this.registerView(VIEW_TYPE, (leaf) => new EnvironmentVariablesView(leaf, this));

    // Left ribbon icon: key when unlocked, lock when locked.
    this.ribbon = this.addRibbonIcon(ICON_LOCKED, t("ribbon.locked"), () => void this.activateView());
    this.ribbon.addClass("ev-ribbon");
    this.register(this.store.onChange(() => this.updateRibbon()));
    this.register(this.store.onChange(() => this.syncNameIndex()));
    this.register(this.store.onChange(() => this.syncHooksData()));
    this.register(
      this.store.onChange(() => {
        if (this.store.isUnlocked && this.connector?.api) {
          void this.adoption.scanAll(this.connector.api, listEcosystemServiceNames(this.app));
        }
      }),
    );
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

    this.connector = new EcosystemConnector({
      app: this.app,
      registration: () => this.buildModuleRegistration(),
      onBeforeConnect: async () => {
        if (this.server) {
          await this.stopServer();
        }
      },
      onConnected: (api) => void this.handleEcosystemConnected(api),
      onDisconnected: () => this.handleEcosystemDisconnected(),
      onMissing: () => void this.handleEcosystemMissing(),
    });
    this.connector.start();

    this.app.workspace.onLayoutReady(() => {
      this.scheduleToolScan();
      void this.createServiceTemplates();
      if (!this.isEcosystemConnected && !isEcosystemEnabled(this.app) && this.data.settings.serverEnabled) {
        void this.startTransitionServer();
      }
    });
  }

  onunload(): void {
    this.disposeSetupHandler?.();
    this.disposeSetupHandler = undefined;
    this.disposeServiceListener?.();
    this.disposeServiceListener = undefined;
    this.disposeSecretService?.();
    this.disposeSecretService = undefined;
    this.disposeToolRunner?.();
    this.disposeToolRunner = undefined;
    this.mcpPackagesUnsub?.();
    this.mcpPackagesUnsub = undefined;
    this.disposeMcpPackagesWatch?.();
    this.disposeMcpPackagesWatch = undefined;
    this.connector?.stop();
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

  /** Opens the AI Ecosystem Live Request Inspector when connected. */
  async openEcosystemInspector(placement: "sidebar" | "tab" = "tab"): Promise<void> {
    const eco = getEcosystemPlugin(this.app) as unknown as {
      openInspectorView?: (placement?: "sidebar" | "tab") => Promise<void>;
      openInspector?: (placement?: "sidebar" | "tab") => Promise<void>;
    };
    if (eco && typeof eco.openInspectorView === "function") {
      await eco.openInspectorView(placement);
    } else if (eco && typeof eco.openInspector === "function") {
      await eco.openInspector(placement);
    }
  }

  /** One-click installer for the AI Ecosystem plugin from Transition Mode. */
  async installAiEcosystem(): Promise<void> {
    await installAndEnableEcosystem(this.app);
  }

  /** Switches the plugin's language and redraws what is open. Command names follow after a restart. */
  async setLanguageSetting(language: LanguageSetting): Promise<void> {
    this.data.settings.language = language;
    setLanguage(language);
    await this.saveAll();
    this.updateRibbon();
    this.syncEcosystemTools();
    this.emitServerChange(); // the panel redraws on this event
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
    if (this.store.isUnlocked) return this.currentNameEntries();
    return this.data.settings.showNamesWhileLocked ? this.data.nameIndex : [];
  }

  /** Secrets and values: they share one namespace and one {{secret:NAME}} key. */
  private currentNameEntries(): NameEntry[] {
    return [
      ...this.store.list().map((s): NameEntry => ({ name: s.name, type: s.type })),
      ...this.store.listValues().map((v): NameEntry => ({ name: v.name, type: "value" })),
    ];
  }

  /** Names to check chips against, or null when unknown (locked with the name index turned off). */
  knownNames(): Set<string> | null {
    if (!this.store.isUnlocked && !this.data.settings.showNamesWhileLocked) return null;
    return new Set(this.variableNames().map((e) => e.name));
  }

  /** Keeps the name index in data.json in step with the vault. Runs only while unlocked. */
  syncNameIndex(): void {
    if (!this.store.isUnlocked) return;
    const next = this.data.settings.showNamesWhileLocked ? this.currentNameEntries() : [];
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

  // ---------- AI Ecosystem & Transition Mode server ----------

  onServerChange(listener: () => void): () => void {
    this.serverListeners.add(listener);
    return () => this.serverListeners.delete(listener);
  }

  private emitServerChange(): void {
    for (const l of this.serverListeners) l();
  }

  private resolveHubClient(client: EcosystemClientContext): ClientContext {
    const found = this.data.clients.find((c) => c.id === client.id || c.name === client.name);
    if (found) {
      found.lastUsedAt = new Date().toISOString();
      this.scheduleSave();
      return contextOf(found);
    }
    return {
      id: client.id || "ecosystem-client",
      name: client.name || "AI Ecosystem Client",
      access: this.isEcosystemConnected ? { mode: "all" } : { mode: "some", secretIds: [] },
    };
  }

  /** Builds the complete ModuleRegistration for AI Ecosystem Provider API (v1). */
  buildModuleRegistration(): ModuleRegistration {
    const handleRequestRoute = async (req: HubRequest): Promise<HubResponse> => {
      const payload = (typeof req.body === "object" && req.body !== null ? req.body : {}) as {
        method?: string;
        url?: string;
        headers?: Record<string, string>;
        body?: string;
      };
      const result = await this.broker.execute(
        {
          method: typeof payload.method === "string" ? payload.method : undefined,
          url: typeof payload.url === "string" ? payload.url : "",
          headers: payload.headers,
          body: typeof payload.body === "string" ? payload.body : undefined,
        },
        this.resolveHubClient(req.client),
      );
      return { status: result.ok ? 200 : statusFor(result.error.code), body: result };
    };

    const handleSecretsRoute = (req: HubRequest): HubResponse => {
      const result = this.broker.listSecrets(this.resolveHubClient(req.client));
      return { status: result.ok ? 200 : 423, body: result };
    };

    const handleToolsListRoute = async (): Promise<HubResponse> => {
      if (!this.tools.enabled()) {
        return { status: 404, body: { ok: false, error: { code: "tools_disabled", message: "Vault tools are turned off in the plugin settings." } } };
      }
      await this.tools.ready();
      return { status: 200, body: { ok: true, ...this.tools.status() } };
    };

    const handleToolsGuideRoute = (req: HubRequest): HubResponse => {
      if (!this.tools.enabled()) {
        return { status: 404, body: { ok: false, error: { code: "tools_disabled", message: "Vault tools are turned off in the plugin settings." } } };
      }
      const text = this.agentGuide(req.query.request);
      return { status: 200, headers: { "Content-Type": "text/markdown; charset=utf-8" }, body: text };
    };

    const handleToolRunRoute = async (req: HubRequest): Promise<HubResponse> => {
      if (!this.tools.enabled()) {
        return { status: 404, body: { ok: false, error: { code: "tools_disabled", message: "Vault tools are turned off in the plugin settings." } } };
      }
      const name = decodeURIComponent(req.params.name ?? "");
      const bodyObj = (typeof req.body === "object" && req.body !== null ? req.body : {}) as Record<string, unknown>;
      const args =
        typeof bodyObj.arguments === "object" && bodyObj.arguments !== null && !Array.isArray(bodyObj.arguments)
          ? (bodyObj.arguments as Record<string, unknown>)
          : bodyObj;
      const out = await this.tools.callMcp("run_vault_tool", { name, arguments: args }, this.resolveHubClient(req.client));
      return { status: out.isError ? 400 : 200, body: out.isError ? out.value : { ok: true, result: out.value } };
    };

    const routes: HubRoute[] = [
      { method: "POST", path: "/request", description: "Execute an outbound HTTP request with {{secret:NAME}} placeholders", handler: handleRequestRoute },
      { method: "GET", path: "/secrets", description: "List environment variable names and metadata (no secret values)", handler: handleSecretsRoute },
      { method: "GET", path: "/tools", description: "List vault tools (#mcp/tool)", handler: handleToolsListRoute },
      { method: "GET", path: "/tools/guide", description: "Read the vault tool authoring guide", handler: handleToolsGuideRoute },
      { method: "POST", path: "/tools/:name", description: "Run a vault tool by name", handler: handleToolRunRoute },
    ];

    const legacyAliases: HubRoute[] = [
      { method: "POST", path: "/v1/request", description: "Legacy alias for POST /api/v1/environment-variables/request", handler: handleRequestRoute },
      { method: "GET", path: "/v1/secrets", description: "Legacy alias for GET /api/v1/environment-variables/secrets", handler: handleSecretsRoute },
      { method: "GET", path: "/v1/tools", description: "Legacy alias for GET /api/v1/environment-variables/tools", handler: handleToolsListRoute },
      { method: "GET", path: "/v1/tools/guide", description: "Legacy alias for GET /api/v1/environment-variables/tools/guide", handler: handleToolsGuideRoute },
      { method: "POST", path: "/v1/tools/:name", description: "Legacy alias for POST /api/v1/environment-variables/tools/:name", handler: handleToolRunRoute },
    ];

    return {
      id: MODULE_ID,
      name: "Environment Keys",
      version: this.manifest.version,
      apiVersion: SUPPORTED_API_VERSION,
      routes,
      legacyAliases,
      tools: this.buildHubTools(),
      prompts: this.buildHubPrompts(),
      instructions: buildMcpInstructions(this.tools.enabled()),
    };
  }

  /** Converts current MCP tools (core + vault #mcp/tool notes) into AI Ecosystem HubTool definitions. */
  buildHubTools(): HubTool[] {
    const defs = [...BUILT_IN_TOOLS, ...(this.tools.enabled() ? this.tools.mcpTools() : [])];
    const tools: HubTool[] = defs.map((def) => ({
      ...metadataFor(def.name, def.annotations?.destructiveHint === true),
      name: def.name,
      title: def.title ?? def.name,
      description: def.description,
      inputSchema: def.inputSchema,
      annotations: def.annotations,
      handler: async (args, ctx) => {
        const res = await executeMcpToolCall(def.name, args, {
          broker: this.broker,
          client: this.resolveHubClient(ctx.client),
          tools: this.tools,
          responseWriter: this.app.vault.adapter,
        });
        return {
          content: res.content,
          isError: res.isError,
        };
      },
    }));
    return [...tools, { ...NATIVE_TOOL_METADATA[CREATE_SECRET_TOOL_NAME], ...this.createSecretTool() }];
  }

  /** env_criar_secret: opens the create-variable screen for the user. The value never passes through the agent. */
  private createSecretTool(): HubTool {
    return createSecretHubTool({
      isUnlocked: () => this.store.isUnlocked,
      openScreen: (prefill) => this.openCreateSecretScreen(prefill),
      suggestedHosts: () => this.data.serviceHosts,
      audit: this.audit,
      clientName: (ctx) => this.resolveHubClient(ctx.client).name,
      onCall: () => this.touch(),
    });
  }

  /** The panel's New variable form in create-only mode, prefilled with the agent's suggestions. */
  private openCreateSecretScreen(prefill: CreateSecretPrefill): CreateSecretScreen {
    new Notice(t("notice.createSecretAsked"), 8_000);
    let modal: SecretModal | undefined;
    const result = new Promise<string | null>((resolve) => {
      modal = new SecretModal(this.app, this.store, null, (secret) => resolve(secret.name), "", {
        createOnly: true,
        fromAgent: true,
        prefill,
        onClosed: (saved) => {
          if (!saved) resolve(null);
        },
      });
      modal.open();
    });
    return { result, close: () => modal?.close() };
  }

  /** Converts MCP prompts (`configure_vault_tools`) into AI Ecosystem HubPrompt definitions. */
  buildHubPrompts(): HubPrompt[] {
    if (!this.tools.enabled()) return [];
    return PROMPTS.map((def) => ({
      name: def.name,
      title: def.title,
      description: def.description,
      arguments: def.arguments,
      handler: (args) => ({
        description: def.description,
        messages: [{ role: "user", content: { type: "text", text: this.agentGuide(args.request, typeof args.topic === "string" ? args.topic : undefined) } }],
      }),
    }));
  }

  /** Pushes updated dynamic vault tools and prompts to AI Ecosystem when connected. */
  syncEcosystemTools(): void {
    const api = this.connector?.api;
    if (!api) return;

    const tools = this.tools.enabled() ? this.registry.list() : [];
    const hash = computeSyncHash(tools);
    if (hash === this.lastSyncHash) return;
    this.lastSyncHash = hash;

    try {
      api.updateTools(MODULE_ID, this.buildHubTools());
      api.updatePrompts(MODULE_ID, this.buildHubPrompts());
    } catch (err) {
      console.error("[environment-variables] Failed to sync tools with AI Ecosystem:", err);
    }
    void this.syncToolIndex();
  }

  private indexRunning = false;
  private indexAgain = false;

  /**
   * Writes the API tools (mcp.db packages and tool notes) into this module's tools.db. They are not registered
   * in MCP tools/list: tools_find finds them and tools_run runs them through the `tool-runner` service.
   * Calls that arrive during a sync are coalesced into one more run.
   */
  private async syncToolIndex(): Promise<void> {
    const api = this.connector?.api;
    if (!api?.toolIndex) return;
    if (this.indexRunning) {
      this.indexAgain = true;
      return;
    }
    this.indexRunning = true;
    try {
      do {
        this.indexAgain = false;
        const entries = await this.tools.apiIndexEntries();
        await api.toolIndex.sync(MODULE_ID, entries);
      } while (this.indexAgain);
    } catch (err) {
      console.error("[environment-variables] Failed to sync the tool index:", err);
    } finally {
      this.indexRunning = false;
    }
  }

  /** `tool-runner:environment-variables`: runs indexed API tools for tools_run (secrets resolved by the broker). */
  private readonly toolRunner: IndexedToolRunner = {
    run: async (id, args, ctx) => {
      const res = await executeVaultToolRun(id, args, {
        client: this.resolveHubClient(ctx.client),
        tools: this.tools,
      });
      return { content: res.content, structuredContent: res.structuredContent, isError: res.isError };
    },
  };

  private async handleEcosystemConnected(api: AIEcosystemAPI): Promise<void> {
    if (this.server) {
      await this.stopServer();
    }

    this.disposeSecretService?.();
    const serviceDisposer = api.registerService("secrets", MODULE_ID, this.secretService);
    this.disposeSecretService =
      typeof serviceDisposer === "function"
        ? serviceDisposer
        : () => {
            try {
              api.unregisterService("secrets", MODULE_ID);
            } catch {
              // Ignore
            }
          };

    if (this.data.clients.length > 0) {
      await api
        .importClients(
          this.data.clients.map((c) => ({
            id: c.id,
            name: c.name,
            tokenHash: c.tokenHash,
            hint: c.hint,
            createdAt: c.createdAt,
            lastUsedAt: c.lastUsedAt,
            integration: c.integration,
          })),
          MODULE_ID,
        )
        .catch((err) => console.error("[environment-variables] Client export to AI Ecosystem failed:", err));
    }

    this.disposeToolRunner?.();
    const runnerDisposer = api.registerService<IndexedToolRunner>(TOOL_RUNNER_SERVICE, MODULE_ID, this.toolRunner);
    this.disposeToolRunner =
      typeof runnerDisposer === "function"
        ? runnerDisposer
        : () => {
            try {
              api.unregisterService(TOOL_RUNNER_SERVICE, MODULE_ID);
            } catch {
              // Ignore
            }
          };

    this.disposeServiceListener?.();
    this.disposeServiceListener = api.onServiceChange((serviceName, available) => {
      if (available) {
        void this.adoption.inspectService(api, serviceName);
        if (serviceName === HOOKS_SERVICE) this.connectHooks(api);
      }
    });
    this.connectHooks(api);
    this.connectMcpPackages(api);

    if (this.store.isUnlocked) {
      void this.adoption.scanAll(api, listEcosystemServiceNames(this.app));
    }

    void this.tools.ready().then(() => {
      this.syncEcosystemTools();
      this.emitServerChange();
    });
    this.emitServerChange();
  }

  private handleEcosystemDisconnected(): void {
    this.disposeSetupHandler?.();
    this.disposeSetupHandler = undefined;
    this.disposeServiceListener?.();
    this.disposeServiceListener = undefined;
    this.disposeSecretService?.();
    this.disposeSecretService = undefined;
    this.disposeToolRunner?.();
    this.disposeToolRunner = undefined;
    this.emitServerChange();
  }

  private async handleEcosystemMissing(): Promise<void> {
    if (this.isEcosystemConnected) return;
    if (this.data.settings.serverEnabled && !this.server?.running) {
      await this.startTransitionServer();
    }
    if (!this.transitionNoticeShown) {
      this.transitionNoticeShown = true;
      const frag = createFragment();
      frag.createDiv({ text: t("view.transition.body") });
      const btn = frag.createEl("button", { text: t("view.transition.install"), cls: "mod-cta ev-notice-button" });
      const notice = new Notice(frag, 15_000);
      btn.addEventListener("click", () => {
        notice.hide();
        void this.installAiEcosystem();
      });
    }
    this.emitServerChange();
  }

  private async startTransitionServer(): Promise<void> {
    if (this.isEcosystemConnected) return;
    await this.startServer();
  }

  async setServerEnabled(enabled: boolean): Promise<void> {
    this.data.settings.serverEnabled = enabled;
    await this.saveAll();
    if (this.isEcosystemConnected) {
      this.emitServerChange();
      return;
    }
    if (enabled) await this.startServer();
    else await this.stopServer();
  }

  async restartServer(): Promise<void> {
    if (this.isEcosystemConnected) return;
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
      guide: (request, topic) => this.agentGuide(request, topic),
      vault: { id: this.vaultId, name: this.vaultName },
      responseWriter: this.app.vault.adapter,
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
   * Starts this vault's transition server when AI Ecosystem is not active.
   */
  private async startServer(): Promise<void> {
    if (this.isEcosystemConnected || this.server?.running) return;
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

  // ---------- AI Ecosystem hooks ----------

  /** Registers the set-up handler and feeds the hooks service. Does nothing when the core has no such service. */
  private connectHooks(api: AIEcosystemAPI): void {
    const hooks = this.hooksService(api);
    if (!hooks) return;
    this.hooksPusher.reset();
    this.disposeSetupHandler?.();
    this.disposeSetupHandler = undefined;
    if (typeof hooks.registerSetupHandler === "function") {
      this.disposeSetupHandler = hooks.registerSetupHandler(
        MODULE_ID,
        createSetupHandler({
          isUnlocked: () => this.store.isUnlocked,
          counts: () => (this.store.isUnlocked ? { secrets: this.store.list().length, values: this.store.listValues().length } : null),
          indexedCounts: () => {
            const values = this.data.nameIndex.filter((e) => e.type === "value").length;
            return { secrets: this.data.nameIndex.length - values, values };
          },
          toolNotesFolder: () => this.toolNoteFolderList()[0] ?? "",
          folderExists: (path) => this.app.vault.getAbstractFileByPath(path) instanceof TFolder,
          setToolNotesFolder: (path) => this.setToolNotesFolder(path),
          knownHosts: () => this.currentHosts(),
          setServiceHosts: async (hosts) => {
            this.data.serviceHosts = hosts;
            await this.saveAll();
          },
        }),
      );
    }
    this.syncHooksData();
  }

  private hooksService(api: AIEcosystemAPI | undefined): HooksService | undefined {
    try {
      return api?.getService<HooksService>(HOOKS_SERVICE);
    } catch {
      return undefined;
    }
  }

  /** Hosts of the secrets that have a host list, plus those of the values. From the name index of hosts while locked. */
  private currentHosts(): string[] {
    return this.store.isUnlocked ? hooksHosts(this.store.list(), this.store.listValues()) : this.data.hostIndex;
  }

  private toolNoteFolderList(): string[] {
    return toolNoteFolders(
      this.data.settings.toolNotesFolder,
      this.registry.list().map((e) => e.notePath),
    );
  }

  /**
   * Sends the hooks service the hosts and the tool note folders. Never names or values.
   * Runs when secrets, values or tool notes change; a push identical to the last one is skipped.
   */
  syncHooksData(): void {
    const hosts = this.currentHosts();
    if (this.store.isUnlocked && JSON.stringify(hosts) !== JSON.stringify(this.data.hostIndex)) {
      this.data.hostIndex = hosts;
      this.scheduleSave();
    }
    const service = this.hooksService(this.connector?.api);
    this.hooksPusher.push(service, MODULE_ID, { hosts, toolNoteFolders: this.toolNoteFolderList() });
  }

  /** The folder of the tool notes, as chosen in the settings or by the guided set-up. */
  async setToolNotesFolder(path: string): Promise<void> {
    this.data.settings.toolNotesFolder = path;
    await this.saveAll();
    this.syncHooksData();
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
    if (this.server?.running || this.isEcosystemConnected) await this.reconnectIntegrations();
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
      this.syncEcosystemTools();
      this.emitServerChange();
    });
  }

  /** Runs the registry check for a note event and schedules an update only when the note matters. */
  private onNoteEvent(isRelevant: () => boolean): void {
    if (!this.data.settings.toolsEnabled) return;
    if (isRelevant()) this.scheduleToolScan();
  }

  /** Applies the pending tool note changes shortly after the last one. Requests from the AI also apply them first: see ToolsService.ready(). */
  private scheduleToolScan(): void {
    if (!this.data.settings.toolsEnabled) return;
    if (this.toolScanTimer !== undefined) window.clearTimeout(this.toolScanTimer);
    this.toolScanTimer = window.setTimeout(() => {
      this.toolScanTimer = undefined;
      void this.registry.ensureFresh().then(() => this.syncEcosystemTools());
    }, 300);
  }

  // ---------- MCP groups ----------

  /** Every MCP group with its tool count and request count, computed fresh from the registry and the audit log. */
  private cachedGroupStats: McpGroupStats[] | null = null;
  private cachedStatsVersions = { registry: -1, audit: -1, groupsSig: "" };

  mcpGroupStats(): McpGroupStats[] {
    const groupsSig = JSON.stringify(this.data.mcpGroups);
    if (
      this.cachedGroupStats &&
      this.cachedStatsVersions.registry === this.registry.version &&
      this.cachedStatsVersions.audit === this.audit.version &&
      this.cachedStatsVersions.groupsSig === groupsSig
    ) {
      return this.cachedGroupStats;
    }

    const entries = this.registry.list();
    const audit = this.audit.list();
    this.cachedGroupStats = this.data.mcpGroups.map((g) => computeMcpGroupStats(g, entries, this.toolSource, audit));
    this.cachedStatsVersions = {
      registry: this.registry.version,
      audit: this.audit.version,
      groupsSig,
    };
    return this.cachedGroupStats;
  }

  resolveLogo(ref: string | undefined): string {
    if (!ref) return "";
    return this.data.logos?.[ref] ?? ref;
  }

  storeLogo(dataUri: string): string {
    if (!dataUri) return "";
    if (this.data.logos && Object.prototype.hasOwnProperty.call(this.data.logos, dataUri)) return dataUri;
    const key = hashLogo(dataUri);
    this.data.logos ??= {};
    this.data.logos[key] = dataUri;
    return key;
  }

  async addMcpGroup(group: McpGroupConfig): Promise<void> {
    group.logo = this.storeLogo(group.logo);
    this.data.mcpGroups.push(group);
    await this.saveAll();
    this.emitServerChange();
  }

  async updateMcpGroup(group: McpGroupConfig): Promise<void> {
    const i = this.data.mcpGroups.findIndex((g) => g.id === group.id);
    if (i === -1) return;
    group.logo = this.storeLogo(group.logo);
    this.data.mcpGroups[i] = group;
    await this.saveAll();
    this.emitServerChange();
  }

  /** Removes the grouping, and — when asked — trashes the notes it currently matches. */
  async removeMcpGroup(id: string, deleteNotes = false): Promise<void> {
    const group = this.data.mcpGroups.find((g) => g.id === id);
    if (deleteNotes && group) {
      for (const path of matchedNotePaths(group, this.toolSource)) {
        const file = this.app.vault.getAbstractFileByPath(path);
        if (file) await this.app.fileManager.trashFile(file);
      }
    }
    this.data.mcpGroups = this.data.mcpGroups.filter((g) => g.id !== id);
    await this.saveAll();
    this.emitServerChange();
  }

  async setMcpGroupEnabled(id: string, enabled: boolean): Promise<void> {
    const group = this.data.mcpGroups.find((g) => g.id === id);
    if (!group) return;
    group.enabled = enabled;
    await this.saveAll();
    this.emitServerChange();
  }

  async addMcpApp(app: McpAppConfig): Promise<void> {
    app.logo = this.storeLogo(app.logo);
    this.data.mcpApps.push(app);
    await this.saveAll();
    this.emitServerChange();
  }

  async updateMcpApp(app: McpAppConfig): Promise<void> {
    const i = this.data.mcpApps.findIndex((a) => a.id === app.id);
    if (i === -1) return;
    app.logo = this.storeLogo(app.logo);
    this.data.mcpApps[i] = app;
    await this.saveAll();
    this.emitServerChange();
  }

  /** Removes the app card. Its MCPs are kept, just no longer grouped under it. */
  async removeMcpApp(id: string): Promise<void> {
    this.data.mcpApps = this.data.mcpApps.filter((a) => a.id !== id);
    for (const g of this.data.mcpGroups) if (g.appId === id) g.appId = undefined;
    await this.saveAll();
    this.emitServerChange();
  }

  async setMcpAppEnabled(id: string, enabled: boolean): Promise<void> {
    const app = this.data.mcpApps.find((a) => a.id === id);
    if (!app) return;
    app.enabled = enabled;
    await this.saveAll();
    this.emitServerChange();
  }

  // ---------- MCP packages installed through AI Ecosystem: groups and instance templates ----------

  /**
   * Creates the bundled instance templates the vault does not have yet, once each, in the
   * "Instances" folder (see instancesFolder). A template the user deleted is not created again.
   */
  private async createServiceTemplates(): Promise<void> {
    const pending = templatesToCreate(this.data.createdTemplates, (tag) => this.toolSource.byTag(tag));
    if (pending.length === 0) return;
    try {
      const folder = await this.instancesFolder();
      const lang = currentLanguage() === "pt-BR" ? "pt" : "en";
      for (const template of pending) {
        const target = normalizePath(`${folder}/${template.fileName}`);
        if (!this.app.vault.getAbstractFileByPath(target)) await this.app.vault.create(target, templateText(template, lang));
        this.data.createdTemplates.push(template.id);
      }
      await this.saveAll();
    } catch (err) {
      console.error("Environment Keys: could not create the instance templates", err);
    }
  }

  /**
   * The "Instances" folder next to the "MCP Tools" note when the vault has one (earlier downloads
   * created it), else at the vault root. The note itself is no longer created. Created if missing.
   */
  private async instancesFolder(): Promise<string> {
    const hub = this.app.vault.getMarkdownFiles().find((f) => f.basename === MCP_HUB_NOTE_NAME);
    const hubFolder = hub?.parent?.path ?? "";
    const folder = normalizePath(hubFolder ? `${hubFolder}/Instances` : "Instances");
    if (!this.app.vault.getAbstractFileByPath(folder)) await this.app.vault.createFolder(folder);
    return folder;
  }

  /**
   * Finds the app card a package belongs to (by name), creating it the first time a package
   * of that app is installed. Returns undefined when the package isn't tied to any app.
   */
  private ensureMcpAppForPackage(entry: Pick<McpCatalogEntry, "id" | "name" | "tag" | "logo" | "serviceTag">): string | undefined {
    const info = appForEntry(entry);
    if (!info) return undefined;
    const existing = this.data.mcpApps.find((a) => a.name.trim().toLowerCase() === info.name.toLowerCase());
    if (existing) return existing.id;
    const app: McpAppConfig = { id: randomGroupId(), name: info.name, logo: this.storeLogo(defaultLogoFor(info.logo)), enabled: true };
    this.data.mcpApps.push(app);
    return app.id;
  }

  /** Registers the package as an MCP group the first time it is seen; later calls only fill in a missing app. */
  private upsertMcpGroupForPackage(entry: Pick<McpCatalogEntry, "id" | "name" | "tag" | "logo" | "serviceTag">): void {
    const appId = this.ensureMcpAppForPackage(entry);
    const existing = this.data.mcpGroups.find((g) => g.sourcePackageId === entry.id);
    if (existing) {
      if (!existing.appId && appId) existing.appId = appId;
      return;
    }
    this.data.mcpGroups.push({
      id: randomGroupId(),
      name: entry.name,
      logo: this.storeLogo(defaultLogoFor(entry.logo)),
      enabled: true,
      tag: entry.tag,
      links: [],
      appId,
      sourcePackageId: entry.id,
    });
  }

  /**
   * Keeps the MCP groups in step with the packages AI Ecosystem has installed: a group for each new
   * package, and no group for a package that is gone. Then reloads the .db files and the tools.
   */
  private async syncInstalledMcpPackages(service: McpPackagesService): Promise<void> {
    let installed: InstalledMcpPackage[];
    try {
      installed = service.list();
    } catch (err) {
      // No list, no removal: the groups stay as they are.
      console.error("[environment-variables] Could not read the installed MCP packages:", err);
      return;
    }
    const plan = planGroupSync(installed, this.data.mcpGroups);
    let changed = false;
    for (const pkg of plan.toAdd) {
      this.upsertMcpGroupForPackage(pkg);
      changed = true;
    }
    if (plan.toRemoveGroupIds.length > 0) {
      this.data.mcpGroups = this.data.mcpGroups.filter((g) => !plan.toRemoveGroupIds.includes(g.id));
      changed = true;
    }
    if (changed) {
      await this.createServiceTemplates();
      await this.saveAll();
    }
    // Always: the .db files on disk may have changed even when no group did (same reload as the vault events).
    this.mcpDb.refresh();
    await this.registry.refresh();
    this.emitServerChange();
    this.syncEcosystemTools();
  }

  /** The `mcp-packages` service, or undefined on an AI Ecosystem core that does not have it. */
  private mcpPackagesService(api: AIEcosystemAPI): McpPackagesService | undefined {
    try {
      return api.getService<McpPackagesService>(MCP_PACKAGES_SERVICE);
    } catch {
      return undefined;
    }
  }

  /** Syncs now, and again on every change of the installed packages. */
  private watchMcpPackages(service: McpPackagesService): void {
    void this.syncInstalledMcpPackages(service);
    this.mcpPackagesUnsub = service.onChange(() => void this.syncInstalledMcpPackages(service));
  }

  /** Follows `mcp-packages` for as long as the connection lasts. Does nothing when the service is missing. */
  private connectMcpPackages(api: AIEcosystemAPI): void {
    this.mcpPackagesUnsub?.();
    this.mcpPackagesUnsub = undefined;
    const service = this.mcpPackagesService(api);
    if (service) this.watchMcpPackages(service);

    this.disposeMcpPackagesWatch?.();
    this.disposeMcpPackagesWatch = api.onServiceChange((name, available) => {
      if (name !== MCP_PACKAGES_SERVICE || !available) return;
      this.mcpPackagesUnsub?.();
      this.mcpPackagesUnsub = undefined;
      const late = this.mcpPackagesService(api);
      if (late) this.watchMcpPackages(late);
    });
  }

  /** The prompt for AI agents, in the language of Obsidian. Generic: it names nothing of this vault. */
  agentGuide(request?: string, topic?: string): string {
    const lang = currentLanguage() === "pt-BR" ? "pt" : "en";
    if (topic) {
      return guideTopic(lang, topic);
    }
    if (request) {
      return buildGuide(lang, request);
    }
    return guideIndex(lang);
  }

  copyAgentGuide(): void {
    void navigator.clipboard.writeText(buildGuide(currentLanguage() === "pt-BR" ? "pt" : "en"));
    new Notice(t("notice.guideCopied"), 8_000);
  }

  // ---------- clients ----------

  get serverUrl(): string {
    const port = this.isEcosystemConnected ? this.ecosystemPort : this.data.settings.port;
    return `http://127.0.0.1:${port}/mcp`;
  }

  async addClient(name: string, access: ClientAccess): Promise<string> {
    const { record, token } = await createClient(name, access);
    this.data.clients.push(record);
    await this.saveAll();
    if (this.connector?.api) {
      await this.connector.api
        .importClients(
          [
            {
              id: record.id,
              name: record.name,
              tokenHash: record.tokenHash,
              hint: record.hint,
              createdAt: record.createdAt,
              lastUsedAt: record.lastUsedAt,
            },
          ],
          MODULE_ID,
        )
        .catch(() => undefined);
    }
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
   * One click: creates a token, imports it into AI Ecosystem (or starts the transition server) and registers it in the AI client.
   * The token never appears on screen. Returns false (after a notice) on failure.
   */
  async connectIntegration(id: IntegrationId, access?: ClientAccess, quiet = false): Promise<boolean> {
    const integration = integrationById(id);
    if (!integration) return false;
    if (!this.isEcosystemConnected && (!this.data.settings.serverEnabled || !this.server?.running)) {
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
    if (this.connector?.api) {
      await this.connector.api
        .importClients(
          [
            {
              id: record.id,
              name: record.name,
              tokenHash: record.tokenHash,
              hint: record.hint,
              createdAt: record.createdAt,
              lastUsedAt: record.lastUsedAt,
            },
          ],
          MODULE_ID,
        )
        .catch(() => undefined);
    }
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
