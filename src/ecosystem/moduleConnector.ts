import { App, Events, EventRef } from "obsidian";

export const ECOSYSTEM_PLUGIN_ID = "ai-ecosystem";
export const SUPPORTED_API_VERSION = 1;
export const MODULE_ID = "environment-variables";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface EcosystemClientContext {
  id: string;
  name: string;
}

export interface EcosystemClientRecord {
  id: string;
  name: string;
  tokenHash: string;
  hint: string;
  createdAt: string;
  lastUsedAt?: string;
  importedFrom?: string;
}

export interface HubRequest {
  method: HttpMethod;
  path: string;
  fullPath: string;
  params: Record<string, string>;
  query: Record<string, string>;
  headers: Record<string, string>;
  body: unknown;
  rawBody: string;
  client: EcosystemClientContext;
}

export interface HubResponse {
  status: number;
  headers?: Record<string, string>;
  body?: unknown;
}

export interface HubRoute {
  method: HttpMethod;
  path: string;
  description?: string;
  handler: (req: HubRequest) => Promise<HubResponse> | HubResponse;
}

/** Which kind of AI client made the call, as detected by AI Ecosystem. */
export type HubClientKind = "claude-code" | "antigravity" | "other";

export interface HubCallContext {
  client: EcosystemClientContext;
  moduleId: string;
  /** Aborted when the client cancels the call or closes the connection before the answer. Used by tools that open a screen. */
  signal?: AbortSignal;
  clientKind?: HubClientKind;
}

export interface HubToolContent {
  type: "text";
  text: string;
}

