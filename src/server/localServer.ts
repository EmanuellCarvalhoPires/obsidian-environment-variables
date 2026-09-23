import * as http from "http";
import { Broker } from "../engine/broker";
import { ClientContext } from "./clients";
import { handleMcpMessage } from "./mcp";

export const LISTEN_HOST = "127.0.0.1";
const MAX_REQUEST_BYTES = 5 * 1024 * 1024;

export interface LocalServerOptions {
  port: number;
  broker: Broker;
  version: string;
  /** Returns the client (name and access list) for a valid token, or null. */
  authenticate: (token: string) => Promise<ClientContext | null>;
}

export class LocalServer {
  private server: http.Server | null = null;

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
        reject(err.code === "EADDRINUSE" ? new Error(`Port ${this.options.port} is already in use.`) : err);
      });
      server.listen(this.options.port, LISTEN_HOST, () => resolve());
    });
  }

  stop(): Promise<void> {
    const server = this.server;
    this.server = null;
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
      return sendJson(res, 200, { ok: true, name: "environment-variables", version: this.options.version });
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
    if (url.pathname === "/mcp") {
      if (req.method === "GET") return sendJson(res, 405, error("method_not_allowed", "SSE streams are not supported."), { Allow: "POST" });
      if (req.method === "DELETE") return sendJson(res, 200, { ok: true });
      if (req.method !== "POST") return sendJson(res, 405, error("method_not_allowed", "Use POST."), { Allow: "POST" });
      const message = await readJson(req);
      if (message === undefined) return sendJson(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      const response = await handleMcpMessage(message, { broker, client, version: this.options.version });
      if (response === null) {
        res.writeHead(202);
        res.end();
        return;
      }
      return sendJson(res, 200, response);
    }
    return sendJson(res, 404, error("not_found", "Unknown endpoint."));
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
