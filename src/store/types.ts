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
  /** Key used in placeholders, e.g. JIRA_CSPTECH. Letters, digits and underscore. */
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
  /** Allow plain http:// to localhost/127.0.0.1 (for local services). */
  allowHttpLocalhost: boolean;
  placement: SecretPlacement;
  approval: ApprovalPolicy;
  createdAt: string;
  updatedAt: string;
  lastUsedAt?: string;
}

/** Everything about a secret except its value. Safe to show to AI clients. */
export type SecretMetadata = Omit<SecretRecord, "value" | "id">;

export interface VaultPayload {
  secrets: SecretRecord[];
}

export const SECRET_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

export function toMetadata(secret: SecretRecord): SecretMetadata {
  const { value: _value, id: _id, ...rest } = secret;
  return rest;
}
