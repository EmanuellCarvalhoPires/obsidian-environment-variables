import { SecretRecord } from "../store/types";

export type PlaceholderKind = "secret" | "basic" | "bearer";

export interface PlaceholderMatch {
  raw: string;
  kind: PlaceholderKind;
  name: string;
  field?: string;
  index: number;
}

/** {{secret:NAME}}, {{secret:NAME.field}}, {{basic:NAME}}, {{bearer:NAME}} */
export const PLACEHOLDER_SOURCE = String.raw`\{\{\s*(secret|basic|bearer)\s*:\s*([A-Za-z_][A-Za-z0-9_]*)(?:\.([A-Za-z_]+))?\s*\}\}`;

export function placeholderRegex(): RegExp {
  return new RegExp(PLACEHOLDER_SOURCE, "g");
}

export function findPlaceholders(text: string): PlaceholderMatch[] {
  const out: PlaceholderMatch[] = [];
  for (const m of text.matchAll(placeholderRegex())) {
    out.push({ raw: m[0], kind: m[1] as PlaceholderKind, name: m[2], field: m[3], index: m.index ?? 0 });
  }
  return out;
}

/** True when the text contains "{{" that looks like an attempt at a placeholder, valid or not. */
export function hasPlaceholderLikeText(text: string): boolean {
  return /\{\{\s*(secret|basic|bearer)\s*:/i.test(text);
}

export class PlaceholderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlaceholderError";
  }
}

const USER_FIELDS = new Set(["user", "username", "email"]);
const VALUE_FIELDS = new Set(["value", "token", "password"]);

export function resolvePlaceholder(match: PlaceholderMatch, secret: SecretRecord): string {
  switch (match.kind) {
    case "basic": {
      if (!secret.username) throw new PlaceholderError(`${secret.name} has no username, so {{basic:${secret.name}}} cannot be built.`);
      return "Basic " + utf8ToBase64(`${secret.username}:${secret.value}`);
    }
    case "bearer":
      return "Bearer " + secret.value;
    case "secret": {
      if (!match.field || VALUE_FIELDS.has(match.field)) return secret.value;
      if (USER_FIELDS.has(match.field)) {
        if (!secret.username) throw new PlaceholderError(`${secret.name} has no username.`);
        return secret.username;
      }
      throw new PlaceholderError(`Unknown field "${match.field}". Use .user or .token.`);
    }
  }
}

export function utf8ToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}
