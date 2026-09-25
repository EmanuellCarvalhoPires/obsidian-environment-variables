// Request notes: a saved HTTP request (like in Postman) in a ```http block.
//
//   ```http
//   GET {{service.url}}/rest/api/3/issue/{{param:key}}?fields={{param:fields}}
//   Authorization: {{service.auth}}
//   Accept: application/json
//   ```
//
// {{service.<property>}} comes from the frontmatter of the linked service note and is inserted as is,
// so it may hold secret placeholders such as {{basic:JIRA_ACME}}. {{param:<name>}} comes from the tool
// call and is encoded for where it lands. Secret placeholders are resolved later by the broker, which
// keeps enforcing hosts, placement and approval.

import { hasPlaceholderLikeText } from "../engine/placeholders";
import { RequestInput } from "../engine/prepare";
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
const TOKEN = /\{\{\s*(?:service\.([A-Za-z0-9_-]+)|param:([A-Za-z_][A-Za-z0-9_]*))\s*\}\}/g;
const EXACT_PARAM = /^\{\{\s*param:([A-Za-z_][A-Za-z0-9_]*)\s*\}\}$/;

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
  for (const [k, v] of Object.entries(input.params)) {
    const text = typeof v === "string" ? v : v !== null && typeof v === "object" ? JSON.stringify(v) : "";
    if (hasPlaceholderLikeText(text)) {
      throw new ToolError("invalid_argument", `Argument "${k}" contains a secret placeholder. Placeholders may only come from service or request notes.`);
    }
  }

  const service = (prop: string): string => {
    if (!input.service) {
      throw new ToolError("invalid_request_note", `${noteName} uses {{service.${prop}}} but no service note is linked. Set service: "[[...]]" in the request note or in the tool note.`);
    }
    const value = input.service.frontmatter[prop];
    if (value === undefined || value === null || value === "") {
      throw new ToolError("invalid_request_note", `Service note "${input.service.name}" has no property "${prop}".`);
    }
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
      throw new ToolError("invalid_request_note", `Property "${prop}" of "${input.service.name}" must be text or a number.`);
    }
    return String(value);
  };
  const param = (name: string): unknown => {
    const v = input.params[name];
    if (v === undefined || v === null) throw new ToolError("invalid_argument", `${noteName} needs a value for {{param:${name}}}.`);
    return v;
  };

  const url = resolveUrl(tpl.url, service, param, input.params);

  const headers: Record<string, string> = {};
  for (const [name, raw] of tpl.headers) {
    const value = raw.replace(TOKEN, (_all, svc: string | undefined, p: string | undefined) => (svc ? service(svc) : scalar(param(p!), p!)));
    if (/[\r\n]/.test(value)) throw new ToolError("invalid_argument", `Header ${name} would contain a line break.`);
    headers[name] = value;
  }

  let body: string | undefined;
  if (tpl.body !== undefined) {
    const contentType = Object.entries(headers).find(([k]) => k.toLowerCase() === "content-type")?.[1] ?? "";
    const json = /json/i.test(contentType) || /^\s*[[{]/.test(tpl.body);
    body = tpl.body.replace(TOKEN, (_all, svc: string | undefined, p: string | undefined) => {
      if (svc) return service(svc);
      const v = param(p!);
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

function resolveUrl(raw: string, service: (p: string) => string, param: (n: string) => unknown, params: Record<string, unknown>): string {
  const q = raw.indexOf("?");
  const pathPart = q < 0 ? raw : raw.slice(0, q);
  const queryPart = q < 0 ? "" : raw.slice(q + 1);

  const path = pathPart.replace(TOKEN, (_all, svc: string | undefined, p: string | undefined) =>
    svc ? service(svc) : encodeURIComponent(scalar(param(p!), p!)),
  );
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
    const fill = (text: string) =>
      text.replace(TOKEN, (_all, svc: string | undefined, p: string | undefined) => (svc ? service(svc) : encodeURIComponent(scalar(param(p!), p!))));
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