export interface HubToolResult {
  content: HubToolContent[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export interface HubToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export type ToolEffect = "leitura" | "cofre" | "externo";
export type ToolExposure = "fixa" | "indice";
export type ToolIndexKind = "tool" | "script" | "template" | "api";

/** What a module writes into its tools.db through `api.toolIndex.sync` (AI Ecosystem API 1.1). */
export interface ToolIndexEntry {
  name: string;
  title?: string;
  description: string;
  inputSchema?: Record<string, unknown>;
  annotations?: HubToolAnnotations;
  kind?: ToolIndexKind;
  categoria?: string;
  tags?: string[];
  resumo?: string;
  efeito?: ToolEffect;
  exposicao?: ToolExposure;
  aprovacao?: string;
  exemplo?: Record<string, unknown>;
}

export interface ToolIndexApi {
  sync(moduleId: string, entries: ToolIndexEntry[]): Promise<void>;
}

/**
 * Service `tool-runner:<module>`: runs index entries that are not registered MCP tools.
 * `tools_run` calls it when the id is in this module's tools.db but not in the live registry.
 */
export interface IndexedToolRunner {
  run(id: string, args: Record<string, unknown>, ctx: HubCallContext): Promise<HubToolResult>;
}

export const TOOL_RUNNER_SERVICE = `tool-runner:environment-variables`;

export interface HubTool {
  name: string;
  title?: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: HubToolAnnotations;
  /** Stays visible while the module still waits for its set-up skill (AI Ecosystem hides the other tools of such a module). */
  availableDuringSetup?: boolean;
  /** Index metadata (API 1.1). All optional. */
  categoria?: string;
  tags?: string[];
  /** One line, up to 100 characters. */
  resumo?: string;
  efeito?: ToolEffect;
  exposicao?: ToolExposure;
  /** Question template with {arg} placeholders, "obrigatoria" or "dispensada". */
  aprovacao?: string;
  exemplo?: Record<string, unknown>;
  handler: (args: Record<string, unknown>, ctx: HubCallContext) => Promise<HubToolResult> | HubToolResult;
}

export interface HubPromptArgument {
  name: string;
  description?: string;
  required?: boolean;
}

export interface HubPromptMessage {
  role: "user" | "assistant";
  content: { type: "text"; text: string };
}

export interface HubPromptResult {
  description?: string;
  messages: HubPromptMessage[];
}

export interface HubPrompt {
  name: string;
  title?: string;
  description?: string;
  arguments?: HubPromptArgument[];
  handler: (args: Record<string, string>, ctx: HubCallContext) => Promise<HubPromptResult> | HubPromptResult;
}

export interface ModuleRegistration {
  id: string;
  name: string;
  version: string;
  apiVersion: number;
  routes?: HubRoute[];
  legacyAliases?: HubRoute[];
  tools?: HubTool[];
  prompts?: HubPrompt[];
  instructions?: string;
}

export interface RegisterResult {
  ok: boolean;
  reason?: string;
  warnings?: string[];
}

export interface EcosystemActivityInput {
  kind: "http" | "mcp" | "cli" | "service";
  method: string;
  target: string;
  moduleId: string;
  client?: string;
  status: number;
  durationMs: number;
  requestHeaders?: Record<string, string>;
  payload?: unknown;
  response?: unknown;
}

export type ServiceChangeListener = (serviceName: string, available: boolean) => void;

export interface AIEcosystemAPI {
  readonly apiVersion: number;
  readonly version: string;
  /** API 1.1. Absent in older AI Ecosystem versions. */
  readonly toolIndex?: ToolIndexApi;
  registerModule(registration: ModuleRegistration): RegisterResult | (() => void);
  unregisterModule(moduleId: string): void;
  updateTools(moduleId: string, tools: HubTool[]): void;
  updatePrompts(moduleId: string, prompts: HubPrompt[]): void;
  registerService<T>(name: string, providerModuleId: string, implementation: T): void | (() => void);
  unregisterService(name: string, providerModuleId?: string): void;
  getService<T = unknown>(name: string): T | undefined;
  onServiceChange(listener: ServiceChangeListener): () => void;
  getServerStatus(): { running: boolean; port: number; usingAlternativePort: boolean };
  importClients(clients: EcosystemClientRecord[], sourceModuleId: string): Promise<{ added: number; total: number }>;
  logActivity(entry: EcosystemActivityInput): void;
}

// ---------- `hooks` service (owned by AI Ecosystem) ----------

export const HOOKS_SERVICE = "hooks";

export interface HookRuleData {
  /** environment-variables: allowed host patterns of secrets WITHOUT full access / any host. */
  hosts?: string[];
  /** ai-scripts: vault-relative folders whose scripts must run through the plugin. */
  scriptFolders?: string[];
  /** ai-templates: vault-relative target path patterns of the templates ({{...}} becomes *). */
  templateTargets?: string[];
  /** environment-variables: vault-relative folders of tool notes (Grep stays allowed there). */
  toolNoteFolders?: string[];
}

export interface SetupHandler {
  /** Facts the module detects by itself (never secret values). */
  detect?(): Promise<Record<string, unknown>>;
  /** Applies one answer. Returns an error message to refuse it. */
  save?(key: string, value: unknown): Promise<string | void>;
  /** Called by ecosystem_setup_complete. ok:false blocks completion and lists what is missing. */
  validate?(): Promise<{ ok: boolean; missing?: string[] }>;
}

export interface HooksService {
  setRuleData(moduleId: string, data: HookRuleData): void;
  /** Returns an unregister function. */
  registerSetupHandler(moduleId: string, handler: SetupHandler): () => void;
  getModuleState(moduleId: string): "pendente_configuracao" | "configurado" | "desativado" | undefined;
}

interface PluginsBag {
  getPlugin?: (id: string) => {
    api?: AIEcosystemAPI;
    listServices?: () => Array<{ name: string; providerModuleId: string }>;
    openInspectorView?: () => Promise<void>;
  } | undefined;
  enabledPlugins?: Set<string>;
  manifests?: Record<string, unknown>;
}

export function getEcosystemPlugin(app: App): ReturnType<NonNullable<PluginsBag["getPlugin"]>> {
  const plugins = (app as unknown as { plugins?: PluginsBag }).plugins;
  return plugins?.getPlugin?.(ECOSYSTEM_PLUGIN_ID);
}

export function getEcosystemApi(app: App): AIEcosystemAPI | undefined {
  const api = getEcosystemPlugin(app)?.api;
  return api && api.apiVersion === SUPPORTED_API_VERSION ? api : undefined;
}

export function isEcosystemEnabled(app: App): boolean {
  const plugins = (app as unknown as { plugins?: PluginsBag }).plugins;
  if (plugins?.enabledPlugins instanceof Set) {
    return plugins.enabledPlugins.has(ECOSYSTEM_PLUGIN_ID);
  }
  return Boolean(getEcosystemApi(app));
}

export function listEcosystemServiceNames(app: App): string[] {
  const plugin = getEcosystemPlugin(app);
  if (plugin && typeof plugin.listServices === "function") {
    try {
      return plugin.listServices().map((s) => s.name);
    } catch {
      return [];
    }
  }
  return [];
}

export interface EcosystemConnectorOptions {
  app: App;
  registration: ModuleRegistration | (() => ModuleRegistration);
  /** Runs right before `registerModule`, e.g. to stop a transition server and release port 27150. */
  onBeforeConnect?: (api: AIEcosystemAPI) => void | Promise<void>;
  onConnected?: (api: AIEcosystemAPI) => void;
  onDisconnected?: () => void;
  onMissing?: () => void;
  timeoutMs?: number;
}

export type ConnectorState = "waiting" | "connected" | "missing";

/**
 * Connects Environment Keys to AI Ecosystem regardless of plugin load order, and supports
 * automatic handoff from Transition Mode when `ai-ecosystem:ready` fires at any point.
 */
export class EcosystemConnector {
  private state: ConnectorState = "waiting";
  private currentApi: AIEcosystemAPI | undefined;
  private disposeModule: (() => void) | undefined;
  private readyRef: EventRef | undefined;
  private unloadRef: EventRef | undefined;
  private timer: number | undefined;
  private stopped = false;

  constructor(private readonly opts: EcosystemConnectorOptions) {}

  get api(): AIEcosystemAPI | undefined {
    return this.currentApi;
  }

  get status(): ConnectorState {
    return this.state;
  }

  start(): void {
    this.stopped = false;
    const existing = getEcosystemApi(this.opts.app);
    if (existing) {
      this.connect(existing);
    }

    const ws = this.opts.app.workspace as unknown as Events;
    this.readyRef = ws.on("ai-ecosystem:ready", (api: unknown) => {
      if (this.stopped) return;
      if (isCompatibleApi(api)) {
        this.connect(api);
      } else {
        const resolved = getEcosystemApi(this.opts.app);
        if (resolved) this.connect(resolved);
      }
    });
    this.unloadRef = ws.on("ai-ecosystem:unloading", () => {
      if (this.stopped) return;
      this.disconnect();
    });

    if (this.state !== "connected") {
      this.opts.app.workspace.onLayoutReady(() => {
        if (this.stopped || this.state === "connected") return;
        const api = getEcosystemApi(this.opts.app);
        if (api) {
          this.connect(api);
          return;
        }
        // If AI Ecosystem is not enabled in Obsidian, enter transition mode quickly;
        // if it is enabled and still loading, wait up to timeoutMs.
        const waitMs = isEcosystemEnabled(this.opts.app) ? (this.opts.timeoutMs ?? 5000) : Math.min(this.opts.timeoutMs ?? 250, 250);
        this.timer = window.setTimeout(() => {
          if (this.stopped || this.state !== "waiting") return;
          const late = getEcosystemApi(this.opts.app);
          if (late) {
            this.connect(late);
            return;
          }
          this.state = "missing";
          this.opts.onMissing?.();
        }, waitMs);
      });
    }
  }

  stop(): void {
    this.stopped = true;
    this.clearTimer();
    const ws = this.opts.app.workspace as unknown as Events;
    if (this.readyRef) ws.offref(this.readyRef);
    if (this.unloadRef) ws.offref(this.unloadRef);
    this.readyRef = undefined;
    this.unloadRef = undefined;
    this.disconnect();
  }

  /** Allows manual or test-driven connection to an `AIEcosystemAPI` instance. */
  connect(api: AIEcosystemAPI): void {
    this.clearTimer();
    if (this.state === "connected" && this.currentApi === api) return;
    if (this.state === "connected") {
      this.disconnect();
    }
    const finish = () => {
      if (this.stopped) return;
      const reg = typeof this.opts.registration === "function" ? this.opts.registration() : this.opts.registration;
      const res = api.registerModule(reg);
      if (res && typeof res === "object" && "ok" in res && !res.ok) {
        console.error(`[${reg.id}] Failed to register module with AI Ecosystem:`, res.reason);
        this.state = "missing";
        return;
      }
      this.disposeModule =
        typeof res === "function"
          ? res
          : () => {
              try {
                api.unregisterModule(reg.id);
              } catch {
                // Ignore if AI Ecosystem already unloaded.
              }
            };
      this.currentApi = api;
      this.state = "connected";
      this.opts.onConnected?.(api);
    };
    const before = this.opts.onBeforeConnect?.(api);
    if (before instanceof Promise) {
      void before.then(finish);
    } else {
      finish();
    }
  }

  private disconnect(): void {
    const wasConnected = this.state === "connected";
    try {
      this.disposeModule?.();
    } catch {
      // Ignore if AI Ecosystem already unloaded.
    }
    this.disposeModule = undefined;
    this.currentApi = undefined;
    if (wasConnected) {
      this.state = "waiting";
      this.opts.onDisconnected?.();
    }
  }

  private clearTimer(): void {
    if (this.timer !== undefined) {
      window.clearTimeout(this.timer);
      this.timer = undefined;
    }
  }
}

function isCompatibleApi(value: unknown): value is AIEcosystemAPI {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as AIEcosystemAPI).apiVersion === SUPPORTED_API_VERSION &&
    typeof (value as AIEcosystemAPI).registerModule === "function"
  );
}

// ---------- `mcp-packages` service (owned by AI Ecosystem) ----------

export const MCP_PACKAGES_SERVICE = "mcp-packages";

/** A downloaded MCP package, as AI Ecosystem lists it. */
export interface InstalledMcpPackage {
  id: string;
  name: string;
  app: string;
  tag: string;
  logo: string;
  serviceTag?: string;
  groupId?: string;
  toolCount: number;
  dbPath: string;
}

export interface McpPackagesService {
  list(): InstalledMcpPackage[];
  /** Returns an unsubscribe function. */
  onChange(listener: () => void): () => void;
}
