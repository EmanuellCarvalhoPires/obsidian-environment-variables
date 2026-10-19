import { App, Notice, requestUrl } from "obsidian";
import { t } from "../i18n";
import { ECOSYSTEM_PLUGIN_ID } from "./moduleConnector";

export const ECOSYSTEM_GITHUB_REPO = "R1ck12/obsidian-ai-ecosystem";
export const ECOSYSTEM_MANIFEST_URL = `https://github.com/${ECOSYSTEM_GITHUB_REPO}/releases/latest/download/manifest.json`;
export const ECOSYSTEM_SHOW_PLUGIN_URI = `obsidian://show-plugin?id=${ECOSYSTEM_PLUGIN_ID}`;

interface InternalPluginsManager {
  manifests?: Record<string, unknown>;
  installPlugin?: (repo: string, version: string, manifest: unknown) => Promise<void>;
  enablePluginAndSave?: (id: string) => Promise<void>;
  loadPlugin?: (id: string) => Promise<void>;
}

/**
 * Installs (if needed) and enables the `ai-ecosystem` plugin in 1 click using Obsidian's
 * internal plugin manager, falling back to `obsidian://show-plugin?id=ai-ecosystem`.
 */
export async function installAndEnableEcosystem(app: App): Promise<boolean> {
  const plugins = (app as unknown as { plugins?: InternalPluginsManager }).plugins;
  try {
    if (plugins) {
      const alreadyInstalled = Boolean(plugins.manifests?.[ECOSYSTEM_PLUGIN_ID]);
      if (!alreadyInstalled && typeof plugins.installPlugin === "function") {
        const res = await requestUrl({ url: ECOSYSTEM_MANIFEST_URL, method: "GET" });
        const manifest: unknown = typeof res.json === "object" && res.json !== null ? (res.json as unknown) : (JSON.parse(res.text) as unknown);
        const version = typeof (manifest as { version?: unknown }).version === "string" ? (manifest as { version: string }).version : "1.0.0";
        await plugins.installPlugin(ECOSYSTEM_GITHUB_REPO, version, manifest);
      }
      if (typeof plugins.enablePluginAndSave === "function") {
        await plugins.enablePluginAndSave(ECOSYSTEM_PLUGIN_ID);
        new Notice(t("notice.ecosystemActivated"));
        return true;
      }
    }
  } catch {
    // Fall back to Community Plugins URI below.
  }

  try {
    window.open(ECOSYSTEM_SHOW_PLUGIN_URI);
  } catch {
    // Ignore in headless/test environments.
  }
  return false;
}
