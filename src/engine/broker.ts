import { ActivityLog, ActivityStatus, ActivityTrace } from "../activity/activityLog";
import { AuditLog } from "../audit/auditLog";
import { canUse, ClientContext } from "../server/clients";
import { SecretStore, VaultLockedError } from "../store/secretStore";
import { SecretMetadata, toMetadata } from "../store/types";
import { findPlaceholders, PlaceholderError, PlaceholderMatch } from "./placeholders";
import { PolicyError, prepareRequest, PreparedRequest, RequestInput } from "./prepare";
import { createRedactor, Redactor } from "./redact";
import { BodyEncoding, Transport } from "./transport";

export interface BrokerLimits {
  timeoutMs: number;
  maxResponseBytes: number;
  maxRedirects: number;
}

export interface ApprovalRequest {
  client: string;
  method: string;
  /** Pre-substitution target: never contains a value. */
  url: string;
  secrets: string[];
  /** Secrets in this request that may go to any host: the dialog asks the user to check the address. */
  anyHost?: string[];
}

/** Asks the user to approve a request. Resolves false when denied or timed out. */
export type Approver = (req: ApprovalRequest) => Promise<boolean>;

export type BrokerErrorCode = "locked" | "denied" | "upstream_error" | PolicyError["code"];

export interface BrokerSuccess {
  ok: true;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
  bodyEncoding: BodyEncoding;
  bodyBytes: number;
  truncated: boolean;
  finalUrl: string;
  redactions: number;
}

export interface BrokerFailure {
  ok: false;
  error: { code: BrokerErrorCode; message: string };
}

export type BrokerResult = BrokerSuccess | BrokerFailure;

export class Broker {
  /** Cached redactor over every variable, for the activity panel. Dropped when the variables change. */
  private scrubber: Redactor | null = null;

  constructor(
    private readonly store: SecretStore,
    private readonly transport: Transport,
    private readonly approve: Approver,
    private readonly audit: AuditLog,
    private readonly limits: () => BrokerLimits,
    private readonly onActivity: () => void = () => undefined,
    /** Live activity shown in the panel. Lines never hold a value: they pass through `scrub` first. */
    readonly activity: ActivityLog = new ActivityLog(),
  ) {
    store.onChange(() => (this.scrubber = null));
    activity.setScrubber((text) => this.scrub(text));
  }

  /** Masks every stored value (and its encodings) in a line for the activity panel. Locked: nothing to mask. */
  private scrub(text: string): string {
    if (!this.store.isUnlocked || !text) return text;
    this.scrubber ??= createRedactor(this.store.list());
    return this.scrubber.redact(text).text;
  }

  /** Only the variables this client may use. */
  listSecrets(client: ClientContext, trace?: ActivityTrace): { ok: true; secrets: SecretMetadata[] } | BrokerFailure {
    const own = trace === undefined;
    const tr = trace ?? this.activity.begin({ client: client.name, tool: "list_secrets", source: "rest" });
    tr.line("info", "act.line.listReceived", { client: client.name });
    if (!this.store.isUnlocked) {
      this.audit.add({ client: client.name, action: "list", secrets: [], outcome: "locked" });
      tr.line("error", "act.line.vaultLocked");
      if (own) tr.end("locked");
      return fail("locked", new VaultLockedError().message);
    }
    this.onActivity();
    this.audit.add({ client: client.name, action: "list", secrets: [], outcome: "ok" });
    const secrets = this.store.list().filter((s) => canUse(client.access, s.id));
    tr.line("ok", "act.line.listResult", { n: secrets.length }, secrets.map((s) => s.name).join("\n"));
    if (own) tr.end("ok");
    return { ok: true, secrets: secrets.map(toMetadata) };
  }

