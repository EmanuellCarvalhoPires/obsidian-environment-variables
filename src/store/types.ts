export type SecretType = "token" | "basic" | "bearer" | "header" | "env";

export type ApprovalPolicy = "never" | "writes" | "always";

export interface SecretPlacement {
  /** Headers are always allowed; this flag exists for clarity in the UI. */
  headers: true;
  /** Allow the placeholder in the URL (path or query string). */
  url: boolean;
  /** Allow the placeholder in the request body. */
  body: boolean;
}

export interface SecretRecord {
  id: string;
  /** Key used in placeholders, e.g. JIRA_ACME. Letters, digits and underscore. */
  name: string;
  type: SecretType;
  /** Username or e-mail, for the "basic" type. Not considered secret. */
  username?: string;
  /** The sensitive value. Never leaves the plugin except inside an outgoing request. */
  value: string;
  description: string;
  /** Host patterns where this secret may be sent, e.g. "acme.atlassian.net" or "*.atlassian.net". */
  allowedHosts: string[];
  /**
   * Allow any https host (allowedHosts is then ignored). Every request with this secret
   * needs approval and never follows a redirect to another origin. Off when missing.
   */
  allowAnyHost?: boolean;
  /**
   * Full access: allow any https host AND skip the approval dialog entirely
   * (allowedHosts and allowAnyHost are then ignored). Off when missing.
   */
  fullAccess?: boolean;
  /** Allow plain http:// to localhost/127.0.0.1 (for local services). */
  allowHttpLocalhost: boolean;
  placement: SecretPlacement;
  approval: ApprovalPolicy;
  createdAt: string;
  updatedAt: string;
  lastUsedAt?: string;
}

/** Everything about a secret except its value. Safe to show to AI clients. */
export type SecretMetadata = Omit<SecretRecord, "value" | "id" | "username">;

export interface CompactSecretMetadata {
  name: string;
  type: SecretType;
  hosts: string[];
  fullAccess: boolean;
}

export type ValueKind = "texto" | "numero" | "url" | "email" | "json" | "senha";

export const VALUE_KINDS: ValueKind[] = ["texto", "numero", "url", "email", "json", "senha"];

/**
 * An entry of the "Values" section: configuration text the agent may use through the same
 * `{{secret:NAME}}` placeholder (and the same namespace) as secrets, but only in requests,
 * script env and args, and template data.
 */
export interface ValueRecord {
  id: string;
  /** Key used in placeholders. Unique across secrets and values. */
  name: string;
  kind: ValueKind;
  /** The stored text. Never leaves the plugin except inside an outgoing request, a script or a template. */
  value: string;
  description: string;
  /** Host patterns this value is meant for. A request to any other host asks for approval. */
  allowedHosts: string[];
  /** Which module or tool created it, e.g. "agent-screen". Not a credential. */
  createdBy?: string;
  createdAt: string;
  updatedAt: string;
  lastUsedAt?: string;
}

/** Everything about a value except its text. Safe to show to AI clients. */
export type ValueMetadata = Omit<ValueRecord, "value" | "id">;

export interface VaultPayload {
  secrets: SecretRecord[];
  /** Added with the Values section: files written before it have no such field. */
  values?: ValueRecord[];
}

/** Shorter values are stored but never masked in responses (too likely to match normal text). */
export const MIN_MASKED_VALUE_LENGTH = 6;

/** Whether the text is acceptable for the kind of value: a number, an http(s) URL, an e-mail address or JSON. */
export function valueMatchesKind(kind: ValueKind, text: string): boolean {
  switch (kind) {
    case "numero":
      return text.trim() !== "" && Number.isFinite(Number(text));
    case "url":
      try {
        const u = new URL(text.trim());
        return u.protocol === "https:" || u.protocol === "http:";
      } catch {
        return false;
      }
    case "email":
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text.trim());
    case "json":
      try {
        JSON.parse(text);
        return true;
      } catch {
        return false;
      }
    default:
      return true;
  }
}

export const SECRET_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

export function toCompactMetadata(secret: SecretRecord): CompactSecretMetadata {
  return {
    name: secret.name,
    type: secret.type,
    hosts: [...(secret.allowedHosts ?? [])],
    fullAccess: secret.fullAccess ?? false,
  };
}

export function toMetadata(secret: SecretRecord): SecretMetadata {
  const { value: _value, id: _id, username: _username, ...rest } = secret;
  return rest;
}
