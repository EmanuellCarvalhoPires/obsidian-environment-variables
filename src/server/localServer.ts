import * as http from "http";
import { clearInterval, setInterval } from "timers";
import { Broker } from "../engine/broker";
import { GuideMode, isGuideMode } from "../tools/guide";
import type { ToolsService } from "../tools/service";
import { ClientContext } from "./clients";
import { handleMcpMessage } from "./mcp";

export const LISTEN_HOST = "127.0.0.1";
const MAX_REQUEST_BYTES = 5 * 1024 * 1024;
/** Comment lines keep idle notification streams open through proxies and client timeouts. */
const STREAM_HEARTBEAT_MS = 25_000;
const TOOLS_CHANGED = JSON.stringify({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });

export interface LocalServerOptions {
  port: number;
  broker: Broker;
  version: string;
  /** Returns the client (name and access list) for a valid token, or null. */
  authenticate: (token: string) => Promise<ClientContext | null>;
  /** Vault tools. Optional so the server also works (and is tested) without them. */
  tools?: ToolsService;
  /** The AI agent guide for the chosen prompt, with an optional user request appended. */
  guide?: (request?: string, mode?: GuideMode) => string;
  /** Which vault this server belongs to, so another vault can tell whose server holds a port. */
  vault?: { id: string; name: string };
}

/** The port is taken, by another vault's server or by another program. */
export class PortInUseError extends Error {
  constructor(public readonly port: number) {
    super(`Port ${port} is already in use.`);
    this.name = "PortInUseError";
  }
}

export interface PortOwner {
  /** True when the port answers like this plugin (any version). */
  isPlugin: boolean;
  vaultId?: string;
  vaultName?: string;
}

/** Asks whoever listens on the port who they are, via the public /v1/health endpoint. */
export function probePort(port: number, timeoutMs = 1500): Promise<PortOwner | null> {
  return new Promise((resolve) => {
    // agent: false, so no keep-alive connection to another vault's server stays open.
    const req = http.get({ host: LISTEN_HOST, port, path: "/v1/health", timeout: timeoutMs, agent: false }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => (body = (body + chunk).slice(0, 10_000)));
      res.on("end", () => {
        try {
          const json = JSON.parse(body) as { name?: unknown; vault?: { id?: unknown; name?: unknown } };
          resolve({
            isPlugin: json.name === "environment-variables",
            vaultId: typeof json.vault?.id === "string" ? json.vault.id : undefined,
            vaultName: typeof json.vault?.name === "string" ? json.vault.name : undefined,
          });
        } catch {
          resolve({ isPlugin: false });
        }
      });
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(null));
  });
}

export class LocalServer {
  private server: http.Server | null = null;
  /** Open GET /mcp streams: they only receive notifications/tools/list_changed. */
  private streams = new Set<http.ServerResponse>();
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private unsubscribe: (() => void) | null = null;

  constructor(private readonly options: LocalServerOptions) {}

  get running(): boolean {
    return this.server?.listening ?? false;
  }

  get port(): number {
    return this.options.port;
  }

  start(): Promise<void> {
    if (this.server) return Promise.resolve();
    const server = http.createServer((req, res) => {
      this.handle(req, res).catch(() => sendJson(res, 500, { ok: false, error: { code: "internal_error", message: "Internal error." } }));
    });
    this.server = server;
    return new Promise((resolve, reject) => {
      server.once("error", (err: NodeJS.ErrnoException) => {
        this.server = null;
        reject(err.code === "EADDRINUSE" ? new PortInUseError(this.options.port) : err);
      });
      server.listen(this.options.port, LISTEN_HOST, () => {
        this.unsubscribe = this.options.tools?.onChange(() => this.notifyToolsChanged()) ?? null;
        resolve();
      });
    });
  }

  /** Tells every connected client to reload the tool list. */
  notifyToolsChanged(): void {
    for (const res of this.streams) res.write(`event: message\ndata: ${TOOLS_CHANGED}\n\n`);
  }

  stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    for (const res of this.streams) res.end();
    this.streams.clear();
    if (!server) return Promise.resolve();
    return new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    // DNS rebinding protection: only accept our own host names.
    const host = (req.headers.host ?? "").toLowerCase();
    const allowedHosts = [`127.0.0.1:${this.options.port}`, `localhost:${this.options.port}`];
    if (!allowedHosts.includes(host)) return sendJson(res, 421, error("bad_host", "Invalid Host header."));
    // Browsers always send Origin on cross-site requests; AI clients and scripts do not.
    if (req.headers.origin) return sendJson(res, 403, error("forbidden_origin", "Browser requests are not allowed."));

    const url = new URL(req.url ?? "/", `http://${host}`);
    if (url.pathname === "/v1/health" && req.method === "GET") {
      // No secrets and no client data: only which plugin and which vault own this port.
      return sendJson(res, 200, { ok: true, name: "environment-variables", version: this.options.version, vault: this.options.vault });
    }

