import { AuditLog, safeTarget } from "../audit/auditLog";
import { SecretStore, VaultLockedError } from "../store/secretStore";
import { SECRET_NAME_PATTERN, ValueKind, VALUE_KINDS, valueMatchesKind } from "../store/types";
import { BrokerActivityEvent } from "./broker";
import { isValidPattern } from "./hosts";
import { findPlaceholders, hasPlaceholderLikeText, resolvePlaceholder, resolveValuePlaceholder } from "./placeholders";
import { PolicyError, prepareRequest } from "./prepare";
import { createRedactor, INSPECTOR_REDACTED, redactHeaders, redactionVariants } from "./redact";
import { Transport } from "./transport";

export interface SecretRequest {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  url: string;
  headers?: Record<string, string>;
  body?: string | Record<string, unknown>;
  timeoutMs?: number;
}

export interface SecretResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface AdoptSecretInput {
  ownerModuleId: string;
  field: string;
  suggestedName: string;
  allowedHosts: string[];
  value: string;
}

export interface CreateValueInput {
  name: string;
  kind: ValueKind;
  value: string;
  description?: string;
  /** Module or tool that asked for it, for the audit log. */
  createdBy: string;
}

/** Why a value was not created. `invalid_value` means the text does not fit the kind (e.g. a number that is not one). */
export type CreateValueResult = { ok: true } | { ok: false; reason: "exists" | "locked" | "invalid_name" | "empty" | "invalid_value" };

/**
 * Public contract registered as the `"secrets"` service on the AI Ecosystem Service Bus.
 *
 * Security rule: NEVER expose `getSecret` or return plaintext secret values to any caller.
 * Placeholders are resolved only inside `request()` and `spawnWithSecrets()`, and all responses
 * and logs are redacted before leaving this service.
 */
export interface SecretVaultService {
  isLocked(): boolean;
  request(req: SecretRequest, callerModuleId: string): Promise<SecretResponse>;
  spawnWithSecrets(
    env: Record<string, string>,
    spawnFn: (resolvedEnv: Record<string, string>) => Promise<void>,
    callerModuleId: string,
  ): Promise<void>;
  redact(text: string): string;
  adoptPlaintextSecret(input: AdoptSecretInput): Promise<{ placeholder: string }>;
  /** True when a secret OR a value already uses this name. False while locked. Never returns a value. */
  nameExists?(name: string): boolean;
  /** Creates an entry in the "Values" section. Never overwrites an existing secret or value. */
  createValue?(input: CreateValueInput): Promise<CreateValueResult>;
  /** Like spawnWithSecrets, but also resolves the placeholders in `args`. */
  spawnWithSecretsAndArgs?(
    input: { env: Record<string, string>; args: string[] },
    spawnFn: (resolved: { env: Record<string, string>; args: string[] }) => Promise<void>,
    callerModuleId: string,
  ): Promise<void>;
  /** Resolves {{secret:NAME}} of VALUES (never of secrets) inside template data. Other placeholders stay as they are. */
  resolveTemplateData?(data: unknown, callerModuleId: string): Promise<unknown>;
}

export interface SecretVaultServiceOptions {
  store: SecretStore;
  transport: Transport;
  audit: AuditLog;
  limits: () => { timeoutMs: number; maxResponseBytes: number; maxRedirects: number };
  onSecretsUsed?: (names: string[]) => void;
  onActivity?: (event: BrokerActivityEvent) => void;
}

/** Sanitizes an arbitrary suggested secret name into a valid uppercase `SECRET_NAME_PATTERN`. */
export function sanitizeSuggestedSecretName(raw: string): string {
  const cleaned = raw
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");
  const withLead = /^[A-Z]/.test(cleaned) ? cleaned : `SECRET_${cleaned}`;
  const candidate = withLead.slice(0, 60);
  return SECRET_NAME_PATTERN.test(candidate) ? candidate : "ADOPTED_SECRET";
}

