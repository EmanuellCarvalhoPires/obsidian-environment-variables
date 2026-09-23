// Destination allowlist.
// Pattern forms:
//   "example.com"                         exact host, default port only
//   "example.com:8443"                    exact host and port
//   "*.example.com"                       subdomains only (not example.com itself)
//   "api.example.com/v1/workspaces/123/*" host + path prefix (also "/v1/workspaces/123")
// A scheme ("https://") in the pattern is ignored; the scheme rules live in prepare.ts.

export interface ParsedPattern {
  wildcard: boolean;
  host: string;
  port: string | null;
  /** Normalized path prefix without trailing slash, or null for any path. */
  pathPrefix: string | null;
}

export type WildcardRisk = "public-suffix" | "multitenant";

/** Suffixes where each subdomain belongs to a different customer. A wildcard here reaches other tenants. */
export const MULTITENANT_SUFFIXES = [
  "atlassian.net",
  "jira.com",
  "amazonaws.com",
  "s3.amazonaws.com",
  "cloudfront.net",
  "azurewebsites.net",
  "azure-api.net",
  "blob.core.windows.net",
  "cloudapp.azure.com",
  "appspot.com",
  "run.app",
  "web.app",
  "firebaseapp.com",
  "firebaseio.com",
  "herokuapp.com",
  "github.io",
  "githubusercontent.com",
  "gitlab.io",
  "vercel.app",
  "netlify.app",
  "pages.dev",
  "workers.dev",
  "onrender.com",
  "fly.dev",
  "railway.app",
  "supabase.co",
  "myshopify.com",
  "zendesk.com",
  "freshdesk.com",
  "salesforce.com",
  "force.com",
  "my.salesforce.com",
  "service-now.com",
  "slack.com",
  "monday.com",
  "notion.site",
  "ngrok.io",
  "ngrok-free.app",
  "trycloudflare.com",
];

/** Second-level public suffixes, so "*.com.br" is treated like "*.com". */
const PUBLIC_SECOND_LEVEL = new Set([
  "com.br",
  "net.br",
  "org.br",
  "gov.br",
  "co.uk",
  "org.uk",
  "com.au",
  "net.au",
  "co.jp",
  "co.nz",
  "com.mx",
  "com.ar",
  "co.in",
  "com.cn",
  "co.za",
]);

export function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/\.$/, "");
}

export function parsePattern(pattern: string): ParsedPattern | null {
  let p = pattern.trim();
  if (!p) return null;
  p = p.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  const slash = p.indexOf("/");
  const hostPart = (slash >= 0 ? p.slice(0, slash) : p).toLowerCase();
  const rawPath = slash >= 0 ? p.slice(slash) : "";

  let h = hostPart;
  const wildcard = h.startsWith("*.");
  if (wildcard) h = h.slice(2);
  if (!h || h.includes("*") || h.includes("@")) return null;
  let port: string | null = null;
  const portMatch = /^(.*):(\d{1,5})$/.exec(h);
  if (portMatch && !h.startsWith("[")) {
    h = portMatch[1];
    port = portMatch[2];
  }
  let host: string;
  try {
    host = normalizeHost(new URL(`https://${h}`).hostname); // IDN -> punycode, like URL.hostname
  } catch {
    return null;
  }
  if (!host) return null;

  const pathPrefix = normalizePathPrefix(rawPath);
  if (pathPrefix === undefined) return null;
  return { wildcard, host, port, pathPrefix };
}

/** Returns null for "any path", undefined when invalid. */
function normalizePathPrefix(rawPath: string): string | null | undefined {
  if (!rawPath) return null;
  let path = rawPath.replace(/[?#].*$/, "");
  if (path.endsWith("/*")) path = path.slice(0, -2);
  else if (path.endsWith("*")) return undefined; // only a trailing "/*" is supported
  if (path.includes("*")) return undefined;
  let normalized: string;
  try {
    normalized = new URL(`https://placeholder.invalid${path.startsWith("/") ? path : "/" + path}`).pathname;
  } catch {
    return undefined;
  }
  normalized = normalized.replace(/\/+$/, "");
  return normalized === "" ? null : normalized;
}

export function isValidPattern(pattern: string): boolean {
  const parsed = parsePattern(pattern);
  return parsed !== null && wildcardRisk(pattern) !== "public-suffix";
}

/** Flags wildcards that would reach other people's servers. */
export function wildcardRisk(pattern: string): WildcardRisk | null {
  const parsed = parsePattern(pattern);
  if (!parsed?.wildcard) return null;
  const labels = parsed.host.split(".");
  if (labels.length === 1 || PUBLIC_SECOND_LEVEL.has(parsed.host)) return "public-suffix";
  if (MULTITENANT_SUFFIXES.some((s) => parsed.host === s || parsed.host.endsWith("." + s))) return "multitenant";
  return null;
}

function defaultPort(url: URL): string {
  return url.protocol === "http:" ? "80" : "443";
}

/** Rejects paths that servers might decode into something outside the prefix. */
function hasAmbiguousPath(pathname: string): boolean {
  return /%2f|%5c|\\/i.test(pathname);
}

export function pathMatches(prefix: string | null, pathname: string): boolean {
  if (prefix === null) return true;
  if (hasAmbiguousPath(pathname)) return false;
  return pathname === prefix || pathname.startsWith(prefix + "/");
}

export function urlMatchesPattern(url: URL, pattern: string): boolean {
  const parsed = parsePattern(pattern);
  if (!parsed || wildcardRisk(pattern) === "public-suffix") return false;
  const host = normalizeHost(url.hostname);
  const hostOk = parsed.wildcard ? host.endsWith("." + parsed.host) && host.length > parsed.host.length + 1 : host === parsed.host;
  if (!hostOk) return false;
  const port = url.port || defaultPort(url);
  if (port !== (parsed.port ?? defaultPort(url))) return false;
  return pathMatches(parsed.pathPrefix, url.pathname);
}

export function urlAllowed(url: URL, patterns: string[]): boolean {
  return patterns.some((p) => urlMatchesPattern(url, p));
}

export function isLocalhost(url: URL): boolean {
  const h = normalizeHost(url.hostname);
  return h === "localhost" || h === "127.0.0.1" || h === "[::1]";
}
