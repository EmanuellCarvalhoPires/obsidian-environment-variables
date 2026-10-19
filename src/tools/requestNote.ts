// Request notes: a saved HTTP request (like in Postman) in a ```http block.
//
//   ```http
//   GET {{service.url}}/rest/api/3/issue/{{param:key}}?fields={{param:fields}}
//   Authorization: {{service.auth}}
//   Accept: application/json
//   ```
//
// {{service.<property>}} comes from the frontmatter of the linked service note and is inserted as is,
// so it may hold secret placeholders such as {{basic:JIRA_ACME}}. Nested properties use dots:
// {{service.automation_web_auth.bitbucket}}. {{param:<name>}} comes from the tool call and is encoded
// for where it lands. Secret placeholders are resolved later by the broker, which keeps enforcing
// hosts, placement and approval.
//
// In the body, {{param:<name>|inject_service:<map>}} lets a parameter carry markers {{inject:<key>}}
// (e.g. an automation rule whose web request needs a token). Each marker is replaced by the value of
// <key> in the map <map> of the service note. Only keys declared there can be injected: the agent
// picks a key, never a secret.

import { findPlaceholders, hasPlaceholderLikeText } from "../secrets/placeholders";
import { RequestInput } from "../secrets/prepare";
import { extractCodeBlock } from "./definition";
import { ToolError, VaultNote } from "./types";

export interface RequestTemplate {
  method: string;
  url: string;
  headers: Array<[string, string]>;
  body?: string;
}