export function createSecretVaultService(options: SecretVaultServiceOptions): SecretVaultService {
  const { store, transport, audit, limits, onSecretsUsed, onActivity } = options;

  const redact = (text: string): string => {
    if (!store.isUnlocked || typeof text !== "string" || text === "") return text;
    return createRedactor(store.list(), INSPECTOR_REDACTED, store.listValues()).redact(text).text;
  };

  const isLocked = (): boolean => !store.isUnlocked;

  const request = async (req: SecretRequest, callerModuleId: string): Promise<SecretResponse> => {
    const started = Date.now();
    const clientLabel = callerModuleId || "ecosystem-module";
    const method = (req.method ?? "GET").toUpperCase();

    if (!store.isUnlocked) {
      audit.add({ client: clientLabel, action: "request", secrets: [], method, outcome: "locked" });
      throw new VaultLockedError();
    }

    const headers: Record<string, string> = { ...(req.headers ?? {}) };
    let bodyText: string | undefined;
    if (typeof req.body === "string") {
      bodyText = req.body;
    } else if (req.body !== undefined && req.body !== null) {
      bodyText = JSON.stringify(req.body);
      if (!Object.keys(headers).some((k) => k.toLowerCase() === "content-type")) {
        headers["Content-Type"] = "application/json";
      }
    }

    let prepared;
    try {
      prepared = prepareRequest(
        { method, url: req.url, headers, body: bodyText },
        (name) => store.get(name),
        () => true,
        { allowUrlAndBodyPlacement: true, valueLookup: (name) => store.getValue(name) },
      );
      // There is no approval dialog on this path: a value may only go to its own hosts, like a secret.
      if (prepared.valuesOutsideHosts.length > 0) {
        throw new PolicyError(
          "host_not_allowed",
          `${prepared.valuesOutsideHosts.join(", ")} is not allowed for ${prepared.displayTarget}. Add the host to the value's allowed hosts in Obsidian.`,
        );
      }
    } catch (err) {
      const code = err instanceof PolicyError ? err.code : "bad_request";
      const message = redact(err instanceof Error ? err.message : String(err));
      audit.add({
        client: clientLabel,
        action: "request",
        secrets: [],
        method,
        target: safeTargetFromRaw(req.url),
        outcome: "blocked",
        detail: `${code}: ${message}`,
      });
      throw err;
    }

    const valueNames = prepared.usedValues.map((v) => v.name);
    const secretNames = [...prepared.usedSecrets.map((s) => s.name), ...valueNames];
    const target = prepared.displayTarget;
    const cfg = limits();
    const timeoutMs = typeof req.timeoutMs === "number" && req.timeoutMs > 0 ? req.timeoutMs : cfg.timeoutMs;

    try {
      const res = await transport({
        method: prepared.method,
        url: prepared.url,
        headers: prepared.headers,
        body: prepared.body,
        timeoutMs,
        maxResponseBytes: cfg.maxResponseBytes,
        maxRedirects: cfg.maxRedirects,
        redirectDecision: (next, status) => prepared.redirectDecision(next, status),
      });

      const allSecrets = store.list();
      const allValues = store.listValues();
      const variants = redactionVariants(allSecrets, allValues);
      const redactor = createRedactor(allSecrets, INSPECTOR_REDACTED, allValues);
      const redactedHeaders = redactHeaders(res.headers, variants, INSPECTOR_REDACTED);
      const redactedBody = redactor.redact(res.body);
      const totalRedactions = redactedHeaders.count + redactedBody.count;

      if (secretNames.length > 0) {
        await store.markUsed(prepared.usedSecrets.map((s) => s.name));
        await store.markValuesUsed(valueNames);
        onSecretsUsed?.(secretNames);
      }

      audit.add({
        client: clientLabel,
        action: "request",
        secrets: secretNames,
        method: prepared.method,
        target,
        status: res.status,
        outcome: "ok",
        redactions: totalRedactions,
      });

      try {
        onActivity?.({
          client: clientLabel,
          method: prepared.method,
          target,
          status: res.status,
          durationMs: Date.now() - started,
          payload: bodyText ? redact(bodyText) : undefined,
          response: redactedBody.text,
        });
      } catch {
        // Inspector logging must never fail the request.
      }

      return {
        status: res.status,
        headers: redactedHeaders.headers,
        body: redactedBody.text,
      };
    } catch (err) {
      const rawMessage = err instanceof Error ? err.message : String(err);
      const safeMessage = redact(rawMessage);
      audit.add({
        client: clientLabel,
        action: "request",
        secrets: secretNames,
        method: prepared.method,
        target,
        outcome: "error",
        detail: safeMessage,
      });
      throw new Error(safeMessage);
    }
  };

  /**
   * Replaces the placeholders in one string with the stored secrets and values.
   * Throws (after auditing) on an unknown name or a malformed placeholder; `label` names the field in the message.
   */
  const resolveSpawnText = (text: string, label: string, clientLabel: string, usedNames: Set<string>): string => {
    const placeholders = findPlaceholders(text);
    const attempts = (text.match(/\{\{\s*(secret|basic|bearer)\s*:/gi) ?? []).length;
    if (hasPlaceholderLikeText(text) && attempts !== placeholders.length) {
      audit.add({ client: clientLabel, action: "spawn", secrets: [], outcome: "blocked", detail: `invalid_placeholder in ${label}` });
      throw new PolicyError("invalid_placeholder", `Malformed placeholder in ${label}.`);
    }
    let out = text;
    for (const p of placeholders) {
      const secret = store.get(p.name);
      const entry = secret ? undefined : store.getValue(p.name);
      if (!secret && !entry) {
        audit.add({ client: clientLabel, action: "spawn", secrets: [], outcome: "blocked", detail: `unknown_secret: ${p.name}` });
        throw new PolicyError("unknown_secret", `Unknown environment variable: ${p.name}`);
      }
      usedNames.add(p.name);
      out = out.split(p.raw).join(secret ? resolvePlaceholder(p, secret) : resolveValuePlaceholder(p, entry!));
    }
    return out;
  };

  const markSpawnUsed = async (usedNames: Set<string>): Promise<void> => {
    if (usedNames.size === 0) return;
    const names = [...usedNames];
    await store.markUsed(names.filter((n) => store.get(n)));
    await store.markValuesUsed(names.filter((n) => !store.get(n)));
    onSecretsUsed?.(names);
  };

  const spawnWithSecrets = async (
    env: Record<string, string>,
    spawnFn: (resolvedEnv: Record<string, string>) => Promise<void>,
    callerModuleId: string,
  ): Promise<void> => {
    const clientLabel = callerModuleId || "ecosystem-module";
    if (!store.isUnlocked) {
      audit.add({ client: clientLabel, action: "spawn", secrets: [], outcome: "locked" });
      throw new VaultLockedError();
    }

    const resolvedEnv: Record<string, string> = {};
    const usedNames = new Set<string>();
    for (const [key, rawValue] of Object.entries(env ?? {})) {
      resolvedEnv[key] = resolveSpawnText(String(rawValue ?? ""), `environment variable "${key}"`, clientLabel, usedNames);
    }

    await markSpawnUsed(usedNames);
    audit.add({
      client: clientLabel,
      action: "spawn",
      secrets: [...usedNames],
      target: clientLabel,
      outcome: "ok",
    });

    await spawnFn(resolvedEnv);
  };

  const spawnWithSecretsAndArgs = async (
    input: { env: Record<string, string>; args: string[] },
    spawnFn: (resolved: { env: Record<string, string>; args: string[] }) => Promise<void>,
    callerModuleId: string,
  ): Promise<void> => {
    const clientLabel = callerModuleId || "ecosystem-module";
    if (!store.isUnlocked) {
      audit.add({ client: clientLabel, action: "spawn", secrets: [], outcome: "locked" });
      throw new VaultLockedError();
    }

    const env: Record<string, string> = {};
    const usedNames = new Set<string>();
    for (const [key, rawValue] of Object.entries(input?.env ?? {})) {
      env[key] = resolveSpawnText(String(rawValue ?? ""), `environment variable "${key}"`, clientLabel, usedNames);
    }
    const args = (input?.args ?? []).map((arg, i) => resolveSpawnText(String(arg ?? ""), `argument ${i + 1}`, clientLabel, usedNames));

    await markSpawnUsed(usedNames);
    audit.add({
      client: clientLabel,
      action: "spawn",
      secrets: [...usedNames],
      target: clientLabel,
      outcome: "ok",
    });

    await spawnFn({ env, args });
  };

  const nameExists = (name: string): boolean => store.isUnlocked && store.nameExists(name);

  const createValue = async (input: CreateValueInput): Promise<CreateValueResult> => {
    const clientLabel = input?.createdBy || "ecosystem-module";
    if (!store.isUnlocked) {
      audit.add({ client: clientLabel, action: "create", secrets: [], target: "value", outcome: "locked" });
      return { ok: false, reason: "locked" };
    }
    const name = typeof input?.name === "string" ? input.name : "";
    if (!SECRET_NAME_PATTERN.test(name)) return { ok: false, reason: "invalid_name" };
    const value = typeof input?.value === "string" ? input.value : "";
    if (value.trim() === "") return { ok: false, reason: "empty" };
    // Never overwrites: the name is unique across secrets and values.
    if (store.nameExists(name)) return { ok: false, reason: "exists" };
    if (!VALUE_KINDS.includes(input.kind) || !valueMatchesKind(input.kind, value)) return { ok: false, reason: "invalid_value" };

    const created = await store.addValue({
      name,
      kind: input.kind,
      value,
      description: typeof input.description === "string" ? input.description : "",
      allowedHosts: [],
      createdBy: clientLabel,
    });
    audit.add({ client: clientLabel, action: "create", secrets: [created.name], target: "value", outcome: "ok" });
    return { ok: true };
  };

  /** Replaces {{secret:NAME}} of values inside every string of the data. Secrets and unknown names are left as they are. */
  const resolveTemplateData = async (data: unknown, callerModuleId: string): Promise<unknown> => {
    const clientLabel = callerModuleId || "ecosystem-module";
    const usedNames = new Set<string>();
    const resolveValuesIn = (text: string): string => {
      const found = findPlaceholders(text).filter((p) => p.kind === "secret");
      if (found.length === 0) return text;
      if (!store.isUnlocked) {
        audit.add({ client: clientLabel, action: "template", secrets: [], outcome: "locked" });
        throw new VaultLockedError();
      }
      let out = text;
      for (const p of found) {
        if (store.get(p.name)) continue; // a secret: the placeholder stays
        const entry = store.getValue(p.name);
        if (!entry || (p.field && p.field !== "value")) continue;
        usedNames.add(entry.name);
        out = out.split(p.raw).join(resolveValuePlaceholder(p, entry));
      }
      return out;
    };
    const walk = (node: unknown): unknown => {
      if (typeof node === "string") return resolveValuesIn(node);
      if (Array.isArray(node)) return node.map(walk);
      if (node !== null && typeof node === "object" && Object.getPrototypeOf(node) === Object.prototype) {
        return Object.fromEntries(Object.entries(node as Record<string, unknown>).map(([k, v]) => [k, walk(v)]));
      }
      return node;
    };

    const resolved = walk(data);
    if (usedNames.size > 0) {
      const names = [...usedNames];
      await store.markValuesUsed(names);
      onSecretsUsed?.(names);
      audit.add({ client: clientLabel, action: "template", secrets: names, target: clientLabel, outcome: "ok" });
    }
    return resolved;
  };

  const adoptPlaintextSecret = async (input: AdoptSecretInput): Promise<{ placeholder: string }> => {
    const clientLabel = input.ownerModuleId || "ecosystem-module";
    if (!store.isUnlocked) {
      audit.add({ client: clientLabel, action: "adopt", secrets: [], target: input.field, outcome: "locked" });
      throw new VaultLockedError();
    }

    const trimmedValue = (input.value ?? "").trim();
    if (!trimmedValue) {
      throw new Error("Secret value is required for adoption.");
    }

    // If the value is already a placeholder, return it as is without creating a duplicate.
    const existingPlaceholders = findPlaceholders(trimmedValue);
    if (existingPlaceholders.length === 1 && existingPlaceholders[0].raw === trimmedValue) {
      return { placeholder: trimmedValue };
    }

    const baseName = sanitizeSuggestedSecretName(input.suggestedName || "ADOPTED_SECRET");
    const existingSameName = store.get(baseName);
    if (existingSameName && existingSameName.value === trimmedValue) {
      return { placeholder: `{{secret:${existingSameName.name}}}` };
    }

    let finalName = baseName;
    let suffix = 2;
    while (store.get(finalName)) {
      const candidate = store.get(`${baseName}_${suffix}`);
      if (candidate && candidate.value === trimmedValue) {
        return { placeholder: `{{secret:${candidate.name}}}` };
      }
      finalName = `${baseName}_${suffix++}`;
    }

    const validHosts = (input.allowedHosts ?? []).map((h) => h.trim()).filter((h) => h && isValidPattern(h));
    const created = await store.add({
      name: finalName,
      type: "token",
      value: trimmedValue,
      description: `Adopted from ${clientLabel} (${input.field})`,
      allowedHosts: validHosts,
      allowAnyHost: validHosts.length === 0,
      fullAccess: false,
      allowHttpLocalhost: false,
      placement: { headers: true, url: true, body: false },
      approval: "never",
    });

    audit.add({
      client: clientLabel,
      action: "adopt",
      secrets: [created.name],
      target: input.field,
      outcome: "ok",
    });

    return { placeholder: `{{secret:${created.name}}}` };
  };

  return Object.freeze({
    isLocked,
    request,
    spawnWithSecrets,
    redact,
    adoptPlaintextSecret,
    nameExists,
    createValue,
    spawnWithSecretsAndArgs,
    resolveTemplateData,
  });
}

function safeTargetFromRaw(raw: string): string | undefined {
  try {
    const cleaned = findPlaceholders(raw).reduce((s, p) => s.split(p.raw).join("REDACTED"), raw);
    return safeTarget(new URL(cleaned));
  } catch {
    return undefined;
  }
}
