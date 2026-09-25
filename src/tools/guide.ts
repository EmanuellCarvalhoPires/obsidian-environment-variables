// The authoring guide for AI agents: how vault tools work and the mandatory workflow
// (survey, ask the user, write an implementation plan, wait for approval, implement, validate).
// The text lives in guide/*.md (bundled as text); this file fills in the current settings.

import en from "./guide/guide.en.md";
import pt from "./guide/guide.pt.md";
import { ToolStatus } from "./types";

export type GuideLanguage = "en" | "pt";

export interface GuideState {
  /** This vault: each vault has its own server, MCP server name, secrets and tools. */
  vaultName: string;
  vaultPath: string;
  mcpServerName: string;
  toolsEnabled: boolean;
  scriptsEnabled: boolean;
  toolTag: string;
  requestTag: string;
  scriptTimeoutSeconds: number;
  serverUrl: string;
  serverRunning: boolean;
  tools: Array<{ name: string; status: ToolStatus }>;
}

const MAX_LISTED_TOOLS = 50;

export function buildGuide(lang: GuideLanguage, state: GuideState, request?: string): string {
  const base = (lang === "pt" ? pt : en)
    .split("%TOOL_TAG%").join(state.toolTag)
    .split("%REQUEST_TAG%").join(state.requestTag)
    .split("%SCRIPT_TIMEOUT%").join(String(state.scriptTimeoutSeconds))
    .split("%VAULT_NAME%").join(state.vaultName)
    .split("%VAULT_PATH%").join(state.vaultPath)
    .split("%MCP_SERVER_NAME%").join(state.mcpServerName)
    .split("%SERVER_URL%").join(state.serverUrl);
  return [base.trimEnd(), stateSection(lang, state), requestSection(lang, request)].join("\n\n") + "\n";
}

function stateSection(lang: GuideLanguage, s: GuideState): string {
  const L = lang === "pt" ? PT : EN;
  const lines = [
    L.title,
    "",
    `- ${L.vault}: ${s.vaultName} (\`${s.vaultPath}\`)`,
    `- ${L.serverName}: \`${s.mcpServerName}\``,
    `- ${L.tools}: ${s.toolsEnabled ? L.on : `${L.off}. ${L.turnOnTools}`}`,
    `- ${L.scripts}: ${s.scriptsEnabled ? L.on : `${L.off}. ${L.turnOnScripts}`}`,
    `- ${L.toolTag}: \`${s.toolTag}\``,
    `- ${L.requestTag}: \`${s.requestTag}\``,
    `- ${L.timeout}: ${s.scriptTimeoutSeconds} s`,
    `- ${L.server}: ${s.serverUrl} (${s.serverRunning ? L.running : L.stopped})`,
    `- ${L.registered}: ${s.tools.length}`,
  ];
  for (const t of s.tools.slice(0, MAX_LISTED_TOOLS)) lines.push(`  - \`${t.name}\`: ${t.status}`);
  if (s.tools.length > MAX_LISTED_TOOLS) lines.push(`  - … ${L.more}`);
  return lines.join("\n");
}

function requestSection(lang: GuideLanguage, request?: string): string {
  const L = lang === "pt" ? PT : EN;
  const text = request?.trim();
  return [L.requestTitle, "", text ? text : L.noRequest].join("\n");
}

const EN = {
  title: "## 10. Current state of the plugin (generated now)",
  vault: "Vault",
  serverName: "MCP server name of this vault",
  tools: "Vault tools",
  scripts: "Script tools",
  on: "on",
  off: "off",
  turnOnTools: "Ask the user to turn them on in Obsidian: Settings > Environment Variables > Vault tools. The management tools (list_vault_tools, run_vault_tool) only exist while this is on.",
  turnOnScripts: "kind: script tools will not run until the user turns scripts on in the same settings section. Mention this in the plan if you need scripts.",
  toolTag: "Tag of tool notes",
  requestTag: "Tag of request notes",
  timeout: "Script time limit",
  server: "MCP server",
  running: "running",
  stopped: "stopped",
  registered: "Tool notes found",
  more: "more (call list_vault_tools)",
  requestTitle: "## 11. The user's request",
  noRequest: "The user's request comes right after this guide. If there is none, ask the user what they want to build.",
};

const PT: typeof EN = {
  title: "## 10. Estado atual do plugin (gerado agora)",
  vault: "Cofre",
  serverName: "Nome do servidor MCP deste cofre",
  tools: "Ferramentas do cofre",
  scripts: "Ferramentas com script",
  on: "ligadas",
  off: "desligadas",
  turnOnTools: "Peça ao usuário para ligar no Obsidian: Configurações > Environment Variables > Ferramentas do cofre. As ferramentas de gestão (list_vault_tools, run_vault_tool) só existem com isso ligado.",
  turnOnScripts: "Ferramentas kind: script não rodam até o usuário ligar os scripts na mesma seção das configurações. Se precisar de scripts, cite isso no plano.",
  toolTag: "Tag das notas de ferramenta",
  requestTag: "Tag das notas de requisição",
  timeout: "Tempo máximo dos scripts",
  server: "Servidor MCP",
  running: "ligado",
  stopped: "desligado",
  registered: "Notas de ferramenta encontradas",
  more: "outras (chame list_vault_tools)",
  requestTitle: "## 11. Pedido do usuário",
  noRequest: "O pedido do usuário vem logo depois deste guia. Se não houver pedido, pergunte o que ele quer criar.",
};
