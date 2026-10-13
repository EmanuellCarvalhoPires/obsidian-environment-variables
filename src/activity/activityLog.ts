import type { Key } from "../i18n";

/**
 * Live activity of the AI clients: every tool call becomes a session, and a session is a list of
 * terminal lines ("request received", "substituting {{basic:NAME}}", "response 200"...).
 *
 * Kept in memory only (it holds request and response bodies) and never holds a secret value:
 * lines carry the placeholder as the AI wrote it, and everything goes through the scrubber.
 */

/** Lines are written as i18n keys, so the panel shows them in the user's language. */
export type ActivityKey = Extract<Key, `act.line.${string}`>;
export type ActivityLevel = "info" | "step" | "ok" | "warn" | "error";
export type ActivityStatus = "running" | "ok" | "error" | "denied" | "blocked" | "locked";
export type ActivityParams = Record<string, string | number>;

export interface ActivityLine {
  time: number;
  level: ActivityLevel;
  key: ActivityKey;
  params?: ActivityParams;
  /** A block under the line: headers, body, result. Already masked. */
  data?: string;
  /** Characters cut from `data` to keep the session small. */
  omitted?: number;
}

export interface ActivitySession {
  id: string;
  startedAt: number;
  endedAt?: number;
  client: string;
  /** "mcp": a tools/call from an MCP client. "rest": the plugin's REST endpoints. */
  source: "mcp" | "rest";
  /** The tool the AI used: http_request, list_secrets or a vault tool name. */
  tool: string;
  /** Set when the tool was reached through another one, e.g. run_vault_tool. */
  via?: string;
  /** The latest request of the session, with the target as logged (no query string). */
  method?: string;
  target?: string;
  /** How many HTTP requests the session sent (a vault tool may send several). */
  requests: number;
  /** Names of the variables used. Never values. */
  secrets: string[];
  status: ActivityStatus;
  httpStatus?: number;
  lines: ActivityLine[];
  /** Lines dropped because the session hit MAX_LINES. */
  droppedLines: number;
}

export type ActivityEvent =
  | { type: "begin"; session: ActivitySession }
  | { type: "line"; session: ActivitySession; line: ActivityLine }
  | { type: "update"; session: ActivitySession }
  | { type: "end"; session: ActivitySession }
  | { type: "remove"; ids: string[] };

export const MAX_ACTIVITY_SESSIONS = 200;
export const MAX_SESSION_LINES = 400;
export const MAX_DATA_CHARS = 16_000;

export class ActivityTrace {
  constructor(
    readonly session: ActivitySession,
    private readonly log: ActivityLog,
  ) {}

  get ended(): boolean {
    return this.session.status !== "running";
  }

  line(level: ActivityLevel, key: ActivityKey, params?: ActivityParams, data?: string): void {
    this.log.addLine(this.session, level, key, params, data);
  }

  /** A new HTTP request starts in this session. Returns its number (1, 2, ...). */
  request(method: string, target: string): number {
    return this.log.touch(this.session, (s) => {
      s.requests += 1;
      s.method = method;
      s.target = target;
    }).requests;
  }

  /** Marks variables as used by the session. Names only. */
  useSecrets(names: string[]): void {
    this.log.touch(this.session, (s) => {
      for (const n of names) if (!s.secrets.includes(n)) s.secrets.push(n);
    });
  }

  /** The tool the AI really ran, when it was reached through another one (run_vault_tool). */
  setTool(name: string, via?: string): void {
    this.log.touch(this.session, (s) => {
      s.tool = name;
      s.via = via;
    });
  }

  /** Closes the session. Only the first call counts, so a precise caller wins over a fallback. */
  end(status: Exclude<ActivityStatus, "running">, httpStatus?: number): void {
    this.log.finish(this.session, status, httpStatus);
  }
}

export class ActivityLog {
  /** Oldest first. */
  private sessions: ActivitySession[] = [];
  private listeners = new Set<(event: ActivityEvent) => void>();
  private scrubber: (text: string) => string = (text) => text;
  private counter = 0;

  /** Everything written to a line goes through this first: the broker plugs in its redactor. */
  setScrubber(scrubber: (text: string) => string): void {
    this.scrubber = scrubber;
  }

  begin(init: { client: string; tool: string; source: "mcp" | "rest" }): ActivityTrace {
    const session: ActivitySession = {
      id: `${Date.now().toString(36)}-${(this.counter++).toString(36)}`,
      startedAt: Date.now(),
      client: init.client,
      source: init.source,
      tool: init.tool,
      requests: 0,
      secrets: [],
      status: "running",
      lines: [],
      droppedLines: 0,
    };
    this.sessions.push(session);
    this.emit({ type: "begin", session });
    this.prune();
    return new ActivityTrace(session, this);
  }

  /** Newest first. */
  list(): ActivitySession[] {
    return [...this.sessions].reverse();
  }

  /** Removes the finished sessions. Sessions still running stay. */
  clear(): void {
    const gone = this.sessions.filter((s) => s.status !== "running").map((s) => s.id);
    if (gone.length === 0) return;
    this.sessions = this.sessions.filter((s) => s.status === "running");
    this.emit({ type: "remove", ids: gone });
  }

  onEvent(listener: (event: ActivityEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // Used by ActivityTrace.

  addLine(session: ActivitySession, level: ActivityLevel, key: ActivityKey, params?: ActivityParams, data?: string, force = false): void {
    if (!force && session.lines.length >= MAX_SESSION_LINES) {
      session.droppedLines += 1;
      return;
    }
    const line: ActivityLine = { time: Date.now(), level, key };
    if (params) {
      line.params = {};
      for (const [k, v] of Object.entries(params)) line.params[k] = typeof v === "string" ? this.scrubber(v) : v;
    }
    if (data !== undefined && data !== "") {
      const clean = this.scrubber(data);
      line.data = clean.length > MAX_DATA_CHARS ? clean.slice(0, MAX_DATA_CHARS) : clean;
      if (clean.length > MAX_DATA_CHARS) line.omitted = clean.length - MAX_DATA_CHARS;
    }
    session.lines.push(line);
    this.emit({ type: "line", session, line });
  }

  touch(session: ActivitySession, change: (s: ActivitySession) => void): ActivitySession {
    change(session);
    this.emit({ type: "update", session });
    return session;
  }

  finish(session: ActivitySession, status: Exclude<ActivityStatus, "running">, httpStatus?: number): void {
    if (session.status !== "running") return;
    session.status = status;
    session.endedAt = Date.now();
    if (httpStatus !== undefined) session.httpStatus = httpStatus;
    const ms = session.endedAt - session.startedAt;
    // The closing line is kept even when the session hit the line limit.
    this.addLine(session, status === "ok" ? "ok" : "error", status === "ok" ? "act.line.finishedOk" : "act.line.finishedFail", { ms }, undefined, true);
    this.emit({ type: "end", session });
  }

  private emit(event: ActivityEvent): void {
    for (const l of this.listeners) l(event);
  }

  /** Keeps the newest MAX_ACTIVITY_SESSIONS, dropping finished sessions first. */
  private prune(): void {
    const extra = this.sessions.length - MAX_ACTIVITY_SESSIONS;
    if (extra <= 0) return;
    const gone: string[] = [];
    for (const s of this.sessions) {
      if (gone.length >= extra) break;
      if (s.status !== "running") gone.push(s.id);
    }
    if (gone.length === 0) return;
    this.sessions = this.sessions.filter((s) => !gone.includes(s.id));
    this.emit({ type: "remove", ids: gone });
  }
}
