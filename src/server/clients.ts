// AI client tokens. A client token only grants the right to *use* secrets through
// the broker, never to read them. Only a SHA-256 hash is stored.

import type { IntegrationId } from "../integrations/integrations";

/**
 * Which variables a client may use. "all" includes variables created later.
 * "some" lists secret ids (random, kept outside the encrypted file) so names stay private while locked.
 */
export type ClientAccess = { mode: "all" } | { mode: "some"; secretIds: string[] };

/** What the broker needs to know about the caller. */
export interface ClientContext {
  id: string;
  name: string;
  access: ClientAccess;
}

export function canUse(access: ClientAccess, secretId: string): boolean {
  return access.mode === "all" || access.secretIds.includes(secretId);
}

export function describeAccess(access: ClientAccess): string {
  return access.mode === "all" ? "all" : String(access.secretIds.length);
}

export interface ClientRecord {
  id: string;
  name: string;
  tokenHash: string;
  /** First characters of the token, to help the user recognize it. */
  hint: string;
  createdAt: string;
  lastUsedAt?: string;
  /** Set when the plugin registered this token in an AI client automatically. */
  integration?: IntegrationId;
  /** Least privilege: which variables this client may use. Missing only in data from 0.1.0. */
  access?: ClientAccess;
}

/** Clients created by 0.1.0 had no access list and could use everything; keep that until edited. */
export function accessOf(client: ClientRecord): ClientAccess {
  return client.access ?? { mode: "all" };
}

export function contextOf(client: ClientRecord): ClientContext {
  return { id: client.id, name: client.name, access: accessOf(client) };
}

export const TOKEN_PREFIX = "evc_";

export function generateToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return TOKEN_PREFIX + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function createClient(
  name: string,
  access: ClientAccess,
  integration?: IntegrationId,
): Promise<{ record: ClientRecord; token: string }> {
  const token = generateToken();
  const idBytes = new Uint8Array(8);
  crypto.getRandomValues(idBytes);
  const record: ClientRecord = {
    id: Array.from(idBytes, (b) => b.toString(16).padStart(2, "0")).join(""),
    name: name.trim() || "AI client",
    tokenHash: await hashToken(token),
    hint: token.slice(0, TOKEN_PREFIX.length + 6),
    createdAt: new Date().toISOString(),
    integration,
    access,
  };
  return { record, token };
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function findClient(clients: ClientRecord[], token: string): Promise<ClientRecord | undefined> {
  if (!token.startsWith(TOKEN_PREFIX)) return undefined;
  const hash = await hashToken(token);
  return clients.find((c) => constantTimeEqual(c.tokenHash, hash));
}
