// Vault tools: MCP tools defined by notes in the user's vault.
// Everything here is independent of the Obsidian API so it can be unit tested.

/** A note as the tools feature sees it. Found by tag and by name, never by folder. */
export interface VaultNote {
  /** Vault-relative path, e.g. "APIs/Jira - Get issue.md". */
  path: string;
  /** File name without ".md". */
  name: string;
  frontmatter: Record<string, unknown>;
  /** Lower-case tags without "#", from the frontmatter and the body. */
  tags: string[];
}

export interface VaultNoteWithBody extends VaultNote {
  body: string;
}

/** Read access to the vault. The Obsidian implementation lives in obsidianSource.ts. */
export interface NoteSource {
  /** Notes that carry the tag or one of its subtags. */
  byTag(tag: string): VaultNote[];
  /** Resolves "[[Name]]", "[[Name|alias]]", "Name" or a path, relative to `fromPath` like Obsidian links. */
  resolve(ref: string, fromPath?: string): VaultNote | undefined;
  /** Note text without the frontmatter. */
  read(note: VaultNote): Promise<string>;
}

export type ParamType = "string" | "number" | "integer" | "boolean" | "object" | "array";

export interface ParamSpec {
  type: ParamType;
  required: boolean;
  description?: string;
  enum?: Array<string | number>;
  default?: unknown;
}

export type ToolKind = "request" | "script";

export type ToolStatus = "ready" | "scripts-disabled" | "invalid";

export interface ToolEntry {
  /** Tool name as the AI sees it. For an invalid note without a usable name, the note name. */
  name: string;
  title: string;
  description: string;
  kind: ToolKind | null;
  params: Record<string, ParamSpec>;
  writes: boolean;
  expose: boolean;
  notePath: string;
  noteName: string;
  /** kind: request — the request note reference as written in the frontmatter. */
  request?: string;
  /** Optional service note that overrides the one in the request note. */
  service?: string;
  /**
   * Generic tools: the service note is chosen at call time among the notes with this tag
   * (one note per instance/account). The argument `serviceParam` picks one of `serviceChoices`.
   */
  serviceTag?: string;
  serviceParam?: string;
  /** Notes with this tag are left out of the choices (e.g. templates). */
  serviceExcludeTag?: string;
  /** Filled by the registry from the notes with serviceTag. */
  serviceChoices?: ServiceChoice[];
  /** kind: script — the code of the ```js block. */
  code?: string;
  status: ToolStatus;
  problems: string[];
  warnings: string[];
}

/** One instance a generic tool can run against. */
export interface ServiceChoice {
  /** What the AI passes, e.g. "Acme" for the note "Jira - Acme". */
  id: string;
  notePath: string;
  noteName: string;
}

export const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
export const PARAM_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

/** Built-in MCP tools. A vault tool may not use these names. */
export const RESERVED_TOOL_NAMES = new Set([
  "list_secrets",
  "http_request",
  "get_tool_authoring_guide",
  "list_vault_tools",
  "run_vault_tool",
]);

export type ToolErrorCode =
  | "tools_disabled"
  | "unknown_tool"
  | "invalid_tool"
  | "invalid_argument"
  | "invalid_request_note"
  | "note_not_found"
  | "scripts_disabled"
  | "denied"
  | "script_error"
  | "timeout"
  | "request_failed";

/** An error meant for the AI client: the message says what to fix. */
export class ToolError extends Error {
  constructor(
    public readonly code: ToolErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ToolError";
  }
}

/** Normalizes a tag for comparison: no "#", lower case, no surrounding slashes or spaces. */
export function normalizeTag(tag: string): string {
  return tag.trim().replace(/^#/, "").replace(/^\/+|\/+$/g, "").toLowerCase();
}

export function hasTag(tags: string[], wanted: string): boolean {
  const w = normalizeTag(wanted);
  if (!w) return false;
  return tags.some((raw) => {
    const t = normalizeTag(raw);
    return t === w || t.startsWith(w + "/");
  });
}

/** "[[Name|alias]]" → "Name", "[[Name#Heading]]" → "Name", "Name" → "Name". */
export function linkTarget(ref: string): string {
  let s = ref.trim();
  const m = /^!?\[\[([\s\S]*)\]\]$/.exec(s);
  if (m) s = m[1];
  s = s.split("|")[0];
  s = s.split("#")[0];
  return s.trim();
}
