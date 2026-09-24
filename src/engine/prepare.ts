import { SecretRecord } from "../store/types";
import { isLocalhost, urlAllowed } from "./hosts";
import { findPlaceholders, hasPlaceholderLikeText, PlaceholderMatch, resolvePlaceholder } from "./placeholders";

export interface RequestInput {
  method?: string;
  url: string;
  headers?: Record<string, string>;
  body?: string;
}

/** Where secrets were inserted in this request. */
export interface SecretPlacements {
  headers: boolean;
  url: boolean;
  body: boolean;
}

export type RedirectDecision = "follow" | "stop";

export interface PreparedRequest {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body?: string;
  usedSecrets: SecretRecord[];
  placements: SecretPlacements;
  needsApproval: boolean;
  /**
   * Origin + path built from the request *before* substitution (placeholders shown as-is).
   * Safe for the audit log and the approval dialog even when a secret goes in the URL.
   */
  displayTarget: string;
  /** Decides whether a redirect to `next` may be followed with the same request. */
  redirectDecision(next: URL, status: number): RedirectDecision;
}

export type PolicyCode =
  | "invalid_request"
  | "unknown_secret"
  | "secret_not_permitted"
  | "host_not_allowed"
  | "insecure_scheme"
  | "placement_not_allowed"
  | "invalid_placeholder";

export class PolicyError extends Error {
  constructor(
    public readonly code: PolicyCode,
    message: string,
  ) {
    super(message);
    this.name = "PolicyError";
  }
}

const METHODS = new Set(["GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE"]);
const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export type SecretLookup = (name: string) => SecretRecord | undefined;
/** Per-client access control. Return false when the client may not use this secret. */
export type SecretPermit = (secret: SecretRecord) => boolean;

export function prepareRequest(input: RequestInput, lookup: SecretLookup, permit: SecretPermit = () => true): PreparedRequest {
  if (!input || typeof input.url !== "string" || !input.url) throw new PolicyError("invalid_request", "url is required.");
  const method = (input.method ?? "GET").toUpperCase();
  if (!METHODS.has(method)) throw new PolicyError("invalid_request", `Unsupported method ${method}.`);
  const headersIn = input.headers ?? {};
  if (typeof headersIn !== "object" || Array.isArray(headersIn)) throw new PolicyError("invalid_request", "headers must be an object.");
  if (input.body !== undefined && typeof input.body !== "string") {
    throw new PolicyError("invalid_request", "body must be a string. Serialize JSON before sending.");
  }

  // The scheme, host and port must never contain placeholders: they decide where the secret goes.
  const authorityEnd = authorityEndIndex(input.url);
  if (hasPlaceholderLikeText(input.url.slice(0, authorityEnd))) {
    throw new PolicyError("placement_not_allowed", "Placeholders are not allowed in the scheme, host or port of the URL.");
  }

  let target: URL;
  try {
    target = new URL(input.url);
  } catch {
    throw new PolicyError("invalid_request", "url is not a valid absolute URL.");
  }
  if (target.username || target.password) throw new PolicyError("invalid_request", "Credentials inside the URL are not allowed.");

  const display = displayTargetOf(target);
  const used = new Map<string, SecretRecord>();
  const placements: SecretPlacements = { headers: false, url: false, body: false };

  const resolveIn = (text: string, where: "url" | "header" | "body", checkUrl: URL): string => {
    assertWellFormed(text);
    const matches = findPlaceholders(text);
    if (matches.length === 0) return text;
    let out = "";
    let last = 0;
    for (const m of matches) {
      const secret = lookupOrThrow(lookup, m);
      if (!permit(secret)) throw new PolicyError("secret_not_permitted", `This client is not allowed to use ${secret.name}. Grant access in Obsidian (Environment Variables > AI clients).`);
      checkPlacement(secret, where);
      checkDestination(secret, checkUrl, display);
      used.set(secret.name, secret);
      placements[where === "header" ? "headers" : where] = true;
      out += text.slice(last, m.index) + resolvePlaceholder(m, secret);
      last = m.index + m.raw.length;
    }
    return out + text.slice(last);
  };

  // A placeholder in the path could itself change the path, so path-prefix rules are checked
  // against the final URL, and the URL placeholders are checked against it too.
  const url = new URL(resolveIn(input.url, "url", target));
  for (const s of used.values()) checkDestination(s, url, display);

  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(headersIn)) {
    if (typeof value !== "string") throw new PolicyError("invalid_request", `Header ${name} must be a string.`);
    if (hasPlaceholderLikeText(name)) throw new PolicyError("placement_not_allowed", "Placeholders are not allowed in header names.");
    headers[name] = resolveIn(value, "header", url);
  }
  const body = input.body === undefined ? undefined : resolveIn(input.body, "body", url);

  const usedSecrets = [...used.values()];
  // A secret without a host list can be sent anywhere, so the user checks every destination.
  const needsApproval = usedSecrets.some(
    (s) => s.allowAnyHost === true || s.approval === "always" || (s.approval === "writes" && !READ_METHODS.has(method)),
  );
  const origin = url.origin;

  return {
    method,
    url,
    headers,
    body,
    usedSecrets,
    placements,
    needsApproval,
    displayTarget: display,
    redirectDecision(next: URL, status: number): RedirectDecision {
      if (usedSecrets.length === 0) return "follow";
      const sameOrigin = next.origin === origin;
      // A secret in the URL or in a body that 307/308 would re-send must never change origin.
      const bodyResent = status === 307 || status === 308;
      if (!sameOrigin && (placements.url || (placements.body && bodyResent))) return "stop";
      // The user approved one origin; a redirect must not take an any-host secret elsewhere.
      if (!sameOrigin && usedSecrets.some((s) => s.allowAnyHost === true)) return "stop";
      // Every secret must be allowed at the new destination (host, port, path prefix, scheme).
      for (const s of usedSecrets) {
        if (!destinationAllowed(s, next)) return "stop";
      }
      return "follow";
    },
  };
}

