import { AuditLog } from "../audit/auditLog";
import { canUse, ClientContext } from "../server/clients";
import { SecretStore, VaultLockedError } from "../store/secretStore";
import { SecretMetadata, toMetadata } from "../store/types";
import { PlaceholderError } from "./placeholders";
import { PolicyError, prepareRequest, PreparedRequest, RequestInput } from "./prepare";
import { createRedactor } from "./redact";
import { Transport } from "./transport";

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
  bodyEncoding: "text" | "omitted";
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
  constructor(
    private readonly store: SecretStore,
    private readonly transport: Transport,
    private readonly approve: Approver,
    private readonly audit: AuditLog,
    private readonly limits: () => BrokerLimits,
    private readonly onActivity: () => void = () => undefined,
  ) {}

  /** Only the variables this client may use. */
  listSecrets(client: ClientContext): { ok: true; secrets: SecretMetadata[] } | BrokerFailure {
    if (!this.store.isUnlocked) {
      this.audit.add({ client: client.name, action: "list", secrets: [], outcome: "locked" });
      return fail("locked", new VaultLockedError().message);
    }
    this.onActivity();
    this.audit.add({ client: client.name, action: "list", secrets: [], outcome: "ok" });
    const secrets = this.store.list().filter((s) => canUse(client.access, s.id));
    return { ok: true, secrets: secrets.map(toMetadata) };
  }

  async execute(input: RequestInput, client: ClientContext): Promise<BrokerResult> {
    const who = client.name;
    if (!this.store.isUnlocked) {
      this.audit.add({ client: who, action: "request", secrets: [], method: input?.method, outcome: "locked" });
      return fail("locked", new VaultLockedError().message);
    }
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
        return fail(code, err.message);
      }
      throw err;
    }

    const names = prepared.usedSecrets.map((s) => s.name);
    const target = prepared.displayTarget;
    const redactor = createRedactor(prepared.usedSecrets);

    if (prepared.needsApproval) {
      const approved = await this.approve({ client: who, method: prepared.method, url: target, secrets: names });
      if (!approved) {
        this.audit.add({ client: who, action: "request", secrets: names, method: prepared.method, target, outcome: "denied" });
        return fail("denied", "The user denied this request in Obsidian.");
      }
    }

    const limits = this.limits();
    try {
      const res = await this.transport({
        method: prepared.method,
        url: prepared.url,
        headers: prepared.headers,
        body: prepared.body,
        redirectDecision: (next, status) => prepared.redirectDecision(next, status),
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
      const body = clean(res.body);
      const finalUrl = clean(res.finalUrl);
      const statusText = clean(res.statusText);
      await this.store.markUsed(names);
      this.audit.add({ client: who, action: "request", secrets: names, method: prepared.method, target, status: res.status, outcome: "ok", redactions });
      return { ok: true, status: res.status, statusText, headers, body, bodyEncoding: res.bodyEncoding, bodyBytes: res.bodyBytes, truncated: res.truncated, finalUrl, redactions };
    } catch (err) {
      // Network errors can echo the request (URL, headers): mask before logging or returning.
      const message = redactor.redact(err instanceof Error ? err.message : String(err)).text;
      this.audit.add({ client: who, action: "request", secrets: names, method: prepared.method, target, outcome: "error", detail: message });
      return fail("upstream_error", message);
    }
  }
}

function fail(code: BrokerErrorCode, message: string): BrokerFailure {
  return { ok: false, error: { code, message } };
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
