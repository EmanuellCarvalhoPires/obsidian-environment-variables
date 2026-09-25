// Each vault runs its own server: its own port, its own MCP server name in the AI clients, its own
// secrets and client tokens. This file gives a vault a stable identity for that.

import { createHash } from "crypto";
import { MCP_SERVER_NAME } from "../integrations/integrations";

/** MCP server names accepted by Claude Code, Codex (TOML bare keys), Cursor and Antigravity. */
export const SERVER_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** Stable, non-reversible id of a vault, from its folder on disk. Shown on /v1/health. */
export function vaultIdOf(basePath: string): string {
  return createHash("sha256").update(basePath.replace(/\\/g, "/").toLowerCase()).digest("hex").slice(0, 16);
}

/** "Work Notes" → "work-notes", "Café Ação" → "cafe-acao". Falls back to the vault id. */
export function slugOf(vaultName: string, vaultId: string): string {
  const slug = vaultName
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return slug || vaultId.slice(0, 8);
}

/** Default MCP server name of a vault, e.g. "environment-variables-work-notes". */
export function serverNameFor(vaultName: string, vaultId: string): string {
  return `${MCP_SERVER_NAME}-${slugOf(vaultName, vaultId)}`;
}
