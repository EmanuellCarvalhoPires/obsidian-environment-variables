// Parses a tool note (frontmatter + body) into a tool entry, collecting every problem
// instead of stopping at the first one, so the AI or the user can fix them all at once.

import { PARAM_NAME_PATTERN, ParamSpec, ParamType, RESERVED_TOOL_NAMES, TOOL_NAME_PATTERN, ToolEntry, ToolKind, VaultNoteWithBody } from "./types";

const PARAM_TYPES: ParamType[] = ["string", "number", "integer", "boolean", "object", "array"];
const KNOWN_KEYS = new Set([
  "tool",
  "title",
  "description",
  "kind",
  "request",
  "service",
  "service_tag",
  "service_param",
  "service_exclude_tag",
  "params",
  "writes",
  "expose",
  "enabled",
  // Obsidian and vault conventions that may sit next to the tool fields.
  "tags",
  "aliases",
  "cssclasses",
  "up",
]);

export type ParsedTool = Omit<ToolEntry, "status">;

export function parseToolNote(note: VaultNoteWithBody): ParsedTool {
  const fm = note.frontmatter ?? {};
  const problems: string[] = [];
  const warnings: string[] = [];

  const rawName = fm.tool;
  let name = note.name;
  if (typeof rawName !== "string" || !rawName.trim()) {
    problems.push('Missing "tool": the tool name, e.g. tool: jira_get_issue.');
  } else {
    name = rawName.trim();
    if (!TOOL_NAME_PATTERN.test(name)) {
      problems.push(`Invalid tool name "${name}". Use lower case letters, digits and "_", starting with a letter (max. 64).`);
    } else if (RESERVED_TOOL_NAMES.has(name)) {
      problems.push(`"${name}" is reserved for a built-in tool. Choose another name.`);
    }
  }

  const description = typeof fm.description === "string" ? fm.description.trim() : "";
  if (!description) problems.push('Missing "description": explain what the tool does and when to use it.');

  const code = extractCodeBlock(note.body, ["js", "javascript"]);
  let kind: ToolKind | null = null;
  if (fm.kind === "request" || fm.kind === "script") kind = fm.kind;
  else if (fm.kind !== undefined) problems.push(`Invalid kind ${JSON.stringify(fm.kind)}. Use "request" or "script".`);
  else if (typeof fm.request === "string") kind = "request";
  else if (code !== null) kind = "script";
  else problems.push('Missing "kind": use "request" (runs a request note) or "script" (runs the ```js block of this note).');
  if (fm.kind === undefined && kind) warnings.push(`"kind" is missing; assumed "${kind}". Write it explicitly.`);

  let request: string | undefined;
  if (kind === "request") {
    if (typeof fm.request !== "string" || !fm.request.trim()) problems.push('kind: request needs "request": a link to the request note, e.g. request: "[[Jira - Get issue]]".');
    else request = fm.request.trim();
    if (code !== null) warnings.push("This note has a ```js block, but kind is request: the code is ignored.");
  }
  if (kind === "script" && code === null) problems.push("kind: script needs a ```js code block in the body of the note.");
  if (kind === "script" && code !== null) problems.push(...checkScript(code));

  let service: string | undefined;
  if (fm.service !== undefined) {
    if (typeof fm.service === "string" && fm.service.trim()) service = fm.service.trim();
    else problems.push('"service" must be a link to a service note, e.g. service: "[[Jira - ACME]]".');
  }

  const params = parseParams(fm.params, problems);

  // Generic tools: one service note per instance, chosen by an argument at call time.
  let serviceTag: string | undefined;
  let serviceParam: string | undefined;
  let serviceExcludeTag: string | undefined;
  if (fm.service_tag !== undefined) {
    if (typeof fm.service_tag === "string" && fm.service_tag.trim()) serviceTag = fm.service_tag.trim().replace(/^#/, "");
    else problems.push('"service_tag" must be the tag of the service notes, e.g. service_tag: jira/instancia.');
    if (service) problems.push('Use either "service" (one fixed service note) or "service_tag" (the service is chosen at call time), not both.');
    const p = fm.service_param ?? "instance";
    if (typeof p !== "string" || !PARAM_NAME_PATTERN.test(p)) problems.push('"service_param" must be a parameter name, e.g. service_param: instancia.');
    else if (params[p]) problems.push(`"service_param" is "${p}", which is also in "params". The plugin creates this parameter by itself: remove it from "params".`);
    else serviceParam = p;
    if (fm.service_exclude_tag !== undefined) {
      if (typeof fm.service_exclude_tag === "string" && fm.service_exclude_tag.trim()) serviceExcludeTag = fm.service_exclude_tag.trim().replace(/^#/, "");
      else problems.push('"service_exclude_tag" must be a tag, e.g. service_exclude_tag: molde.');
    }
  } else if (fm.service_param !== undefined || fm.service_exclude_tag !== undefined) {
    problems.push('"service_param" and "service_exclude_tag" only work together with "service_tag".');
  }

  const writes = fm.writes === true;
  if (fm.writes !== undefined && typeof fm.writes !== "boolean") problems.push('"writes" must be true or false.');
  const expose = fm.expose !== false;
  if (fm.expose !== undefined && typeof fm.expose !== "boolean") problems.push('"expose" must be true or false.');
  if (fm.enabled === false) problems.push("Disabled in the note (enabled: false).");

  for (const key of Object.keys(fm)) {
    if (!KNOWN_KEYS.has(key)) warnings.push(`Unknown property "${key}" is ignored.`);
  }

  const title = typeof fm.title === "string" && fm.title.trim() ? fm.title.trim() : note.name;

  return {
    name,
    title,
    description,
    kind,
    params,
    writes,
    expose,
    notePath: note.path,
    noteName: note.name,
    request,
    service,
    serviceTag,
    serviceParam,
    serviceExcludeTag,
    code: kind === "script" && code !== null ? code : undefined,
    problems,
    warnings,
  };
}

function parseParams(raw: unknown, problems: string[]): Record<string, ParamSpec> {
  const out: Record<string, ParamSpec> = {};
  if (raw === undefined || raw === null) return out;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    problems.push('"params" must be a map: params: { key: { type: string, required: true, description: "..." } }.');
    return out;
  }
  for (const [name, spec] of Object.entries(raw as Record<string, unknown>)) {
    if (!PARAM_NAME_PATTERN.test(name)) {
      problems.push(`Invalid parameter name "${name}". Use letters, digits and "_".`);
      continue;
    }
    // Shorthand: `key: string` means an optional parameter of that type.
    const s: Record<string, unknown> = typeof spec === "string" ? { type: spec } : (spec as Record<string, unknown>);
    if (!s || typeof s !== "object" || Array.isArray(s)) {
      problems.push(`Parameter "${name}" must be a map with at least "type".`);
      continue;
    }
    const type = s.type as ParamType;
    if (!PARAM_TYPES.includes(type)) {
      problems.push(`Parameter "${name}": invalid type "${String(s.type)}". Use ${PARAM_TYPES.join(", ")}.`);
      continue;
    }
    const p: ParamSpec = { type, required: s.required === true };
    if (typeof s.description === "string") p.description = s.description;
    if (s.enum !== undefined) {
      if (Array.isArray(s.enum) && s.enum.every((v) => typeof v === "string" || typeof v === "number")) p.enum = s.enum;
      else problems.push(`Parameter "${name}": "enum" must be a list of strings or numbers.`);
    }
    if (s.default !== undefined) {
      const err = checkValue(p, s.default);
      if (err) problems.push(`Parameter "${name}": default ${err}`);
      else p.default = s.default;
    }
    out[name] = p;
  }
  return out;
}

/** First fenced code block whose language is one of `langs`, or null. */
export function extractCodeBlock(body: string, langs: string[]): string | null {
  const re = /^(```+|~~~+)[ \t]*([A-Za-z0-9_+-]*)[^\n]*\n([\s\S]*?)^\1[ \t]*$/gm;
  for (const m of body.matchAll(re)) {
    if (langs.includes(m[2].toLowerCase())) return m[3].replace(/\n$/, "");
  }
  return null;
}

/** Static checks that catch the most common mistakes before the script ever runs. */
function checkScript(code: string): string[] {
  const out: string[] = [];
  if (!/\bexport\s+default\b/.test(code)) out.push("The ```js block must export the tool function: export default async function (ctx) { ... }");
  if (/^\s*import\s[^(]/m.test(code) || /\bimport\s*\(/.test(code)) out.push("Scripts cannot import modules. Use the ctx API instead.");
  if (/\brequire\s*\(/.test(code)) out.push("Scripts cannot use require(). Use the ctx API instead.");
  return out;
}

/** Returns an error message, or null when the value matches the parameter spec. */
export function checkValue(spec: ParamSpec, value: unknown): string | null {
  const ok = (() => {
    switch (spec.type) {
      case "string":
        return typeof value === "string";
      case "number":
        return typeof value === "number" && Number.isFinite(value);
      case "integer":
        return typeof value === "number" && Number.isInteger(value);
      case "boolean":
        return typeof value === "boolean";
      case "object":
        return typeof value === "object" && value !== null && !Array.isArray(value);
      case "array":
        return Array.isArray(value);
    }
  })();
  if (!ok) return `must be of type ${spec.type}.`;
  if (spec.enum && !spec.enum.includes(value as string | number)) return `must be one of: ${spec.enum.join(", ")}.`;
  return null;
}

/** Validates the arguments of a call and applies defaults. Unknown arguments are rejected. */
export function validateArgs(params: Record<string, ParamSpec>, args: unknown): { ok: true; args: Record<string, unknown> } | { ok: false; message: string } {
  const input = args === undefined || args === null ? {} : args;
  if (typeof input !== "object" || Array.isArray(input)) return { ok: false, message: "arguments must be an object." };
  const out: Record<string, unknown> = {};
  const errors: string[] = [];
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    const spec = params[key];
    if (!spec) {
      errors.push(`Unknown argument "${key}". Expected: ${Object.keys(params).join(", ") || "none"}.`);
      continue;
    }
    if (value === undefined || value === null) continue;
    const err = checkValue(spec, value);
    if (err) errors.push(`"${key}" ${err}`);
    else out[key] = value;
  }
  for (const [key, spec] of Object.entries(params)) {
    if (out[key] !== undefined) continue;
    if (spec.default !== undefined) out[key] = spec.default;
    else if (spec.required) errors.push(`Missing required argument "${key}".`);
  }
  return errors.length ? { ok: false, message: errors.join(" ") } : { ok: true, args: out };
}

/** JSON Schema for the MCP inputSchema. */
export function inputSchema(params: Record<string, ParamSpec>): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [name, p] of Object.entries(params)) {
    const prop: Record<string, unknown> = { type: p.type };
    if (p.description) prop.description = p.description;
    if (p.enum) prop.enum = p.enum;
    if (p.default !== undefined) prop.default = p.default;
    properties[name] = prop;
    if (p.required && p.default === undefined) required.push(name);
  }
  const schema: Record<string, unknown> = { type: "object", properties, additionalProperties: false };
  if (required.length) schema.required = required;
  return schema;
}