function displayTargetOf(url: URL): string {
  return (url.origin + url.pathname).replace(/%7B/gi, "{").replace(/%7D/gi, "}");
}

function authorityEndIndex(url: string): number {
  const schemeEnd = url.indexOf("://");
  const start = schemeEnd >= 0 ? schemeEnd + 3 : 0;
  const rest = url.slice(start);
  const cut = rest.search(/[/?#]/);
  return cut < 0 ? url.length : start + cut;
}

function assertWellFormed(text: string): void {
  if (!hasPlaceholderLikeText(text)) return;
  const valid = findPlaceholders(text).length;
  const attempts = (text.match(/\{\{\s*(secret|basic|bearer)\s*:/gi) ?? []).length;
  if (attempts !== valid) {
    throw new PolicyError("invalid_placeholder", "Malformed placeholder. Use {{secret:NAME}}, {{basic:NAME}} or {{bearer:NAME}}.");
  }
}

function lookupOrThrow(lookup: SecretLookup, m: PlaceholderMatch): SecretRecord {
  const secret = lookup(m.name);
  if (!secret) throw new PolicyError("unknown_secret", `No variable named ${m.name}. Call list_secrets to see the available keys.`);
  return secret;
}

function checkPlacement(secret: SecretRecord, where: "url" | "header" | "body"): void {
  if (where === "url" && !secret.placement.url) {
    throw new PolicyError("placement_not_allowed", `${secret.name} may only be used in headers, not in the URL.`);
  }
  if (where === "body" && !secret.placement.body) {
    throw new PolicyError("placement_not_allowed", `${secret.name} may only be used in headers, not in the body.`);
  }
}

/** Scheme + host + port + path-prefix check, without throwing. */
export function destinationAllowed(secret: SecretRecord, url: URL): boolean {
  if (url.protocol === "http:") {
    if (!(secret.allowHttpLocalhost && isLocalhost(url))) return false;
  } else if (url.protocol !== "https:") {
    return false;
  }
  if (secret.allowAnyHost === true) return true;
  if (secret.allowedHosts.length === 0) return false;
  return urlAllowed(url, secret.allowedHosts);
}

/** `display` is the pre-substitution target, so error messages never contain a value. */
function checkDestination(secret: SecretRecord, url: URL, display: string): void {
  if (secret.allowedHosts.length === 0 && secret.allowAnyHost !== true) {
    throw new PolicyError("host_not_allowed", `${secret.name} has no allowed hosts configured.`);
  }
  if (url.protocol === "http:" && !(secret.allowHttpLocalhost && isLocalhost(url))) {
    throw new PolicyError("insecure_scheme", `${secret.name} can only be sent over https.`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new PolicyError("insecure_scheme", `Unsupported scheme ${url.protocol}`);
  }
  if (!destinationAllowed(secret, url)) {
    throw new PolicyError(
      "host_not_allowed",
      `${secret.name} is not allowed for ${display}. Allowed: ${secret.allowedHosts.join(", ")}.`,
    );
  }
}