  /**
   * `fromVaultTool`: the request comes from a vault tool. Permission is asked by the AI client, so no
   * approval dialog opens in Obsidian, not even for variables that may go to any host. The agent guide
   * requires the agent to ask the user (showing the destination) before running such a tool.
   * Hosts, placement, redirects and masking are still enforced.
   *
   * `alsoRedact`: names of secrets that are not sent but must still be masked in the response, e.g.
   * the secrets of a service note (a GET of an automation rule returns the tokens stored in it).
   *
   * `trace`: the activity session this request belongs to (an MCP call, a vault tool). Without one,
   * the request opens and closes its own session.
   */
  async execute(
    input: RequestInput,
    client: ClientContext,
    options: { fromVaultTool?: boolean; alsoRedact?: string[]; trace?: ActivityTrace } = {},
  ): Promise<BrokerResult> {
    const own = options.trace === undefined;
    const trace = options.trace ?? this.activity.begin({ client: client.name, tool: "http_request", source: "rest" });
    const result = await this.perform(input, client, options, trace);
    if (own) trace.end(outcomeOf(result), result.ok ? result.status : undefined);
    return result;
  }

  private async perform(
    input: RequestInput,
    client: ClientContext,
    options: { fromVaultTool?: boolean; alsoRedact?: string[] },
    trace: ActivityTrace,
  ): Promise<BrokerResult> {
    const who = client.name;
    if (options.fromVaultTool) trace.line("step", "act.line.requestN", { n: trace.session.requests + 1 });
    logReceived(trace, input);

    if (!this.store.isUnlocked) {
      this.audit.add({ client: who, action: "request", secrets: [], method: input?.method, outcome: "locked" });
      trace.line("error", "act.line.vaultLocked");
      return fail("locked", new VaultLockedError().message);
    }
    trace.line("ok", "act.line.vaultUnlocked");
    this.onActivity();

    let prepared: PreparedRequest;
    try {
      prepared = prepareRequest(
        input,
        (name) => this.store.get(name),
        (secret) => canUse(client.access, secret.id),
      );
    } catch (err) {
      if (err instanceof PolicyError || err instanceof PlaceholderError) {
        const code = err instanceof PolicyError ? err.code : "invalid_placeholder";
        // Policy messages are built from names and pre-substitution targets, never from values.
        this.audit.add({ client: who, action: "request", secrets: [], method: input?.method, target: rawTarget(input?.url), outcome: "blocked", detail: err.message });
        trace.line("error", "act.line.blocked", { code, message: err.message });
        return fail(code, err.message);
      }
      throw err;
    }

    const names = prepared.usedSecrets.map((s) => s.name);
    const target = prepared.displayTarget;
    trace.request(prepared.method, target);
    trace.useSecrets(names);
    logPlacementAndPolicy(trace, input, prepared, who);

    const extra = (options.alsoRedact ?? []).map((n) => this.store.get(n)).filter((s): s is NonNullable<typeof s> => s !== undefined);
    const redactor = createRedactor([...prepared.usedSecrets, ...extra]);

    const anyHost = prepared.usedSecrets.filter((s) => s.allowAnyHost === true).map((s) => s.name);
    const needsApproval = options.fromVaultTool ? false : prepared.needsApproval;
    if (needsApproval) {
      trace.line("warn", "act.line.approvalWaiting");
      const approved = await this.approve({ client: who, method: prepared.method, url: target, secrets: names, anyHost });
      if (!approved) {
        this.audit.add({ client: who, action: "request", secrets: names, method: prepared.method, target, outcome: "denied" });
        trace.line("error", "act.line.approvalDenied");
        return fail("denied", "The user denied this request in Obsidian.");
      }
      trace.line("ok", "act.line.approvalGranted");
    } else if (options.fromVaultTool && prepared.needsApproval) {
      trace.line("info", "act.line.approvalByClient");
    } else {
      trace.line("info", "act.line.approvalNotNeeded");
    }

    const limits = this.limits();
    trace.line("step", "act.line.sending", { method: prepared.method, target });
    try {
      const res = await this.transport({
        method: prepared.method,
        url: prepared.url,
        headers: prepared.headers,
        body: prepared.body,
        redirectDecision: (next, status) => {
          const decision = prepared.redirectDecision(next, status);
          trace.line(decision === "follow" ? "info" : "warn", decision === "follow" ? "act.line.redirectFollow" : "act.line.redirectStop", {
            status,
            to: next.origin + next.pathname,
          });
          return decision;
        },
        timeoutMs: limits.timeoutMs,
        maxResponseBytes: limits.maxResponseBytes,
        maxRedirects: limits.maxRedirects,
      });
      let redactions = 0;
      const clean = (text: string): string => {
        const r = redactor.redact(text);
        redactions += r.count;
        return r.text;
      };
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(res.headers)) headers[k] = clean(v);
      // A base64 body cannot be masked in place: if a secret is in its bytes, it is not returned at all.
      const secretInBytes = res.bodyEncoding === "base64" && hasSecretInBytes(res.body, redactor);
      if (secretInBytes) redactions++;
      const bodyEncoding: BodyEncoding = secretInBytes ? "omitted" : res.bodyEncoding;
      const body = secretInBytes ? "" : res.bodyEncoding === "base64" ? res.body : clean(res.body);
      const finalUrl = clean(res.finalUrl);
      const statusText = clean(res.statusText);
      await this.store.markUsed(names);
      this.audit.add({ client: who, action: "request", secrets: names, method: prepared.method, target, status: res.status, outcome: "ok", redactions });
      logResponse(trace, res.status, statusText, res.bodyBytes, res.truncated, headers, body, bodyEncoding, redactions, secretInBytes);
      return { ok: true, status: res.status, statusText, headers, body, bodyEncoding, bodyBytes: res.bodyBytes, truncated: res.truncated, finalUrl, redactions };
    } catch (err) {
      // Network errors can echo the request (URL, headers): mask before logging or returning.
      const message = redactor.redact(err instanceof Error ? err.message : String(err)).text;
      this.audit.add({ client: who, action: "request", secrets: names, method: prepared.method, target, outcome: "error", detail: message });
      trace.line("error", "act.line.transportError", { message });
      return fail("upstream_error", message);
    }
  }
}

