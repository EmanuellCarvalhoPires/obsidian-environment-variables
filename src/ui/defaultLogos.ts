// Default logos for downloadable MCP packages, bundled from defaultLogos.json.
// Source: the user's vault (Anexos/Logos/Atlassian), the Atlassian brand icon set.
// Keyed by the "logo" id a package's manifest names; unknown ids fall back to a generic icon.

import logos from "./defaultLogos.json";

export const DEFAULT_MCP_LOGOS: Record<string, string> = logos;

/** The bundled logo for a package's `logo` id, or "" (generic icon) when there is none. */
export function defaultLogoFor(id: string): string {
  return DEFAULT_MCP_LOGOS[id] ?? "";
}