const METHODS = new Set(["GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE"]);
const HEADER_LINE = /^([!#$%&'*+.^_`|~0-9A-Za-z-]+)[ \t]*:[ \t]?(.*)$/;
const PATH = String.raw`[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*`;
const TOKEN = new RegExp(String.raw`\{\{\s*(?:service\.(${PATH})|param:([A-Za-z_][A-Za-z0-9_]*)(?:\s*\|\s*inject_service\s*:\s*(${PATH}))?)\s*\}\}`, "g");
const EXACT_PARAM = /^\{\{\s*param:([A-Za-z_][A-Za-z0-9_]*)\s*\}\}$/;
/** Marker an argument may carry where a service value must be injected. */
const INJECT_MARKER = /\{\{\s*inject\s*:\s*([A-Za-z0-9_-]+)\s*\}\}/g;
const INJECT_ATTEMPT = /\{\{\s*inject\s*:/gi;

export function parseRequestBlock(noteBody: string, noteName = "request note"): RequestTemplate {
  const block = extractCodeBlock(noteBody, ["http", "rest"]);
  if (block === null) throw new ToolError("invalid_request_note", `${noteName} has no \`\`\`http block.`);
  const lines = block.split(/\r?\n/);
  let i = 0;
  while (i < lines.length && (!lines[i].trim() || /^\s*(#|\/\/)/.test(lines[i]))) i++;
  if (i >= lines.length) throw new ToolError("invalid_request_note", `The \`\`\`http block of ${noteName} is empty.`);

  const first = lines[i].trim();
  let method = "GET";
  let url = first;
  const m = /^([A-Za-z]+)\s+(\S+)(?:\s+HTTP\/[\d.]+)?$/.exec(first);
  if (m) {
    method = m[1].toUpperCase();
    url = m[2];
  } else if (/\s/.test(first)) {
    throw new ToolError("invalid_request_note", `First line of ${noteName} must be "METHOD URL", e.g. "GET https://api.example.com/items". Got: ${first}`);
  }
  if (!METHODS.has(method)) throw new ToolError("invalid_request_note", `${noteName}: unsupported method ${method}.`);
  i++;

  const headers: Array<[string, string]> = [];
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      break;
    }
    const h = HEADER_LINE.exec(line);
    if (!h) throw new ToolError("invalid_request_note", `${noteName}: invalid header line "${line}". Use "Name: value", then a blank line before the body.`);
    headers.push([h[1], h[2].trim()]);
  }
  const body = lines.slice(i).join("\n").replace(/\s+$/, "");
  return { method, url, headers, body: body ? body : undefined };
}

export interface ResolveInput {
  params: Record<string, unknown>;
  /** Service note used by {{service.*}}. */
  service?: VaultNote;
  noteName?: string;
}

/** Fills the template. The result still holds secret placeholders; the broker resolves them. */
export function resolveRequest(tpl: RequestTemplate, input: ResolveInput): RequestInput {
  const noteName = input.noteName ?? "request note";
  const injectable = injectableParams(tpl);
  for (const [k, v] of Object.entries(input.params)) {
    const text = typeof v === "string" ? v : v !== null && typeof v === "object" ? JSON.stringify(v) : "";
    if (hasPlaceholderLikeText(text)) {
      throw new ToolError("invalid_argument", `Argument "${k}" contains a secret placeholder. Placeholders may only come from service or request notes.`);
    }
    if (!injectable.has(k) && hasInjectLikeText(text)) {
      throw new ToolError("invalid_argument", `Argument "${k}" contains an {{inject:...}} marker, but ${noteName} does not declare {{param:${k}|inject_service:...}} in the body.`);
    }
  }

  const lookup = (path: string, use: string): unknown => {
    if (!input.service) {
      throw new ToolError("invalid_request_note", `${noteName} uses ${use} but no service note is linked. Set service: "[[...]]" in the request note or in the tool note.`);
    }
    const value = serviceValue(input.service.frontmatter, path);
    if (value === undefined || value === null || value === "") {
      throw new ToolError("invalid_request_note", `Service note "${input.service.name}" has no property "${path}".`);
    }
    return value;
  };
  const service = (path: string): string => {
    const value = lookup(path, `{{service.${path}}}`);
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
      throw new ToolError("invalid_request_note", `Property "${path}" of "${input.service!.name}" must be text or a number. For a nested value use {{service.${path}.<key>}}.`);
    }
    return String(value);
  };
  const injectMap = (path: string, paramName: string): Record<string, string> => {
    const value = lookup(path, `{{param:${paramName}|inject_service:${path}}}`);
    if (typeof value !== "object" || Array.isArray(value)) {
      throw new ToolError("invalid_request_note", `Property "${path}" of "${input.service!.name}" must be a map of key: value for inject_service.`);
    }
    const map: Record<string, string> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      if (typeof v !== "string" || !v) {
        throw new ToolError("invalid_request_note", `Key "${key}" of "${path}" in "${input.service!.name}" must be text, e.g. "{{bearer:NAME}}".`);
      }
      assertWellFormedPlaceholders(v, `Key "${key}" of "${path}" in "${input.service!.name}"`);
      map[key] = v;
    }
    return map;
  };
  const param = (name: string): unknown => {
    const v = input.params[name];
    if (v === undefined || v === null) throw new ToolError("invalid_argument", `${noteName} needs a value for {{param:${name}}}.`);
    return v;
  };
  const noInject = (inject: string | undefined) => {
    if (inject) throw new ToolError("invalid_request_note", `${noteName}: inject_service is only allowed in the body, not in the URL or a header.`);
  };

  const url = resolveUrl(tpl.url, service, param, input.params, noInject);

  const headers: Record<string, string> = {};
  for (const [name, raw] of tpl.headers) {
    const value = raw.replace(TOKEN, (_all, svc: string | undefined, p: string | undefined, inject: string | undefined) => {
      if (svc) return service(svc);
      noInject(inject);
      return scalar(param(p!), p!);
    });
    if (/[\r\n]/.test(value)) throw new ToolError("invalid_argument", `Header ${name} would contain a line break.`);
    headers[name] = value;
  }

  let body: string | undefined;
  if (tpl.body !== undefined) {
    const contentType = Object.entries(headers).find(([k]) => k.toLowerCase() === "content-type")?.[1] ?? "";
    const json = /json/i.test(contentType) || /^\s*[[{]/.test(tpl.body);
    body = tpl.body.replace(TOKEN, (_all, svc: string | undefined, p: string | undefined, inject: string | undefined) => {
      if (svc) return service(svc);
      let v = param(p!);
      if (inject) v = injectInto(v, injectMap(inject, p!), inject, input.service!.name);
      if (typeof v === "string") return json ? JSON.stringify(v).slice(1, -1) : v;
      return typeof v === "number" || typeof v === "boolean" ? String(v) : JSON.stringify(v);
    });
    if (json) {
      try {
        JSON.parse(stripPlaceholdersForCheck(body));
      } catch (err) {
        throw new ToolError("invalid_request_note", `${noteName}: the body is not valid JSON after filling the parameters (${err instanceof Error ? err.message : String(err)}). Strings go inside quotes: "{{param:x}}"; numbers, booleans, objects and arrays go without quotes.`);
      }
    }
  }

  return { method: tpl.method, url, headers, body };
}

/** Value at a dotted path of the frontmatter. A key that itself contains dots wins over the path. */
export function serviceValue(frontmatter: Record<string, unknown>, path: string): unknown {
  if (Object.prototype.hasOwnProperty.call(frontmatter, path)) return frontmatter[path];
  let current: unknown = frontmatter;
  for (const part of path.split(".")) {
    if (current === null || typeof current !== "object" || Array.isArray(current)) return undefined;
    if (!Object.prototype.hasOwnProperty.call(current, part)) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/** Names of every secret placeholder anywhere in a service note (nested maps and lists included). */
export function servicePlaceholderNames(frontmatter: Record<string, unknown>): string[] {
  const names = new Set<string>();
  const walk = (v: unknown, depth: number): void => {
    if (depth > 8) return;
    if (typeof v === "string") for (const m of findPlaceholders(v)) names.add(m.name);
    else if (Array.isArray(v)) v.forEach((x) => walk(x, depth + 1));
    else if (v !== null && typeof v === "object") Object.values(v as Record<string, unknown>).forEach((x) => walk(x, depth + 1));
  };
  walk(frontmatter, 0);
  return [...names];
}

/** Parameters the body declares with |inject_service. */
function injectableParams(tpl: RequestTemplate): Set<string> {
  const out = new Set<string>();
  if (tpl.body === undefined) return out;
  for (const m of tpl.body.matchAll(TOKEN)) if (m[2] && m[3]) out.add(m[2]);
  return out;
}

function hasInjectLikeText(text: string): boolean {
  return /\{\{\s*inject\s*:/i.test(text);
}

/** Replaces every {{inject:key}} in the strings of `value` with the declared service value. */
function injectInto(value: unknown, map: Record<string, string>, mapPath: string, serviceName: string): unknown {
  const fill = (text: string): string => {
    const attempts = (text.match(INJECT_ATTEMPT) ?? []).length;
    if (attempts === 0) return text;
    const valid = [...text.matchAll(INJECT_MARKER)].length;
    if (attempts !== valid) throw new ToolError("invalid_argument", "Malformed {{inject:...}} marker. Use {{inject:<key>}} with a key of the service note map.");
    return text.replace(INJECT_MARKER, (_all, key: string) => {
      if (!Object.prototype.hasOwnProperty.call(map, key)) {
        throw new ToolError("invalid_argument", `"${key}" is not declared in "${mapPath}" of "${serviceName}". Declared keys: ${Object.keys(map).join(", ") || "(none)"}.`);
      }
      return map[key];
    });
  };
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return fill(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v !== null && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, item] of Object.entries(v as Record<string, unknown>)) {
        if (hasInjectLikeText(k)) throw new ToolError("invalid_argument", "{{inject:...}} markers may only appear in values, not in keys.");
        out[k] = walk(item);
      }
      return out;
    }
    return v;
  };
  return walk(value);
}

function assertWellFormedPlaceholders(text: string, where: string): void {
  if (!hasPlaceholderLikeText(text)) return;
  const attempts = (text.match(/\{\{\s*(secret|basic|bearer)\s*:/gi) ?? []).length;
  if (attempts !== findPlaceholders(text).length) {
    throw new ToolError("invalid_request_note", `${where} has a malformed placeholder. Use {{secret:NAME}}, {{basic:NAME}} or {{bearer:NAME}}.`);
  }
}

function resolveUrl(
  raw: string,
  service: (p: string) => string,
  param: (n: string) => unknown,
  params: Record<string, unknown>,
  noInject: (inject: string | undefined) => void,
): string {
  const q = raw.indexOf("?");
  const pathPart = q < 0 ? raw : raw.slice(0, q);
  const queryPart = q < 0 ? "" : raw.slice(q + 1);
  const fill = (text: string) =>
    text.replace(TOKEN, (_all, svc: string | undefined, p: string | undefined, inject: string | undefined) => {
      if (svc) return service(svc);
      noInject(inject);
      return encodeURIComponent(scalar(param(p!), p!));
    });

  const path = fill(pathPart);
  if (!queryPart) return path;

  const pairs: string[] = [];
  for (const pair of queryPart.split("&")) {
    if (!pair) continue;
    const eq = pair.indexOf("=");
    const key = eq < 0 ? pair : pair.slice(0, eq);
    const value = eq < 0 ? "" : pair.slice(eq + 1);
    // An optional parameter that was not given drops the whole query pair.
    const exact = EXACT_PARAM.exec(value);
    if (exact && (params[exact[1]] === undefined || params[exact[1]] === null)) continue;
    pairs.push(eq < 0 ? fill(key) : `${fill(key)}=${fill(value)}`);
  }
  return pairs.length ? `${path}?${pairs.join("&")}` : path;
}

function scalar(v: unknown, name: string): string {
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return v.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(",");
  throw new ToolError("invalid_argument", `Argument "${name}" is an object and cannot go in the URL or a header.`);
}

/** Secret placeholders are not JSON; replace them with a string so the JSON check still works. */
function stripPlaceholdersForCheck(body: string): string {
  return body.replace(/\{\{\s*(secret|basic|bearer)\s*:[^}]*\}\}/gi, "x");
}
