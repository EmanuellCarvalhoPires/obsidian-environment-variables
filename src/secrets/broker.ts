import { AuditLog } from "../audit/auditLog";
import { canUse, ClientContext } from "../server/clients";
import { SecretStore, VaultLockedError } from "../store/secretStore";
import { SecretMetadata, toMetadata } from "../store/types";
import { PlaceholderError } from "./placeholders";
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
  /** Values (not secrets) in this request whose allowed hosts do not cover the destination. */
  outsideHosts?: string[];
}

export interface BrokerActivityEvent {
  client: string;
  method?: string;
  target: string;
  status?: number;
  durationMs?: number;
  payload?: string;
  response?: string;
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
  constructor(
    private readonly store: SecretStore,
    private readonly transport: Transport,
    private readonly approve: Approver,
    private readonly audit: AuditLog,
    private readonly limits: () => BrokerLimits,
    private readonly onActivity: () => void = () => undefined,
    private readonly onInspectorEvent?: (event: BrokerActivityEvent) => void,
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

  /**
   * `fromVaultTool`: the request comes from a vault tool. Permission is asked by the AI client, so no
   * approval dialog opens in Obsidian, not even for variables that may go to any host.
   *
   * `alsoRedact`: names of secrets that are not sent but must still be masked in the response.
   */
  async execute(
    input: RequestInput,
    client: ClientContext,
    options: { fromVaultTool?: boolean; alsoRedact?: string[] } = {},
  ): Promise<BrokerResult> {
    const started = Date.now();
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
        { valueLookup: (name) => this.store.getValue(name) },
      );
    } catch (err) {
      if (err instanceof PolicyError || err instanceof PlaceholderError) {
        const code = err instanceof PolicyError ? err.code : "invalid_placeholder";
        this.audit.add({
          client: who,
          action: "request",
          secrets: [],
          method: input?.method,
          target: rawTarget(input?.url),
          outcome: "blocked",
          detail: err.message,
        });
        return fail(code, err.message);
      }
      throw err;
    }

    const valueNames = prepared.usedValues.map((v) => v.name);
    const names = [...prepared.usedSecrets.map((s) => s.name), ...valueNames];
    const target = prepared.displayTarget;

    const extra = (options.alsoRedact ?? []).map((n) => this.store.get(n)).filter((s): s is NonNullable<typeof s> => s !== undefined);
    const redactor = createRedactor([...prepared.usedSecrets, ...extra], undefined, prepared.usedValues);

    const anyHost = prepared.usedSecrets.filter((s) => s.allowAnyHost === true).map((s) => s.name);
    const needsApproval = options.fromVaultTool ? false : prepared.needsApproval;
    if (needsApproval) {
      const approved = await this.approve({
        client: who,
        method: prepared.method,
        url: target,
        secrets: names,
        anyHost,
        outsideHosts: prepared.valuesOutsideHosts,
      });
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
      const secretInBytes = res.bodyEncoding === "base64" && hasSecretInBytes(res.body, redactor);
      if (secretInBytes) redactions++;
      const bodyEncoding: BodyEncoding = secretInBytes ? "omitted" : res.bodyEncoding;
      const body = secretInBytes ? "" : res.bodyEncoding === "base64" ? res.body : clean(res.body);
      const finalUrl = clean(res.finalUrl);
      const statusText = clean(res.statusText);
      await this.store.markUsed(prepared.usedSecrets.map((s) => s.name));
      await this.store.markValuesUsed(valueNames);
      this.audit.add({
        client: who,
        action: "request",
        secrets: names,
        method: prepared.method,
        target,
        status: res.status,
        outcome: "ok",
        redactions,
      });
      try {
        this.onInspectorEvent?.({
          client: who,
          method: prepared.method,
          target,
          status: res.status,
          durationMs: Date.now() - started,
          payload: typeof input.body === "string" ? redactor.redact(input.body).text : undefined,
          response:
            bodyEncoding === "text"
              ? body
              : bodyEncoding === "base64"
                ? `[base64 ${res.bodyBytes} bytes]`
                : secretInBytes
                  ? "[omitted: secret in binary response]"
                  : "[omitted]",
        });
      } catch {
        // Inspector callback must never fail a request.
      }
      return {
        ok: true,
        status: res.status,
        statusText,
        headers,
        body,
        bodyEncoding,
        bodyBytes: res.bodyBytes,
        truncated: res.truncated,
        finalUrl,
        redactions,
      };
    } catch (err) {
      const message = redactor.redact(err instanceof Error ? err.message : String(err)).text;
      this.audit.add({ client: who, action: "request", secrets: names, method: prepared.method, target, outcome: "error", detail: message });
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
