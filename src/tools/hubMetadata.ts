// Index metadata (categoria, tags, resumo, efeito, aprovacao) of the 8 native tools, read by AI Ecosystem's
// tools_find / tools_describe / tools_run. Kept apart from the tool definitions so the MCP text stays untouched.

import { HubTool } from "../ecosystem/moduleConnector";

export type HubToolMetadata = Pick<HubTool, "categoria" | "tags" | "resumo" | "efeito" | "exposicao" | "aprovacao" | "exemplo">;

export const NATIVE_TOOL_METADATA: Record<string, HubToolMetadata> = {
  list_secrets: {
    categoria: "Segredos",
    tags: ["segredo", "variavel", "placeholder", "ambiente"],
    resumo: "Lista os nomes e hosts das variáveis de ambiente, nunca os valores",
    efeito: "leitura",
    aprovacao: "dispensada",
    exemplo: {},
  },
  http_request: {
    categoria: "API",
    tags: ["http", "request", "api", "placeholder", "segredo"],
    resumo: "Envia uma requisição HTTP resolvendo {{secret:NOME}} dentro do Obsidian",
    efeito: "externo",
    aprovacao: "Posso enviar {method} para {url}?",
    exemplo: { method: "GET", url: "https://acme.atlassian.net/rest/api/3/myself", headers: { Authorization: "{{basic:JIRA_ACME}}" } },
  },
  get_tool_authoring_guide: {
    categoria: "Tools do cofre",
    tags: ["guia", "tool", "nota", "autoria"],
    resumo: "Guia para criar, alterar ou explicar tools definidas por notas do cofre",
    efeito: "leitura",
    aprovacao: "dispensada",
    exemplo: {},
  },
  list_vault_tools: {
    categoria: "Tools do cofre",
    tags: ["tool", "lista", "status", "mcp"],
    resumo: "Lista as tools do cofre com status, parâmetros e problemas",
    efeito: "leitura",
    aprovacao: "dispensada",
    exemplo: { mcp: "Jira Cloud", query: "changelog" },
  },
  search_vault_tools: {
    categoria: "Tools do cofre",
    tags: ["tool", "busca", "endpoint", "mcp", "jira"],
    resumo: "Acha tools do cofre por pacote, nome, palavras-chave ou endpoint",
    efeito: "leitura",
    aprovacao: "dispensada",
    exemplo: { query: "jira changelog" },
  },
  list_tools: {
    categoria: "Tools do cofre",
    tags: ["tool", "busca", "lista", "mcp"],
    resumo: "Busca e lista tools por pacote, nome ou palavras-chave",
    efeito: "leitura",
    aprovacao: "dispensada",
    exemplo: { mcp: "Jira Cloud" },
  },
  run_vault_tool: {
    categoria: "Tools do cofre",
    tags: ["tool", "executar", "api", "mcp"],
    resumo: "Executa uma tool do cofre pelo nome, com segredos resolvidos no Obsidian",
    efeito: "externo",
    aprovacao: "Posso executar a tool {name}?",
    exemplo: { name: "jira_get_issue", arguments: { instancia: "Acme", issueIdOrKey: "ATL-1" } },
  },
  env_criar_secret: {
    categoria: "Segredos",
    tags: ["segredo", "criar", "tela", "variavel"],
    resumo: "Abre a tela onde o usuário digita e cria uma variável de ambiente",
    efeito: "cofre",
    aprovacao: "dispensada",
    exemplo: { nome_sugerido: "JIRA_ACME", tipo_sugerido: "basic", dominios_sugeridos: ["acme.atlassian.net"] },
  },
};

/** Index metadata of a tool; vault tools from notes get an effect inferred from `writes`. */
export function metadataFor(name: string, writes?: boolean): HubToolMetadata {
  const native = NATIVE_TOOL_METADATA[name];
  if (native) return native;
  return { efeito: writes ? "externo" : "leitura", exposicao: "indice" };
}
