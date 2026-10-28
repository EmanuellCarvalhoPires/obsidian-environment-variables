// Default logos for downloadable MCP packages, loaded on demand from defaultLogos.json.
// Source: the user's vault (Anexos/Logos/Atlassian), the Atlassian brand icon set.
// Keyed by the "logo" id a package's manifest names; unknown ids fall back to a generic icon.

import * as fs from "node:fs";
import * as path from "node:path";

let cachedLogos: Record<string, string> | null = null;

function loadLogos(): Record<string, string> {
  if (cachedLogos) return cachedLogos;

  const candidates: string[] = [
    path.join(__dirname, "defaultLogos.json"),
    path.join(__dirname, "src/ui/defaultLogos.json"),
    path.join(process.cwd(), "src/ui/defaultLogos.json"),
    path.join(process.cwd(), "defaultLogos.json"),
  ];

  const app = (globalThis as unknown as {
    app?: {
      vault?: {
        configDir?: string;
        adapter?: { getBasePath?: () => string };
      };
      plugins?: {
        plugins?: Record<string, { manifest?: { dir?: string } }>;
      };
    };
  }).app;

  if (app) {
    const pluginDir =
      app.plugins?.plugins?.["environment-variables"]?.manifest?.dir ??
      `${app.vault?.configDir ?? ".obsidian"}/plugins/environment-variables`;
    candidates.unshift(path.join(pluginDir, "defaultLogos.json"));
    if (app.vault?.adapter?.getBasePath) {
      candidates.unshift(path.join(app.vault.adapter.getBasePath(), pluginDir, "defaultLogos.json"));
    }
  }

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        const text = fs.readFileSync(candidate, "utf8");
        cachedLogos = JSON.parse(text) as Record<string, string>;
        return cachedLogos;
      }
    } catch {
      // Continue to next candidate
    }
  }

  cachedLogos = {};
  return cachedLogos;
}

export const DEFAULT_MCP_LOGOS: Record<string, string> = new Proxy({}, {
  get(_target, prop: string) {
    return loadLogos()[prop];
  },
  has(_target, prop: string) {
    return prop in loadLogos();
  },
  ownKeys() {
    return Object.keys(loadLogos());
  },
  getOwnPropertyDescriptor(_target, prop: string) {
    const val = loadLogos()[prop];
    return val !== undefined ? { value: val, writable: false, enumerable: true, configurable: true } : undefined;
  },
});

/** The bundled logo for a package's `logo` id, or "" (generic icon) when there is none. */
export function defaultLogoFor(id: string): string {
  return loadLogos()[id] ?? "";
}