    const client = await this.authenticate(req);
    if (!client) {
      res.setHeader("WWW-Authenticate", 'Bearer realm="environment-variables"');
      return sendJson(res, 401, error("unauthorized", "Missing or invalid client token. Create one in Obsidian: Environment Variables > AI clients."));
    }

    const broker = this.options.broker;
    if (url.pathname === "/v1/secrets" && req.method === "GET") {
      const result = broker.listSecrets(client);
      return sendJson(res, result.ok ? 200 : 423, result);
    }
    if (url.pathname === "/v1/request" && req.method === "POST") {
      const body = await readJson(req);
      if (body === undefined) return sendJson(res, 400, error("invalid_request", "Body must be JSON."));
      const result = await broker.execute(body as never, client);
      return sendJson(res, result.ok ? 200 : statusFor(result.error.code), result);
    }
    const tools = this.options.tools;
    if (url.pathname === "/v1/tools" && req.method === "GET") {
      if (!tools?.enabled()) return sendJson(res, 404, error("tools_disabled", "Vault tools are turned off in the plugin settings."));
      return sendJson(res, 200, { ok: true, ...tools.status() });
    }
    if (url.pathname === "/v1/tools/guide" && req.method === "GET") {
      if (!tools?.enabled() || !this.options.guide) return sendJson(res, 404, error("tools_disabled", "Vault tools are turned off in the plugin settings."));
      res.writeHead(200, { "Content-Type": "text/markdown; charset=utf-8", "Cache-Control": "no-store" });
      const mode = url.searchParams.get("mode");
      res.end(this.options.guide(url.searchParams.get("request") ?? undefined, isGuideMode(mode) ? mode : undefined));
      return;
    }
    const run = /^\/v1\/tools\/([a-z][a-z0-9_]{0,63})$/.exec(url.pathname);
    if (run && req.method === "POST") {
      if (!tools?.enabled()) return sendJson(res, 404, error("tools_disabled", "Vault tools are turned off in the plugin settings."));
      const args = await readJson(req);
      if (args === undefined) return sendJson(res, 400, error("invalid_request", "Body must be a JSON object with the tool arguments."));
      const out = await tools.callMcp("run_vault_tool", { name: run[1], arguments: args }, client);
      return sendJson(res, out.isError ? 400 : 200, out.isError ? out.value : { ok: true, result: out.value });
    }
    if (url.pathname === "/mcp") {
      if (req.method === "GET") {
        const accepts = String(req.headers.accept ?? "").includes("text/event-stream");
        if (!accepts || !tools?.enabled()) {
          return sendJson(res, 405, error("method_not_allowed", "Only POST, or GET with Accept: text/event-stream while vault tools are on."), { Allow: "POST" });
        }
        return this.openStream(res);
      }
      if (req.method === "DELETE") return sendJson(res, 200, { ok: true });
      if (req.method !== "POST") return sendJson(res, 405, error("method_not_allowed", "Use POST."), { Allow: "POST" });
      const message = await readJson(req);
      if (message === undefined) return sendJson(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      const response = await handleMcpMessage(message, { broker, client, version: this.options.version, tools, guide: this.options.guide });
      if (response === null) {
        res.writeHead(202);
        res.end();
        return;
      }
      return sendJson(res, 200, response);
    }
    return sendJson(res, 404, error("not_found", "Unknown endpoint."));
  }

  /** Server-to-client stream of the Streamable HTTP transport. Only list_changed goes through it. */
  private openStream(res: http.ServerResponse): void {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
    res.write(": connected\n\n");
    this.streams.add(res);
    res.on("close", () => this.streams.delete(res));
    if (!this.heartbeat) {
      this.heartbeat = setInterval(() => {
        for (const r of this.streams) r.write(": ping\n\n");
      }, STREAM_HEARTBEAT_MS);
    }
  }

  private async authenticate(req: http.IncomingMessage): Promise<ClientContext | null> {
    const header = req.headers.authorization ?? "";
    const match = /^Bearer\s+(\S+)$/i.exec(header);
    if (!match) return null;
    return this.options.authenticate(match[1]);
  }
}

function statusFor(code: string): number {
  switch (code) {
    case "locked":
      return 423;
    case "denied":
    case "secret_not_permitted":
    case "host_not_allowed":
    case "insecure_scheme":
    case "placement_not_allowed":
      return 403;
    case "unknown_secret":
    case "invalid_request":
    case "invalid_placeholder":
      return 400;
    case "upstream_error":
      return 502;
    default:
      return 400;
  }
}

function error(code: string, message: string) {
  return { ok: false, error: { code, message } };
}

function sendJson(res: http.ServerResponse, status: number, value: unknown, extra: Record<string, string> = {}): void {
  if (res.headersSent) return;
  const body = JSON.stringify(value);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...extra });
  res.end(body);
}

function readJson(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_REQUEST_BYTES) {
        req.destroy();
        reject(new Error("Request too large."));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        resolve(undefined);
      }
    });
    req.on("error", reject);
  });
}
