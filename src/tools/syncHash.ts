import { createHash } from "crypto";

/**
 * Computes a deterministic SHA-256 hash of a list of tools and instances in stable order.
 * Ensures that identical inputs with different array or key orders produce the exact same hash.
 */
export function computeSyncHash(input: unknown): string {
  const normalized = normalizeForHash(input);
  const json = JSON.stringify(normalized);
  return createHash("sha256").update(json).digest("hex");
}

/**
 * Checks whether tools and instances have changed since the last sync.
 * Returns whether synchronization should proceed and the new hash.
 */
export function shouldSyncTools(lastHash: string | null, tools: unknown): { shouldSync: boolean; hash: string } {
  const hash = computeSyncHash(tools);
  return {
    shouldSync: hash !== lastHash,
    hash,
  };
}

function normalizeForHash(val: unknown): unknown {
  if (val === null || typeof val !== "object") {
    return val;
  }

  if (Array.isArray(val)) {
    const normalizedItems = val.map(normalizeForHash);
    return normalizedItems.sort((a, b) => {
      const keyA = sortKey(a);
      const keyB = sortKey(b);
      return keyA.localeCompare(keyB);
    });
  }

  const obj = val as Record<string, unknown>;
  const sortedKeys = Object.keys(obj).sort();
  const result: Record<string, unknown> = {};

  for (const k of sortedKeys) {
    if (obj[k] !== undefined && typeof obj[k] !== "function") {
      result[k] = normalizeForHash(obj[k]);
    }
  }

  return result;
}

function sortKey(item: unknown): string {
  if (item === null || item === undefined) return "";
  if (typeof item === "string") return item;
  if (typeof item === "number" || typeof item === "boolean" || typeof item === "bigint" || typeof item === "symbol") return String(item);
  if (typeof item === "object") {
    const obj = item as Record<string, unknown>;
    if (typeof obj.name === "string") return obj.name;
    if (typeof obj.id === "string") return obj.id;
    if (typeof obj.notePath === "string") return obj.notePath;
    if (typeof obj.noteName === "string") return obj.noteName;
    return JSON.stringify(item);
  }
  return "";
}