/** Whether a stored value (or one of its encodings) is in the bytes of a base64 body, read as Latin-1 and as UTF-8. */
function hasSecretInBytes(base64: string, redactor: Redactor): boolean {
  const bytes = Buffer.from(base64, "base64");
  return redactor.redact(bytes.toString("latin1")).count > 0 || redactor.redact(bytes.toString("utf8")).count > 0;
}

function fail(code: BrokerErrorCode, message: string): BrokerFailure {
  return { ok: false, error: { code, message } };
}

/** How a finished request closes its activity session. */
export function outcomeOf(result: BrokerResult): Exclude<ActivityStatus, "running"> {
  if (result.ok) return "ok";
  switch (result.error.code) {
    case "locked":
      return "locked";
    case "denied":
      return "denied";
    case "upstream_error":
      return "error";
    default:
      return "blocked";
  }
}

// ---------- activity lines ----------

/** The mask shown where a value was put in. Fixed length, so the length of the value is not revealed either. */
const MASK = "********";

const encoder = new TextEncoder();

/** What the AI sent, as it sent it: placeholders are still placeholders, so there is no value here. */
function logReceived(trace: ActivityTrace, input: RequestInput): void {
  if (!input || typeof input !== "object") return;
  const method = typeof input.method === "string" ? input.method.toUpperCase() : "GET";
  trace.line("step", "act.line.requestReceived", { method, url: typeof input.url === "string" ? input.url : "" });
  const headers = input.headers;
  if (headers && typeof headers === "object" && !Array.isArray(headers)) {
    const rows = Object.entries(headers).map(([k, v]) => `${k}: ${String(v)}`);
    if (rows.length > 0) trace.line("info", "act.line.headersReceived", { n: rows.length }, rows.join("\n"));
  }
  if (typeof input.body === "string" && input.body !== "") {
    trace.line("info", "act.line.bodyReceived", { bytes: encoder.encode(input.body).length }, input.body);
  }
}

