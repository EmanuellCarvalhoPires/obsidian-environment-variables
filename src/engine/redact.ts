import { SecretRecord } from "../store/types";
import { utf8ToBase64 } from "./placeholders";

export const REDACTED = "***";

/** Full values shorter than this are not masked (too likely to hit normal text). */
const MIN_REDACT_LENGTH = 4;
/** Partial matching: any run of PARTIAL_WINDOW consecutive characters of a secret is masked... */
export const PARTIAL_WINDOW = 12;
/** ...but only for secrets at least this long, so short values do not over-mask. */
const PARTIAL_MIN_SECRET = 16;

export interface RedactResult {
  text: string;
  count: number;
}

export interface Redactor {
  redact(text: string): RedactResult;
}

// ---------- encodings ----------

const encoder = new TextEncoder();

function toHex(text: string): string {
  return Array.from(encoder.encode(text), (b) => b.toString(16).padStart(2, "0")).join("");
}

function lowerPercent(text: string): string {
  return text.replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase());
}

/** Percent-encodes every byte, as some clients and logs do. */
function percentAll(text: string): string {
  return Array.from(encoder.encode(text), (b) => "%" + b.toString(16).toUpperCase().padStart(2, "0")).join("");
}

function base64Url(b64: string): string {
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function stripPadding(b64: string): string {
  return b64.replace(/=+$/, "");
}

/** Every form in which a value could appear in a response, a log or an error message. */
export function encodingsOf(value: string): string[] {
  const b64 = utf8ToBase64(value);
  const uri = encodeURIComponent(value);
  const form = uri.replace(/%20/g, "+");
  const all = percentAll(value);
  const hex = toHex(value);
  return [
    value,
    b64,
    stripPadding(b64),
    base64Url(b64),
    uri,
    lowerPercent(uri),
    form,
    lowerPercent(form),
    all,
    all.toLowerCase(),
    hex,
    hex.toUpperCase(),
    JSON.stringify(value).slice(1, -1),
  ];
}

/** Full-match variants for a set of secrets, longest first. */
export function redactionVariants(secrets: SecretRecord[]): string[] {
  const variants = new Set<string>();
  for (const s of secrets) {
    for (const v of encodingsOf(s.value)) variants.add(v);
    if (s.username) {
      const basic = utf8ToBase64(`${s.username}:${s.value}`);
      for (const v of [basic, stripPadding(basic), base64Url(basic)]) variants.add(v);
    }
  }
  return [...variants].filter((x) => x.length >= MIN_REDACT_LENGTH).sort((a, b) => b.length - a.length);
}

/** Strings whose fragments are also masked: the raw value and its Basic auth base64 form. */
function partialSources(secrets: SecretRecord[]): string[] {
  const out: string[] = [];
  for (const s of secrets) {
    if (s.value.length >= PARTIAL_MIN_SECRET) out.push(s.value, stripPadding(utf8ToBase64(s.value)));
    if (s.username) {
      const basic = stripPadding(utf8ToBase64(`${s.username}:${s.value}`));
      if (basic.length >= PARTIAL_MIN_SECRET) out.push(basic);
    }
  }
  return out;
}

// ---------- matching ----------

export function redactText(text: string, variants: string[]): RedactResult {
  let count = 0;
  let out = text;
  for (const v of variants) {
    if (!out.includes(v)) continue;
    const parts = out.split(v);
    count += parts.length - 1;
    out = parts.join(REDACTED);
  }
  return { text: out, count };
}

const BASE = 257;
const MOD = 2_147_483_629; // prime below 2^31

function hashWindow(text: string, start: number, length: number): number {
  let h = 0;
  for (let i = 0; i < length; i++) h = (h * BASE + text.charCodeAt(start + i)) % MOD;
  return h;
}

/**
 * Masks any run of PARTIAL_WINDOW or more consecutive characters taken from a secret.
 * Catches truncated tokens in upstream error messages ("invalid token ATATT3xFfGF0...").
 * Rabin-Karp rolling hash keeps this linear in the size of the text.
 */
function redactPartials(text: string, sources: string[]): RedactResult {
  const k = PARTIAL_WINDOW;
  if (sources.length === 0 || text.length < k) return { text, count: 0 };

  const windows = new Map<number, string[]>();
  for (const src of sources) {
    for (let i = 0; i + k <= src.length; i++) {
      const w = src.slice(i, i + k);
      const h = hashWindow(w, 0, k);
      const bucket = windows.get(h);
      if (!bucket) windows.set(h, [w]);
      else if (!bucket.includes(w)) bucket.push(w);
    }
  }

  let high = 1; // BASE^(k-1) mod MOD
  for (let i = 0; i < k - 1; i++) high = (high * BASE) % MOD;

  const hits: Array<[number, number]> = [];
  let h = hashWindow(text, 0, k);
  for (let i = 0; ; i++) {
    const bucket = windows.get(h);
    if (bucket && bucket.includes(text.slice(i, i + k))) {
      const last = hits[hits.length - 1];
      if (last && i <= last[1]) last[1] = i + k;
      else hits.push([i, i + k]);
    }
    if (i + k >= text.length) break;
    h = (h - ((text.charCodeAt(i) * high) % MOD) + MOD) % MOD;
    h = (h * BASE + text.charCodeAt(i + k)) % MOD;
  }
  if (hits.length === 0) return { text, count: 0 };

  let out = "";
  let last = 0;
  for (const [start, end] of hits) {
    out += text.slice(last, start) + REDACTED;
    last = end;
  }
  return { text: out + text.slice(last), count: hits.length };
}

/** Full variants first, then fragments. Use it on everything that leaves the plugin or is logged. */
export function createRedactor(secrets: SecretRecord[]): Redactor {
  const variants = redactionVariants(secrets);
  const sources = partialSources(secrets);
  return {
    redact(text: string): RedactResult {
      if (!text) return { text, count: 0 };
      const full = redactText(text, variants);
      const partial = redactPartials(full.text, sources);
      return { text: partial.text, count: full.count + partial.count };
    },
  };
}
