// Response shaping for HTTP requests: field projection and parsing of field lists.

import { ToolError } from "./types";

/**
 * Parses a comma-separated list of field paths.
 * Trims whitespace and discards empty entries.
 * Returns undefined when text is undefined.
 * Throws ToolError("invalid_argument") for any other non-string type.
 */
export function parseFieldList(text: unknown): string[] | undefined {
  if (text === undefined) return undefined;
  if (typeof text !== "string") {
    throw new ToolError("invalid_argument", 'Argument "fields" must be a string.');
  }
  return text
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Splits the generic `max_chars` argument off the arguments of a request tool: no tool declares it,
 * every request tool accepts it. Throws ToolError("invalid_argument") when it is not an integer from 1 to 1000000.
 */
export function takeMaxChars(rawArgs: unknown): { args: unknown; maxChars?: number } {
  if (typeof rawArgs !== "object" || rawArgs === null || Array.isArray(rawArgs) || !("max_chars" in rawArgs)) return { args: rawArgs };
  const { max_chars: maxChars, ...rest } = rawArgs as Record<string, unknown>;
  if (maxChars === undefined || maxChars === null) return { args: rest };
  if (typeof maxChars !== "number" || !Number.isInteger(maxChars) || maxChars < 1 || maxChars > 1000000) {
    throw new ToolError("invalid_argument", 'Argument "max_chars" must be an integer between 1 and 1000000.');
  }
  return { args: rest, maxChars };
}

/** Cuts a response that is longer than `maxChars` characters: the JSON becomes text, cut, with truncated and total_chars set. */
export function limitResponse<T extends { json?: unknown; body?: string; truncated: boolean }>(res: T, maxChars: number): T & { total_chars?: number } {
  const text = res.json !== undefined ? JSON.stringify(res.json) : res.body;
  if (text === undefined || text.length <= maxChars) return res;
  const { json: _json, ...rest } = res;
  return { ...rest, body: text.slice(0, maxChars), truncated: true, total_chars: text.length } as T & { total_chars?: number };
}

/**
 * Sets a value at the specified path segments in the target object.
 * Creates intermediate objects as needed.
 */
function setDeep(target: Record<string, unknown>, segments: string[], value: unknown): void {
  let curr: Record<string, unknown> = target;
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i];
    if (curr[seg] === undefined || curr[seg] === null || typeof curr[seg] !== "object" || Array.isArray(curr[seg])) {
      curr[seg] = {};
    }
    curr = curr[seg] as Record<string, unknown>;
  }
  const lastSeg = segments[segments.length - 1];
  curr[lastSeg] = value;
}

/**
 * Projects specified field paths from an object.
 * Nonexistent paths resolve to null without error.
 * Paths traversing an array return the entire array.
 */
export function projectFields(obj: unknown, fields: string[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const rawPath of fields) {
    const trimmed = rawPath.trim();
    if (!trimmed) continue;
    const segments = trimmed.split(".").filter(Boolean);
    if (segments.length === 0) continue;

    let current: unknown = obj;
    let targetSegments = segments;
    let foundValue: unknown = null;

    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      if (current === null || current === undefined || typeof current !== "object") {
        foundValue = null;
        targetSegments = segments;
        break;
      }
      const next: unknown = (current as Record<string, unknown>)[seg];
      if (Array.isArray(next)) {
        // Path passed into or through an array: return the entire array
        foundValue = next;
        targetSegments = segments.slice(0, i + 1);
        break;
      }
      if (i === segments.length - 1) {
        foundValue = next === undefined ? null : next;
        targetSegments = segments;
      } else {
        current = next;
      }
    }

    setDeep(result, targetSegments, foundValue);
  }

  return result;
}