interface Located {
  match: PlaceholderMatch;
  /** "url", "body" or "header Name". */
  where: string;
}

function locatePlaceholders(input: RequestInput): Located[] {
  const out: Located[] = [];
  const add = (text: unknown, where: string) => {
    if (typeof text !== "string") return;
    for (const match of findPlaceholders(text)) out.push({ match, where });
  };
  add(input.url, "url");
  for (const [name, value] of Object.entries(input.headers ?? {})) add(value, `header ${name}`);
  add(input.body, "body");
  return out;
}

/** What the substituted text looks like, with the value hidden. */
function maskedFor(match: PlaceholderMatch): string {
  switch (match.kind) {
    case "basic":
      return `Basic ${MASK}`;
    case "bearer":
      return `Bearer ${MASK}`;
    default:
      return MASK;
  }
}

/** The placeholders found, the checks they passed and the substitution. Names and masks only. */
function logPlacementAndPolicy(trace: ActivityTrace, input: RequestInput, prepared: PreparedRequest, client: string): void {
  const found = locatePlaceholders(input);
  if (found.length === 0) {
    trace.line("info", "act.line.noPlaceholders");
    return;
  }
  trace.line("step", "act.line.placeholdersFound", { n: found.length });
  for (const f of found) trace.line("info", "act.line.placeholder", { raw: f.match.raw, name: f.match.name, where: f.where });

  const host = prepared.url.host;
  for (const s of prepared.usedSecrets) {
    const where = [...new Set(found.filter((f) => f.match.name === s.name).map((f) => f.where))].join(", ");
    if (s.fullAccess === true) trace.line("ok", "act.line.policyFullAccess", { name: s.name, client, where, host });
    else if (s.allowAnyHost === true) trace.line("ok", "act.line.policyAnyHost", { name: s.name, client, where, host });
    else trace.line("ok", "act.line.policyHosts", { name: s.name, client, where, host, hosts: s.allowedHosts.join(", ") });
  }

  trace.line("step", "act.line.substituting");
  for (const f of found) trace.line("ok", "act.line.substituted", { raw: f.match.raw, mask: maskedFor(f.match), where: f.where });
}

function logResponse(
  trace: ActivityTrace,
  status: number,
  statusText: string,
  bytes: number,
  truncated: boolean,
  headers: Record<string, string>,
  body: string,
  bodyEncoding: BodyEncoding,
  redactions: number,
  secretInBytes: boolean,
): void {
  trace.line(status < 400 ? "ok" : "warn", "act.line.responseReceived", { status, statusText, bytes });
  if (truncated) trace.line("warn", "act.line.responseTruncated");
  const rows = Object.entries(headers).map(([k, v]) => `${k}: ${v}`);
  if (rows.length > 0) trace.line("info", "act.line.responseHeaders", { n: rows.length }, rows.join("\n"));
  trace.line(redactions > 0 ? "warn" : "info", redactions > 0 ? "act.line.masked" : "act.line.maskedNone", { n: redactions });
  if (secretInBytes) trace.line("warn", "act.line.bodySecretInBytes");
  else if (bodyEncoding === "omitted") trace.line("info", "act.line.bodyOmitted");
  else if (bodyEncoding === "base64") trace.line("info", "act.line.bodyBase64", { bytes });
  else if (body !== "") trace.line("info", "act.line.responseBody", { bytes }, body);
}

/** Origin + path of the URL as the client sent it (placeholders, no substitution). */
function rawTarget(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  try {
    const u = new URL(raw);
    return (u.origin + u.pathname).replace(/%7B/gi, "{").replace(/%7D/gi, "}");
  } catch {
    return undefined;
  }
}
