# Plano de implementação: itens aceitos da auditoria do AI Ecosystem no módulo Environment Keys

## Sumário
- Etapa 1: Salvar respostas grandes em arquivo (save_to), PRIORIZADO (linhas 80-177)
- Etapa 2: Projeção de campos, limite e JSON compacto no http_request (linhas 179-274)
- Etapa 3: Índice de endpoints, hint via_tool e instâncias do banco mcp.db (linhas 276-379)
- Etapa 4: Superfície MCP enxuta e run por tools_run (linhas 381-476)
- Etapa 5: Campos padrão, conversão ADF e paginação por tool (linhas 478-569)
- Etapa 6: Listagem de segredos enxuta e fim do fallback de acesso total (linhas 571-656)
- Etapa 7: Argumentos numéricos e limites de scripts de tool (linhas 658-741)
- Etapa 8: Textos pt-BR da chave de recuperação (linhas 743-816)
- Etapa 9: Guia de autoria por tópicos (linhas 818-908)
- Etapa 10: Higiene de testes e listagem com limite (linhas 910-991)
- Etapa 11: Sincronização sob demanda e data.json enxuto (linhas 993-1083)
- Etapa 12: Bundle com QuickJS e logos sob demanda (linhas 1085-1171)
- Etapa 13: Verificação geral (linhas 1173-1232)

## 1. Objetivo
Implementar os 23 itens aceitos da auditoria (arquivo `C:\Users\Trabalho\AppData\Local\Temp\claude\C--Users-Trabalho-Documents-Cofre\f7346580-c5be-4117-a93c-bde037b7aa6b\scratchpad\itens-env.md`) no plugin Environment Keys. Pronto quando os 23 itens tiverem o efeito descrito na seção "Critérios de aceite finais", `npm run typecheck`, `npm run lint` e `npm test` passarem, e nenhum segredo aparecer em respostas, logs ou arquivos novos.

## 2. Contexto completo
- **Projeto:** plugin do Obsidian (desktop only, Obsidian 1.13) escrito em TypeScript, com servidor MCP local em `127.0.0.1`. Raiz absoluta: `C:\Users\Trabalho\Documents\obsidian-environment-variables`. Código em `C:\Users\Trabalho\Documents\obsidian-environment-variables\src\`, testes em `C:\Users\Trabalho\Documents\obsidian-environment-variables\tests\` (Vitest). Versão atual 2.3.1 (`package.json`). Repositório git presente.
- **Estado atual relevante (confirmado no código):**
  - `src\server\mcp.ts`: `SERVER_INSTRUCTIONS`, `TOOLS_INSTRUCTIONS` (texto que cita `search_vault_tools` e `run_vault_tool`), `BUILT_IN_TOOLS` (schemas de `list_secrets` e `http_request`), `toolResult` (serializa com `JSON.stringify(value, null, 2)`).
  - `src\tools\hubMetadata.ts`: schemas e descrições de `list_vault_tools`, `search_vault_tools` e `run_vault_tool`.
  - `src\tools\service.ts`: lista das tools internas (`list_vault_tools`, `search_vault_tools`, `list_tools` duplicado, `run_vault_tool`); `callMcp` com `if (name === "search_vault_tools" || name === "list_tools")`; `status()`; `run()`; `hintFor()`; `apiIndexEntries()`; `endpointIndex()` e `buildEndpointIndex()` (usa só notas de request, nunca `dbManager.getRequestForTool`).
  - `src\tools\toolSearch.ts`: `howToRun()` devolve `run_vault_tool` para tools com `expose: false`.
  - `src\tools\mcpDb.ts`: `getRequestForTool(toolName)`, usado só por `apiIndexEntries()`.
  - `src\tools\registry.ts`: `noteChanged`, `isServiceNote(tags)` (só olha tools de `parsed`, não o banco), `update()`, `build()`, bloco de escolhas de instância (~linha 285).
  - `src\tools\obsidianSource.ts`: `toNote()` monta tags com `getAllTags` (inclui tags do corpo).
  - `src\tools\definition.ts`: `checkValue(spec, value)` rejeita número onde o spec é string.
  - `src\tools\scriptRunner.ts`: `job.onLog` existe (linha ~75) mas o `ctx.log` não é ligado no `service.ts`; não há limite de chamadas de `ctx.http`.
  - `src\secrets\broker.ts`: `listSecrets(client)` (linha ~74) audita toda chamada e devolve `SecretMetadata` completo.
  - `src\main.ts`: `resolveHubClient(client)` (~linha 530) devolve `access: { mode: "all" }` quando o cliente não está registrado; `syncEcosystemTools()` roda a cada evento; `ensureServerName`; `scheduleToolScan` (~linha 1105); data.json é gravado por `scheduleSave()`; `mcpGroups` guarda logos em base64.
  - `src\settings.ts`: padrões, `maxResponseMB: 10` (linha ~51).
  - `src\i18n.ts`: linhas ~498-515 têm strings pt-BR corrompidas (`recupera??o`, `?rea de transfer?ncia`, `voc?`); `src\ui\recoveryModals.ts` linha ~171 tem outra string corrompida.
  - `esbuild.config.mjs` gera `main.js` (~1,4 MB, com QuickJS em WASM base64).
  - `src\tools\guide.ts` e `src\tools\guide\guide.pt.md`, `guide.en.md`, `setup.pt.md`, `setup.en.md` contêm o guia de autoria (36,5 mil caracteres) e citam `list_vault_tools`, `search_vault_tools` e `run_vault_tool`.
  - `tests\_measure.test.ts` é um rascunho de medição (item 23).
- **Motivação:** reduzir tokens e chamadas por sessão, corrigir falhas (índice de endpoints, parâmetros numéricos, textos corrompidos, instâncias desatualizadas) e fechar um risco de segurança (cliente desconhecido com acesso total).
- **Fora do escopo:** publicar release, rodar `npm run deploy`, copiar para cofres, commit, push, criar dependências novas em `package.json`, alterar o protocolo do AI Ecosystem.

## 3. Regras globais de implementação
1. Comentários de código em inglês, como o código existente; strings de interface em `src\i18n.ts` nas duas línguas (chaves `en` e `pt`).
2. Nenhuma dependência nova. Não alterar `package.json`.
3. Todo caminho citado nos prompts é absoluto. Dentro do plugin, caminhos de arquivo do cofre são relativos à raiz do cofre (API `app.vault.adapter`), como já faz `src\main.ts`.
4. Comandos, rodados com o diretório de trabalho em `C:\Users\Trabalho\Documents\obsidian-environment-variables`:
   - Tipos: `npm run typecheck` (`tsc --noEmit`).
   - Testes: `npm test` (`vitest run`); um arquivo: `npm test -- tests\nomeDoArquivo.test.ts`.
   - Lint: `npm run lint` (`eslint .`).
   - Build: `npm run build` reescreve `C:\Users\Trabalho\Documents\obsidian-environment-variables\main.js`. Só rode quando a etapa pedir.
   - Não rodar `npm run deploy` em nenhuma etapa.
5. Segurança: nunca escrever, logar ou devolver valor de segredo. Toda resposta passa pelo mascaramento existente (`src\secrets\redact.ts`) antes de sair. Não ler `.env` nem `.credentials.json`.
6. Não alterar comportamento não listado no item. Quando um teste existente quebrar por causa do item, atualizar o teste com o novo comportamento e dizer isso no relatório.
7. Não fazer commit, push, merge nem criar branch.
8. Antes de editar um arquivo, leia-o com a ferramenta Read.

## 4. Mapa das etapas

| # | Etapa | Esforço | Depende de | Paralelizável com |
| --- | --- | --- | --- | --- |
| 1 | Salvar respostas grandes em arquivo (save_to), PRIORIZADO (itens 1) | alto | nenhuma | nenhuma |
| 2 | Projeção de campos, limite e JSON compacto (itens 2, 5) | alto | 1 | nenhuma |
| 3 | Índice de endpoints, via_tool e instâncias do banco (itens 3, 9, 4, 11) | alto | 2 | nenhuma |
| 4 | Superfície MCP enxuta e run por tools_run (itens 7, 8, 16) | alto | 3 | nenhuma |
| 5 | Campos padrão, ADF e paginação por tool (itens 6, 10, 18) | alto | 2, 4 | nenhuma |
| 6 | Listagem de segredos e fim do acesso total (itens 13, 17) | alto | 4 | 5 |
| 7 | Argumentos numéricos e limites de scripts (itens 15, 19) | médio | 5 | 6 |
| 8 | Textos pt-BR corrigidos (item 20) | médio | 4 | 5, 6, 7 |
| 9 | Guia de autoria por tópicos (item 22) | alto | 4, 5, 7 | 8 |
| 10 | Higiene de testes e listagem com limite (item 23) | médio | 4 | 8, 9 |
| 11 | Sincronização sob demanda e data.json enxuto (itens 12, 14) | alto | 3 | 5, 6, 7, 8 |
| 12 | Bundle com QuickJS e logos sob demanda (item 21) | alto | 7 | 9, 10, 11 |
| 13 | Verificação geral | alto | 1 a 12 | nenhuma |

Ordem de execução: 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13. As etapas "Paralelizável com" não tocam os mesmos arquivos e podem rodar em paralelo, se o Maestro quiser.

## 5. Etapas

## Etapa 1: Salvar respostas grandes em arquivo (save_to), PRIORIZADO [Haiku 5.5 | esforço: alto]

**Objetivo:** permitir que `http_request` grave a resposta, já mascarada, numa pasta fixa do cofre e devolva apenas caminho, tamanho e chaves de topo.
**Depende de:** nenhuma
**Paralelizável com:** nenhuma

**Arquivos**
- Criar: `C:\Users\Trabalho\Documents\obsidian-environment-variables\src\tools\savedResponses.ts`
- Criar: `C:\Users\Trabalho\Documents\obsidian-environment-variables\tests\savedResponses.test.ts`
- Alterar: `C:\Users\Trabalho\Documents\obsidian-environment-variables\src\server\mcp.ts` (schema e descrição de `http_request` em `BUILT_IN_TOOLS`)
- Alterar: o handler que atende `http_request`. Localize-o procurando a string `"http_request"` em `C:\Users\Trabalho\Documents\obsidian-environment-variables\src\server\` e `C:\Users\Trabalho\Documents\obsidian-environment-variables\src\tools\service.ts`; é o ponto que chama o broker de segredos (`src\secrets\broker.ts`) e devolve a resposta mascarada.
- Não tocar: `C:\Users\Trabalho\Documents\obsidian-environment-variables\main.js`, `package.json`, qualquer arquivo em `src\ui\`.

**Regras de implementação**
1. `save_to` é um booleano opcional, padrão `false`, no `inputSchema` de `http_request`. Quando `true`, a resposta é gravada; quando omitido ou `false`, o comportamento é o atual.
2. O caminho nunca vem do chamador. A pasta é fixa: `.obsidian/plugins/environment-variables/respostas`, relativa à raiz do cofre, acessada por `app.vault.adapter`. O nome do arquivo é `crypto.randomUUID()` mais `.json`. Se o chamador enviar qualquer campo de caminho (`path`, `file`, `save_path`), a chamada falha com `invalid_argument`, pelo `additionalProperties: false` já existente.
3. Grave o corpo depois do mascaramento (o mesmo texto que sairia na resposta). Nunca grave o texto antes do `redact`.
4. Crie a pasta com `adapter.exists` e `adapter.mkdir` antes de gravar.
5. A resposta de `save_to: true` é `{ saved_to: "<caminho relativo>", bytes: <número>, top_keys: [<chaves>] }`. `top_keys` é a lista de chaves quando o corpo é um objeto JSON, e `null` caso contrário. O status HTTP e os headers vêm junto, como nas respostas atuais.
6. Não apague arquivos antigos nesta etapa (retenção fica fora do escopo).
7. A função de gravação recebe um adaptador injetado, para o teste não depender do Obsidian.

**Passos**
- **1.1 Módulo de gravação:** objetivo: criar `src\tools\savedResponses.ts` com uma função pura de gravação.
  1. Exporte `interface ResponseWriter { exists(path: string): Promise<boolean>; mkdir(path: string): Promise<void>; write(path: string, content: string): Promise<void>; }`.
  2. Exporte `const SAVED_RESPONSES_DIR = ".obsidian/plugins/environment-variables/respostas"`.
  3. Exporte `async function saveResponse(writer: ResponseWriter, maskedBody: string, id: string): Promise<{ saved_to: string; bytes: number; top_keys: string[] | null }>`. Crie a pasta se faltar, monte o caminho como `${SAVED_RESPONSES_DIR}/${id}.json`, grave `maskedBody`, calcule `bytes` com `new TextEncoder().encode(maskedBody).length`, e calcule `top_keys` tentando `JSON.parse`; só chaves de objeto, nunca arrays.
  - Verificação do sub-tópico: `npm run typecheck` → sem erros.
- **1.2 Ligação ao http_request:** objetivo: usar a função quando `save_to === true`.
  1. No handler de `http_request`, leia `args.save_to`. Valide que é booleano ou ausente; caso contrário, erro `invalid_argument`.
  2. Depois de obter e mascarar o corpo, se `save_to === true`, chame `saveResponse` com um `ResponseWriter` que use `app.vault.adapter` (`exists`, `mkdir`, `write`), e `id = crypto.randomUUID()`.
  3. Devolva o objeto de metadados no lugar do corpo, mantendo `status` e `headers`.
  - Verificação do sub-tópico: `npm run typecheck` → sem erros.
- **1.3 Schema e descrição:** objetivo: expor o parâmetro ao agente.
  1. Em `BUILT_IN_TOOLS` de `src\server\mcp.ts`, adicione `save_to: { type: "boolean", description: "Save the response body (masked) to a file in the vault and return its path, size and top-level keys instead of the body." }` às `properties` de `http_request`.
  2. Acrescente à `description` de `http_request` uma frase: "Use save_to: true for large responses."
  - Verificação do sub-tópico: `npm run typecheck` → sem erros.
- **1.4 Testes:** objetivo: cobrir o módulo novo.
  1. Crie `tests\savedResponses.test.ts` com um `ResponseWriter` falso em memória.
  2. Teste: corpo JSON `{"a":1,"b":2}` → `top_keys` `["a","b"]`, `saved_to` começa com `.obsidian/plugins/environment-variables/respostas/` e termina em `.json`.
  3. Teste: corpo não JSON → `top_keys` `null`.
  4. Teste: corpo com um valor que seria segredo já vem mascarado; o teste confirma que o texto gravado é exatamente o recebido (o mascaramento é responsabilidade do chamador).
  - Verificação do sub-tópico: `npm test -- tests\savedResponses.test.ts` → todos passam.

**BDD (estado esperado ao concluir)**
- Dado `save_to: true` e um corpo JSON `{"a":1,"b":2}` já mascarado, Quando `http_request` roda, Então a resposta traz `saved_to` iniciado por `.obsidian/plugins/environment-variables/respostas/` e `top_keys` igual a `["a","b"]`.
- Dado `save_to` omitido, Quando `http_request` roda, Então a resposta é a mesma de antes desta etapa (os testes existentes de `http_request` passam sem alteração).
- Dado um argumento `path` na chamada, Quando `http_request` roda, Então a resposta é erro `invalid_argument` e nada é gravado.
- Dado `save_to: "sim"` (texto), Quando `http_request` roda, Então a resposta é erro `invalid_argument`.
- Dado qualquer corpo gravado, Quando o arquivo é lido, Então ele não contém o valor real de nenhum segredo usado na chamada.
- Nada quebrou: a suíte `npm test` passa por completo.

**Verificação**
- `npm run typecheck` → sem erros.
- `npm test -- tests\savedResponses.test.ts` → todos passam.
- `npm test` → suíte completa passa.
- `npm run lint` → sem erros novos nos arquivos alterados.

**Prompt para o subagente**
```text
Papel: você é um implementador de código TypeScript. Vai implementar uma única área de um plugin do Obsidian, sem decidir requisitos.

Contexto completo: o projeto é o plugin "Environment Keys" do Obsidian (TypeScript, desktop only, Obsidian 1.13). Ele guarda segredos cifrados e expõe um servidor MCP local em 127.0.0.1. Raiz absoluta do projeto: C:\Users\Trabalho\Documents\obsidian-environment-variables. Código em C:\Users\Trabalho\Documents\obsidian-environment-variables\src\, testes em C:\Users\Trabalho\Documents\obsidian-environment-variables\tests\ (Vitest). Objetivo geral da demanda: implementar 23 itens aceitos de uma auditoria; você faz só o item 1 (parâmetro save_to do http_request). Esta é a primeira etapa; nenhuma etapa anterior existe.

Convenções: comentários de código em inglês, como o código existente. Nenhuma dependência nova; não altere package.json. Não faça commit, push nem branch. Não leia .env nem arquivos de credenciais. Nunca escreva valor de segredo em lugar nenhum. Comandos, rodados com o diretório de trabalho em C:\Users\Trabalho\Documents\obsidian-environment-variables: `npm run typecheck`, `npm test`, `npm test -- tests\savedResponses.test.ts`, `npm run lint`. Não rode `npm run build` nem `npm run deploy`.

Regras de implementação:
1. save_to é booleano opcional, padrão false, no inputSchema de http_request em C:\Users\Trabalho\Documents\obsidian-environment-variables\src\server\mcp.ts (BUILT_IN_TOOLS). Com false ou ausente, o comportamento não muda.
2. O caminho nunca vem do chamador. Pasta fixa: ".obsidian/plugins/environment-variables/respostas" (relativa à raiz do cofre, pela API app.vault.adapter). Nome do arquivo: crypto.randomUUID() + ".json". Qualquer campo de caminho enviado pelo chamador gera erro invalid_argument.
3. Grave o corpo depois do mascaramento (o texto que sairia na resposta). Nunca antes do redact.
4. Crie a pasta com adapter.exists e adapter.mkdir antes de gravar.
5. Com save_to true, a resposta é { saved_to, bytes, top_keys }. top_keys é a lista das chaves de topo se o corpo for um objeto JSON; senão null. Mantenha status e headers.
6. Não apague arquivos antigos.
7. A lógica de gravação recebe um ResponseWriter injetado (exists, mkdir, write), para o teste não depender do Obsidian.

O que fazer, nesta ordem (cada sub-tópico termina com a verificação dele; se falhar, pare e relate):
1.1 Crie C:\Users\Trabalho\Documents\obsidian-environment-variables\src\tools\savedResponses.ts. Exporte: interface ResponseWriter { exists(path: string): Promise<boolean>; mkdir(path: string): Promise<void>; write(path: string, content: string): Promise<void>; }; const SAVED_RESPONSES_DIR = ".obsidian/plugins/environment-variables/respostas"; e async function saveResponse(writer, maskedBody: string, id: string) que devolve { saved_to, bytes, top_keys }. saved_to = `${SAVED_RESPONSES_DIR}/${id}.json`. bytes = new TextEncoder().encode(maskedBody).length. top_keys: tente JSON.parse; se for objeto (não array), as chaves; senão null.
   Verificação: npm run typecheck → sem erros.
1.2 Ache o handler de "http_request" (procure a string "http_request" em C:\Users\Trabalho\Documents\obsidian-environment-variables\src\server\ e em C:\Users\Trabalho\Documents\obsidian-environment-variables\src\tools\service.ts). Leia args.save_to: se não for booleano nem ausente, erro invalid_argument. Depois de obter e mascarar o corpo, se save_to === true, chame saveResponse com um writer que use app.vault.adapter e id = crypto.randomUUID(); devolva o objeto de metadados no lugar do corpo, mantendo status e headers. Se o handler não tiver acesso a app.vault.adapter, passe o adaptador pelas dependências já existentes do handler e pare se não houver caminho limpo.
   Verificação: npm run typecheck → sem erros.
1.3 Em mcp.ts, adicione em http_request.inputSchema.properties: save_to: { type: "boolean", description: "Save the response body (masked) to a file in the vault and return its path, size and top-level keys instead of the body." }. Acrescente à description de http_request a frase "Use save_to: true for large responses."
   Verificação: npm run typecheck → sem erros.
1.4 Crie C:\Users\Trabalho\Documents\obsidian-environment-variables\tests\savedResponses.test.ts com um ResponseWriter falso em memória. Casos: corpo {"a":1,"b":2} → top_keys ["a","b"], saved_to começa com ".obsidian/plugins/environment-variables/respostas/" e termina com ".json"; corpo não JSON → top_keys null; array JSON → top_keys null.
   Verificação: npm test -- tests\savedResponses.test.ts → todos passam.

Critérios (BDD) que você deve provar:
- Dado save_to true e corpo JSON {"a":1,"b":2} já mascarado, Quando http_request roda, Então a resposta traz saved_to iniciado por ".obsidian/plugins/environment-variables/respostas/" e top_keys ["a","b"].
- Dado save_to ausente, Então a resposta é igual à anterior e os testes existentes de http_request passam sem alteração.
- Dado um argumento "path", Então erro invalid_argument e nada é gravado.
- Dado save_to "sim" (texto), Então erro invalid_argument.
- Nada quebrou: npm test passa por completo.

Não faça: não altere outros arquivos além dos listados; não altere src\ui\; não mude o formato de resposta sem save_to; não rode npm run build.

Se algo não bater com o descrito (arquivo ausente, handler com outro nome, função com outra assinatura), pare e relate, sem improvisar.

Relatório final: liste os arquivos criados e alterados com caminho absoluto; cole a saída real de cada comando de verificação; informe o resultado de cada sub-tópico (1.1 a 1.4); descreva qualquer desvio ou dúvida.
```

## Etapa 2: Projeção de campos, limite e JSON compacto no http_request [Haiku 5.5 | esforço: alto]

**Objetivo:** permitir ao agente pedir só alguns campos e limitar o tamanho do corpo, devolver headers só com `headers: true`, e reduzir o JSON da resposta.
**Depende de:** Etapa 1
**Paralelizável com:** nenhuma

**Arquivos**
- Criar: `C:\Users\Trabalho\Documents\obsidian-environment-variables\src\tools\responseShape.ts`
- Criar: `C:\Users\Trabalho\Documents\obsidian-environment-variables\tests\responseShape.test.ts`
- Alterar: `C:\Users\Trabalho\Documents\obsidian-environment-variables\src\server\mcp.ts` (schema de `http_request`; `toolResult` com JSON compacto)
- Alterar: o handler de `http_request` (o mesmo da Etapa 1)
- Não tocar: `C:\Users\Trabalho\Documents\obsidian-environment-variables\src\tools\savedResponses.ts` (só ler)

**Regras de implementação**
1. Novos parâmetros opcionais de `http_request`: `fields` (string com nomes separados por vírgula, caminhos com ponto, ex.: `key,fields.summary`), `max_chars` (inteiro de 1 a 1000000), `headers` (booleano, padrão `false`).
2. Projeção só se o corpo for JSON. `fields` lista caminhos com ponto; cada caminho inexistente vira `null` no resultado, sem erro. Arrays não são percorridos por índice nesta etapa; um caminho que passa por array devolve o array inteiro.
3. Ordem obrigatória: (a) obter a resposta; (b) mascarar o corpo com `redact` existente; (c) só então projetar e fazer `JSON.parse`. Nunca projetar antes de mascarar.
4. `max_chars` corta o texto depois da projeção e acrescenta `truncated: true` e `total_chars` na resposta. Sem `max_chars`, o corte é o `maxResponseMB` já existente (`src\settings.ts`).
5. `headers` ausente ou `false`: a resposta não traz o bloco `headers`. `true`: traz como hoje.
6. Corpo JSON vai como objeto (JSON parseado), não como string escapada. Corpo não JSON continua string.
7. `toolResult` em `src\server\mcp.ts` serializa com `JSON.stringify(value)` sem indentação (item 5).
8. `save_to` (Etapa 1) continua gravando o corpo mascarado completo, sem projeção.

**Passos**
- **2.1 Módulo de projeção:** objetivo: criar `src\tools\responseShape.ts`.
  1. Exporte `function projectFields(obj: unknown, fields: string[]): Record<string, unknown>`. Para cada caminho, percorra com `.` e devolva o valor, ou `null` se algum passo faltar.
  2. Exporte `function parseFieldList(text: unknown): string[] | undefined`. Aceita string, faz `split(",")`, `trim()` e descarta vazios. Qualquer outro tipo: erro `invalid_argument` (lance o erro que o projeto usa, veja `ToolError` em `src\tools\service.ts`).
  - Verificação: `npm run typecheck` → sem erros.
- **2.2 Ligação ao http_request:** objetivo: aplicar a ordem da regra 3.
  1. No handler de `http_request`, leia `fields`, `max_chars`, `headers`, validando tipo e faixa.
  2. Depois do mascaramento, se o corpo for JSON e `fields` existir, aplique `projectFields`.
  3. Se `max_chars` existir e o texto final passar dele, corte e acrescente `truncated: true`, `total_chars`.
  4. Monte a resposta sem `headers` quando `headers !== true`.
  - Verificação: `npm run typecheck` → sem erros.
- **2.3 JSON compacto:** objetivo: serialização sem indentação.
  1. Em `src\server\mcp.ts`, troque `JSON.stringify(value, null, 2)` em `toolResult` por `JSON.stringify(value)`.
  2. Confirme que nenhum teste existente compara o texto com indentação; se algum comparar, atualize o teste e diga no relatório.
  - Verificação: `npm test` → passa.
- **2.4 Schema e testes:** objetivo: expor e cobrir.
  1. Em `BUILT_IN_TOOLS` de `src\server\mcp.ts`, adicione `fields`, `max_chars` e `headers` ao `inputSchema` de `http_request`, com descrições curtas.
  2. Crie `tests\responseShape.test.ts`: projeção com caminho existente, inexistente e que passa por array; `max_chars` com corte; `headers` ausente; campo `fields` vazio ignorado.
  - Verificação: `npm test -- tests\responseShape.test.ts` → passa.

**BDD (estado esperado ao concluir)**
- Dado um corpo JSON `{"key":"ACME-1","fields":{"summary":"x","status":"y"}}`, Quando `fields` é `key,fields.summary`, Então a resposta traz `{"key":"ACME-1","fields.summary":...}` com o valor `x` no campo projetado (o objeto devolvido aninha: `{"key":"ACME-1","fields":{"summary":"x"}}`).
- Dado `fields` com um caminho inexistente, Quando roda, Então o campo vem `null` e não há erro.
- Dado `max_chars: 10` e corpo de 50 caracteres, Quando roda, Então o corpo tem 10 caracteres, `truncated: true` e `total_chars: 50`.
- Dado `headers` omitido, Então a resposta não tem a chave `headers`; com `headers: true`, tem.
- Dado uma chave de API no corpo da resposta, Quando roda com `fields` que a inclui, Então o valor aparece mascarado como `***`.
- Dado corpo não JSON, Quando roda com `fields`, Então o corpo volta como texto, sem erro.
- Nada quebrou: `npm test` passa; o JSON de `toolResult` agora sai sem indentação.

**Verificação**
- `npm run typecheck` → sem erros.
- `npm test -- tests\responseShape.test.ts` → passa.
- `npm test` → suíte completa passa.
- `npm run lint` → sem erros novos.

**Prompt para o subagente**
```text
Papel: você é um implementador de código TypeScript. Vai implementar uma única área de um plugin do Obsidian, sem decidir requisitos.

Contexto completo: o projeto é o plugin "Environment Keys" do Obsidian (TypeScript, desktop only). Ele guarda segredos cifrados e expõe um servidor MCP local em 127.0.0.1. Raiz absoluta: C:\Users\Trabalho\Documents\obsidian-environment-variables. Código em C:\Users\Trabalho\Documents\obsidian-environment-variables\src\, testes em C:\Users\Trabalho\Documents\obsidian-environment-variables\tests\ (Vitest). Objetivo geral: implementar 23 itens aceitos de uma auditoria; você faz o item 2 (projeção de campos, max_chars, headers) e o item 5 (JSON compacto e corpo parseado) do http_request. A Etapa 1 já criou o parâmetro save_to e o módulo C:\Users\Trabalho\Documents\obsidian-environment-variables\src\tools\savedResponses.ts; você deve manter save_to funcionando (ele grava o corpo completo, mascarado, sem projeção).

Convenções: comentários em inglês, como o código existente. Nenhuma dependência nova; não altere package.json. Não faça commit, push nem branch. Não leia .env nem arquivos de credenciais. Nunca escreva valor de segredo. Comandos, com o diretório de trabalho em C:\Users\Trabalho\Documents\obsidian-environment-variables: `npm run typecheck`, `npm test`, `npm test -- tests\responseShape.test.ts`, `npm run lint`. Não rode `npm run build` nem `npm run deploy`.

Regras de implementação:
1. Parâmetros novos e opcionais em http_request (schema em C:\Users\Trabalho\Documents\obsidian-environment-variables\src\server\mcp.ts, BUILT_IN_TOOLS): fields (string, nomes separados por vírgula, caminhos com ponto), max_chars (inteiro de 1 a 1000000), headers (booleano, padrão false).
2. Projeção só para corpo JSON. Caminho inexistente vira null, sem erro. Se um caminho passa por array, devolve o array inteiro.
3. Ordem obrigatória: obter a resposta; mascarar com o redact existente (src\secrets\redact.ts); só depois projetar e fazer JSON.parse. Nunca projete antes de mascarar.
4. max_chars corta o texto depois da projeção e acrescenta truncated: true e total_chars. Sem max_chars, vale o limite maxResponseMB que já existe (src\settings.ts).
5. headers ausente ou false: sem o bloco headers na resposta. true: com o bloco.
6. Corpo JSON sai como objeto parseado, não como string. Corpo não JSON continua string.
7. toolResult em src\server\mcp.ts passa a usar JSON.stringify(value) sem indentação.

O que fazer, nesta ordem (cada sub-tópico termina com a verificação; se falhar, pare e relate):
2.1 Crie C:\Users\Trabalho\Documents\obsidian-environment-variables\src\tools\responseShape.ts com: projectFields(obj, fields: string[]) e parseFieldList(text) (aceita string, faz split por vírgula, trim, descarta vazios; qualquer outro tipo gera erro invalid_argument, usando o erro que o projeto já usa, ToolError em src\tools\service.ts). Verificação: npm run typecheck → sem erros.
2.2 No handler de "http_request" (ache-o procurando a string "http_request" em C:\Users\Trabalho\Documents\obsidian-environment-variables\src\server\ e em C:\Users\Trabalho\Documents\obsidian-environment-variables\src\tools\service.ts), valide fields, max_chars e headers; depois do mascaramento aplique projectFields quando o corpo for JSON; corte por max_chars com truncated e total_chars; omita headers quando headers !== true. Verificação: npm run typecheck → sem erros.
2.3 Em src\server\mcp.ts, troque JSON.stringify(value, null, 2) de toolResult por JSON.stringify(value). Se um teste existente comparar texto com indentação, atualize-o e diga no relatório. Verificação: npm test → passa.
2.4 Adicione fields, max_chars e headers ao inputSchema de http_request em mcp.ts, com descrições curtas. Crie C:\Users\Trabalho\Documents\obsidian-environment-variables\tests\responseShape.test.ts cobrindo: caminho existente, inexistente, passando por array, max_chars com corte, headers ausente e presente, fields vazio ignorado, corpo não JSON. Verificação: npm test -- tests\responseShape.test.ts → passa.

Critérios (BDD) que você deve provar:
- Dado corpo {"key":"ACME-1","fields":{"summary":"x","status":"y"}} e fields "key,fields.summary", Então a resposta traz {"key":"ACME-1","fields":{"summary":"x"}}.
- Dado um caminho inexistente em fields, Então o campo vem null e não há erro.
- Dado max_chars 10 e corpo de 50 caracteres, Então o corpo tem 10 caracteres, truncated true, total_chars 50.
- Dado headers omitido, Então não há chave headers; com true, há.
- Dado chave de API presente no corpo e incluída em fields, Então aparece como *** (mascarada).
- Dado corpo não JSON com fields, Então volta como texto sem erro.
- Nada quebrou: npm test passa por completo.

Não faça: não altere a lógica de save_to; não altere src\ui\; não altere guias ou textos de instrução (outra etapa cuida disso); não rode npm run build.

Se algo não bater com o descrito (arquivo ausente, handler com outro nome, assinatura diferente), pare e relate, sem improvisar.

Relatório final: arquivos criados e alterados com caminho absoluto; saída real de cada comando de verificação; resultado de cada sub-tópico (2.1 a 2.4); desvios e dúvidas.
```

## Etapa 3: Índice de endpoints, hint via_tool e instâncias do banco mcp.db [Haiku 5.5 | esforço: alto]

**Objetivo:** fazer o índice de endpoints enxergar as tools do banco mcp.db, redirecionar um GET que casa com uma tool para a tool equivalente, refletir instâncias novas do banco e não mostrar a lista de instâncias na descrição de tools com instância.
**Depende de:** Etapa 2
**Paralelizável com:** nenhuma

**Arquivos**
- Alterar: `C:\Users\Trabalho\Documents\obsidian-environment-variables\src\tools\service.ts` (`buildEndpointIndex` ~linha 430-445; `hintFor` ~linha 395; `apiIndexEntries` ~linha 415; handler de `http_request`)
- Alterar: `C:\Users\Trabalho\Documents\obsidian-environment-variables\src\tools\registry.ts` (`isServiceNote` ~linha 166; `noteChanged` ~linha 100; bloco de escolhas de instância ~linha 285 com a descrição do parâmetro)
- Alterar: `C:\Users\Trabalho\Documents\obsidian-environment-variables\src\tools\obsidianSource.ts` (`toNote`, linhas ~44-50: tags só do frontmatter)
- Alterar: `C:\Users\Trabalho\Documents\obsidian-environment-variables\src\main.ts` (registrar o evento `metadataCache.resolved` que refaz a montagem)
- Alterar: testes existentes `tests\apiIndex.test.ts`, `tests\toolSearch.test.ts`, `tests\registry*` se existirem (procure por `registry` em `C:\Users\Trabalho\Documents\obsidian-environment-variables\tests\`)
- Criar: `C:\Users\Trabalho\Documents\obsidian-environment-variables\tests\endpointIndexDb.test.ts`
- Não tocar: `C:\Users\Trabalho\Documents\obsidian-environment-variables\src\tools\mcpDb.ts` (só ler; a consulta `getRequestForTool` já existe)

**Regras de implementação**
1. `buildEndpointIndex` passa a usar, para cada tool pronta, `this.deps.dbManager?.getRequestForTool(entry.name)` antes de procurar a nota de request; o mesmo critério de `apiIndexEntries`. Assim, `.../issue/ABC-1/changelog` acha `jira_get_changelogs`.
2. `hintFor` continua não falhando nunca (`try/catch` existente).
3. `howToRun` e o hint de `http_request` com via_tool: se o método for GET e exatamente uma tool casar com a URL, e a tool tiver todos os parâmetros obrigatórios preenchíveis pela URL, rode a tool equivalente com `callMcp`-equivalente (`this.run`) e devolva o resultado com `via_tool: "<nome>"`. Se houver mais de uma tool, ou faltar parâmetro, não rode: devolva a resposta crua com o hint, como hoje.
4. `isServiceNote(tags)` passa a considerar também `serviceTag` das tools vindas do banco (`dbToolsProvider`, ver `build()`); a lista de tags de instância usa as duas fontes.
5. `main.ts` registra `this.app.metadataCache.on("resolved", ...)` (com `this.registerEvent`) que chama a mesma rotina de refazer a montagem usada por `scheduleToolScan`. Se o cache ainda não estava pronto, a montagem é refeita e nenhuma tool fica `invalid` por isso.
6. `toNote` em `obsidianSource.ts` usa só `cache.frontmatter.tags` (e `tag` se existir), não `getAllTags` do corpo. Assim uma tag `#jira/instance` escrita no corpo de um log não vira instância.
7. A descrição do parâmetro de instância em `registry.ts` não repete a lista de ids; diz só "Which instance to use. Values come from the enum." (o enum continua).

**Passos**
- **3.1 Índice pelo banco:** objetivo: `buildEndpointIndex` e `apiIndexEntries` usam o mesmo critério.
  1. Em `buildEndpointIndex` de `service.ts`, para cada entrada `ready` com `kind` de request ou de tool do banco, primeiro tente `const row = this.deps.dbManager?.getRequestForTool(entry.name)`; se existir, use `row.method` e `row.path`; se não, siga o caminho atual de nota.
  2. Garanta que a ordem de `EndpointPattern` continua a mesma (a ordenação por `literal` já existe em `toolSearch.ts`).
  - Verificação: `npm run typecheck` → sem erros.
- **3.2 Hint e via_tool:** objetivo: a regra 3.
  1. Em `hintFor` e no handler de `http_request`, implemente a regra 3. Procure `matchEndpoint` em `toolSearch.ts`.
  2. Para rodar, use o mesmo método interno de `service.ts` que atende `run_vault_tool` (`this.run(name, args, client)`); passe o `client` que já está no handler.
  3. Acrescente `via_tool` à resposta quando rodar.
  - Verificação: `npm run typecheck` → sem erros.
- **3.3 Instâncias e evento:** objetivo: regras 4, 5 e 7.
  1. Em `registry.ts`, altere `isServiceNote` para também consultar `dbToolsProvider` (ou o equivalente que `build()` já usa para as tools do banco).
  2. Em `main.ts`, registre `metadataCache.on("resolved", ...)` com `registerEvent`, chamando a mesma rotina de `scheduleToolScan`.
  3. Em `registry.ts`, troque a descrição da instância conforme a regra 7.
  - Verificação: `npm run typecheck` → sem erros.
- **3.4 Tags do corpo:** objetivo: regra 6.
  1. Em `obsidianSource.ts`, em `toNote`, monte `tags` só de `cache?.frontmatter?.tags` (aceite string ou lista) e `tag` (string ou lista), normalizados com `normalizeTag`.
  2. Não use `getAllTags` nesta função; se `getAllTags` deixar de ser usado, remova o import.
  - Verificação: `npm run typecheck` → sem erros.
- **3.5 Testes:** objetivo: cobrir.
  1. Crie `tests\endpointIndexDb.test.ts`: uma tool do banco com método e caminho ACHA a URL `https://x.atlassian.net/rest/api/3/issue/ABC-1/changelog` (use mocks do `dbManager`).
  2. Teste: GET com uma única tool casando roda a tool e devolve `via_tool`; duas tools casando não roda.
  3. Teste: tags só do frontmatter em `toNote`.
  4. Atualize `tests\apiIndex.test.ts` e `tests\toolSearch.test.ts` se algo mudou de contrato.
  - Verificação: `npm test -- tests\endpointIndexDb.test.ts` → passa; depois `npm test` → passa.

**BDD (estado esperado ao concluir)**
- Dado uma tool `jira_get_changelogs` no banco com GET `/rest/api/3/issue/{key}/changelog`, Quando busco a URL `.../issue/ABC-1/changelog`, Então a busca devolve essa tool.
- Dado um GET que casa com uma só tool pronta e sem parâmetros faltando, Quando `http_request` roda, Então a resposta traz `via_tool` e o resultado da tool.
- Dado um GET que casa com duas tools, Quando roda, Então a resposta é crua, com o hint, e nenhuma tool é executada.
- Dado uma nota de instância criada depois da montagem, Quando o cache de metadados fica pronto, Então a tool aparece `ready`, não `invalid`.
- Dado uma tag `#jira/instance` só no corpo de uma nota, Quando as tools são montadas, Então essa nota não entra no enum de instância.
- Dado uma tool com instância, Quando sai em `list_vault_tools`, Então a descrição do parâmetro não repete a lista de ids.
- Nada quebrou: `npm test` passa.

**Verificação**
- `npm run typecheck` → sem erros.
- `npm test -- tests\endpointIndexDb.test.ts` → passa.
- `npm test` → suíte completa passa.
- `npm run lint` → sem erros novos.

**Prompt para o subagente**
```text
Papel: você é um implementador de código TypeScript. Vai implementar uma única área de um plugin do Obsidian, sem decidir requisitos.

Contexto completo: o projeto é o plugin "Environment Keys" do Obsidian (TypeScript, desktop only). Expõe um servidor MCP local em 127.0.0.1 e "tools" do cofre (notas Markdown com a tag mcp/tool) e pacotes de tools guardados num banco mcp.db. Raiz absoluta: C:\Users\Trabalho\Documents\obsidian-environment-variables. Código em C:\Users\Trabalho\Documents\obsidian-environment-variables\src\, testes em C:\Users\Trabalho\Documents\obsidian-environment-variables\tests\ (Vitest). Objetivo geral: implementar 23 itens aceitos de uma auditoria; você faz os itens 3, 9, 4 e 11. Etapas 1 e 2 já foram feitas (save_to e projeção de campos no http_request, em C:\Users\Trabalho\Documents\obsidian-environment-variables\src\tools\savedResponses.ts e responseShape.ts); mantenha-as funcionando.

Convenções: comentários em inglês. Nenhuma dependência nova; não altere package.json. Não faça commit, push nem branch. Não leia .env nem credenciais. Nunca escreva valor de segredo. Comandos, com o diretório de trabalho em C:\Users\Trabalho\Documents\obsidian-environment-variables: `npm run typecheck`, `npm test`, `npm test -- tests\endpointIndexDb.test.ts`, `npm run lint`. Não rode npm run build nem npm run deploy.

Regras de implementação:
1. buildEndpointIndex em C:\Users\Trabalho\Documents\obsidian-environment-variables\src\tools\service.ts passa a consultar this.deps.dbManager?.getRequestForTool(entry.name) antes de procurar a nota de request. O mesmo critério de apiIndexEntries. Assim a URL .../issue/ABC-1/changelog acha jira_get_changelogs.
2. hintFor continua sem falhar (try/catch).
3. Hint via_tool: se o método for GET e exatamente uma tool casar com a URL e os parâmetros obrigatórios puderem ser preenchidos pela URL, rode a tool com this.run(nome, args, client) e devolva o resultado com via_tool: nome. Se houver mais de uma tool, ou faltar parâmetro, não rode: devolva a resposta crua com o hint, como hoje.
4. isServiceNote em C:\Users\Trabalho\Documents\obsidian-environment-variables\src\tools\registry.ts passa a considerar também serviceTag das tools vindas do banco (dbToolsProvider).
5. Em C:\Users\Trabalho\Documents\obsidian-environment-variables\src\main.ts, registre this.app.metadataCache.on("resolved", ...) com this.registerEvent, chamando a mesma rotina de scheduleToolScan (procure por scheduleToolScan no arquivo).
6. toNote em C:\Users\Trabalho\Documents\obsidian-environment-variables\src\tools\obsidianSource.ts monta tags só do frontmatter (tags e tag), normalizadas com normalizeTag. Não use getAllTags. Remova o import se ficar sem uso.
7. A descrição do parâmetro de instância em registry.ts (bloco das escolhas, ~linha 285) não repete a lista de ids; o enum continua.

O que fazer, nesta ordem (cada sub-tópico termina com verificação; se falhar, pare e relate):
3.1 Ache buildEndpointIndex e apiIndexEntries em service.ts. Faça buildEndpointIndex usar getRequestForTool primeiro. Verificação: npm run typecheck → sem erros.
3.2 Implemente a regra 3 em hintFor e no handler de http_request (procure a string "http_request" em src\server\ e em src\tools\service.ts). Use matchEndpoint de src\tools\toolSearch.ts. Acrescente via_tool à resposta quando rodar. Verificação: npm run typecheck → sem erros.
3.3 Implemente as regras 4, 5 e 7 em registry.ts, main.ts e no bloco de escolhas. Verificação: npm run typecheck → sem erros.
3.4 Implemente a regra 6 em obsidianSource.ts. Verificação: npm run typecheck → sem erros.
3.5 Crie C:\Users\Trabalho\Documents\obsidian-environment-variables\tests\endpointIndexDb.test.ts com mocks do dbManager: (a) URL .../issue/ABC-1/changelog acha a tool do banco; (b) GET com uma tool casando roda e devolve via_tool; (c) GET com duas tools casando não roda; (d) toNote ignora tag só no corpo. Ajuste tests\apiIndex.test.ts e tests\toolSearch.test.ts se o contrato mudou. Verificação: npm test -- tests\endpointIndexDb.test.ts → passa; depois npm test → passa.

Critérios (BDD) que você deve provar:
- Dado uma tool do banco com GET /rest/api/3/issue/{key}/changelog, Quando busco .../issue/ABC-1/changelog, Então a busca devolve essa tool.
- Dado GET que casa com uma só tool pronta, sem parâmetro faltando, Então a resposta traz via_tool e o resultado.
- Dado GET que casa com duas tools, Então a resposta é crua com hint e nenhuma tool roda.
- Dado nota de instância criada depois da montagem, Quando o cache fica pronto, Então a tool aparece ready, não invalid.
- Dado tag #jira/instance só no corpo de uma nota, Então a nota não entra no enum de instância.
- Dado a descrição do parâmetro de instância, Então não repete a lista de ids.
- Nada quebrou: npm test passa.

Não faça: não altere mcpDb.ts (só leia); não altere os schemas de list_vault_tools/search_vault_tools/run_vault_tool (outra etapa cuida disso); não altere src\ui\; não rode npm run build.

Se algo não bater com o descrito (método com outro nome, assinatura diferente), pare e relate, sem improvisar.

Relatório final: arquivos criados e alterados com caminho absoluto; saída real de cada verificação; resultado de cada sub-tópico (3.1 a 3.5); desvios e dúvidas.
```

## Etapa 4: Superfície MCP enxuta e run por tools_run [Haiku 5.5 | esforço: alto]

**Objetivo:** remover `list_tools`, `search_vault_tools` e `run_vault_tool` da superfície MCP (itens 7 e 8), e fazer o campo `run` apontar para `tools_run {id, args}` (item 16).
**Depende de:** Etapa 3
**Paralelizável com:** nenhuma

**Arquivos**
- Alterar: `C:\Users\Trabalho\Documents\obsidian-environment-variables\src\tools\service.ts` (lista de tools internas; `callMcp`; remover `list_tools` duplicado)
- Alterar: `C:\Users\Trabalho\Documents\obsidian-environment-variables\src\tools\hubMetadata.ts` (entradas `list_vault_tools`, `search_vault_tools`, `run_vault_tool` em ~linhas 33-57)
- Alterar: `C:\Users\Trabalho\Documents\obsidian-environment-variables\src\tools\toolSearch.ts` (`howToRun`, linha ~157-159)
- Alterar: `C:\Users\Trabalho\Documents\obsidian-environment-variables\src\server\mcp.ts` (`SERVER_INSTRUCTIONS` e `TOOLS_INSTRUCTIONS`, que citam `search_vault_tools` e `run_vault_tool`)
- Alterar: `C:\Users\Trabalho\Documents\obsidian-environment-variables\src\server\localServer.ts` (rota `POST /v1/tools/<nome>`, que chama `run_vault_tool` internamente, linha ~180: passar a chamar o método interno de run, não o nome da tool)
- Alterar: `C:\Users\Trabalho\Documents\obsidian-environment-variables\src\i18n.ts` (chave `settings.toolsEnabledDesc`, linha ~343, que cita `run_vault_tool`)
- Alterar: testes que citam esses nomes (procure `run_vault_tool`, `search_vault_tools`, `list_tools` em `C:\Users\Trabalho\Documents\obsidian-environment-variables\tests\`)
- Não tocar: os textos de `src\tools\guide\*.md` (são da Etapa 9)

**Regras de implementação**
1. Após esta etapa, o MCP expõe no `tools/list`: `list_secrets`, `http_request`, `env_criar_secret` (se existir), o guia `get_tool_authoring_guide`, e as tools de usuário com `expose: true`. Não expõe `list_tools`, `search_vault_tools`, `run_vault_tool`.
2. `list_vault_tools` continua existindo como a função interna `status()` usada pelo REST `GET /v1/tools` e pelo painel, mas sai de `tools/list` (decisão do item 8, que o usuário aceitou). Não apague a função.
3. A busca por endpoint (`search_vault_tools`) continua como função interna `searchTools`, usada pelo `hintFor` (Etapa 3); não é exposta.
4. O campo `run` de cada tool passa a ser `{ "call": "tools_run", "arguments": { "id": "<nome>", "args": { ... } } }` quando `expose` é `false`. Quando `expose` é `true`, continua `{ "call": "<nome>", "arguments": {...} }`.
5. Tools com `expose: false` continuam acessíveis pelo REST `POST /v1/tools/<nome>` (localServer.ts), que chama a função interna de run diretamente.
6. Nas instruções do servidor (`TOOLS_INSTRUCTIONS`), troque a frase de `run_vault_tool` por "run it with tools_run {id, args} when the AI Ecosystem is available". Remova a menção a `search_vault_tools` e use: "Use the tool discovery of your environment (tools_find) to find vault tools; they are not in your tool list." Mantenha o pedido de chamar `get_tool_authoring_guide`.
7. Nenhum teste deve depender de `run_vault_tool` na lista de tools; atualize os testes para o novo contrato.

**Passos**
- **4.1 Lista de tools:** objetivo: a regra 1.
  1. Em `service.ts`, na lista de tools internas, remova `list_tools`, `search_vault_tools` e `run_vault_tool` da lista exposta. Mantenha as funções internas.
  2. Em `callMcp`, deixe `search_vault_tools` e `run_vault_tool` acessíveis só por chamada interna; remova `list_tools` do `if` (ele deixa de existir).
  3. Mantenha `list_vault_tools` fora de `tools/list` (regra 2) e preserve `status()`.
  - Verificação: `npm run typecheck` → sem erros.
- **4.2 Campo run e howToRun:** objetivo: regra 4.
  1. Em `toolSearch.ts`, altere `howToRun`: `expose` true → `{ call: tool.name, arguments: args }`; false → `{ call: "tools_run", arguments: { id: tool.name, args } }`.
  2. Ajuste o tipo `RunHint` se necessário.
  - Verificação: `npm run typecheck` → sem erros.
- **4.3 Instruções e descrições:** objetivo: regra 6.
  1. Em `mcp.ts`, altere `TOOLS_INSTRUCTIONS` e a `description` de `http_request` conforme a regra 6 (remova menções a `run_vault_tool` e `search_vault_tools`).
  2. Em `hubMetadata.ts`, remova as entradas de `list_tools`/`search_vault_tools`/`run_vault_tool` se forem metadados da superfície, ou mantenha só o que o painel usa; diga no relatório o que removeu.
  3. Em `i18n.ts`, na chave `settings.toolsEnabledDesc` (pt e en), troque `run_vault_tool` por `tools_run` quando o texto falar de execução; mantenha `get_tool_authoring_guide` e `list_vault_tools`.
  - Verificação: `npm run typecheck` → sem erros.
- **4.4 REST e testes:** objetivo: regra 5 e regra 7.
  1. Em `localServer.ts` (~linha 180), troque `tools.callMcp("run_vault_tool", { name, arguments }, client)` por chamada direta à função interna de run (ex.: `tools.runTool(name, args, client)`; crie esse método público em `service.ts` se não existir, delegando ao `run` interno).
  2. Procure nos testes `run_vault_tool`, `search_vault_tools`, `list_tools` e atualize as asserções para o novo contrato.
  - Verificação: `npm test` → passa.

**BDD (estado esperado ao concluir)**
- Dado o cliente pede `tools/list`, Quando recebe a lista, Então não há `list_tools`, `search_vault_tools` nem `run_vault_tool`.
- Dado uma tool com expose false, Quando o run é montado, Então o campo `run.call` é `tools_run` com `arguments.id` igual ao nome.
- Dado uma tool com expose true, Quando o run é montado, Então o `call` é o próprio nome.
- Dado `POST /v1/tools/<nome>` com tool expose false, Quando o REST responde, Então a tool roda pela função interna e a resposta é igual à anterior.
- Dado `list_vault_tools` interno (painel e REST `GET /v1/tools`), Quando chamado, Então o resultado não mudou de formato.
- Nada quebrou: npm test passa.

**Verificação**
- `npm run typecheck` → sem erros.
- `npm test` → suíte completa passa.
- `npm run lint` → sem erros novos.

**Prompt para o subagente**
```text
Papel: você é um implementador de código TypeScript. Vai implementar uma única área de um plugin do Obsidian, sem decidir requisitos.

Contexto completo: o projeto é o plugin "Environment Keys" do Obsidian (TypeScript, desktop only). Expõe um servidor MCP local em 127.0.0.1 com tools internas (list_secrets, http_request, list_vault_tools, search_vault_tools, run_vault_tool, list_tools, get_tool_authoring_guide) e tools de usuário (notas com a tag mcp/tool). Raiz absoluta: C:\Users\Trabalho\Documents\obsidian-environment-variables. Código em src\, testes em tests\ (Vitest). Objetivo geral: implementar 23 itens aceitos de uma auditoria; você faz os itens 7, 8 e 16. As Etapas 1 a 3 já foram feitas (save_to, projeção de campos, índice de endpoints com hint via_tool, todas em src\tools\ e src\server\).

Convenções: comentários em inglês. Nenhuma dependência nova; não altere package.json. Não faça commit, push nem branch. Não leia .env nem credenciais. Comandos, com o diretório de trabalho em C:\Users\Trabalho\Documents\obsidian-environment-variables: npm run typecheck, npm test, npm run lint. Não rode npm run build nem npm run deploy.

Regras de implementação:
1. O tools/list do MCP passa a expor: list_secrets, http_request, get_tool_authoring_guide, e as tools de usuário com expose true. Não expõe list_tools, search_vault_tools, run_vault_tool.
2. list_vault_tools sai de tools/list, mas a função interna status() continua existindo e sendo usada pelo REST GET /v1/tools e pelo painel. Não apague status().
3. searchTools (busca por endpoint) continua interna, usada por hintFor; não é exposta.
4. Campo run de cada tool: expose false → { call: "tools_run", arguments: { id: "<nome>", args: {...} } }; expose true → { call: "<nome>", arguments: {...} }. Ajuste howToRun em C:\Users\Trabalho\Documents\obsidian-environment-variables\src\tools\toolSearch.ts.
5. Tools com expose false seguem acessíveis por POST /v1/tools/<nome> (C:\Users\Trabalho\Documents\obsidian-environment-variables\src\server\localServer.ts, ~linha 180), que deve chamar a função interna de run direto, sem passar pelo nome run_vault_tool. Crie um método público em service.ts (ex.: runTool) se preciso.
6. Em C:\Users\Trabalho\Documents\obsidian-environment-variables\src\server\mcp.ts: troque em TOOLS_INSTRUCTIONS a frase sobre run_vault_tool por "run it with tools_run {id, args} when the AI Ecosystem is available"; troque a menção a search_vault_tools por "use the tool discovery of your environment (tools_find) to find vault tools; they are not in your tool list". Mantenha o pedido de chamar get_tool_authoring_guide. Mantenha a description de http_request sem mencionar run_vault_tool.
7. Em i18n.ts (chave settings.toolsEnabledDesc, pt e en), troque run_vault_tool por tools_run; mantenha get_tool_authoring_guide e list_vault_tools.
8. Não altere src\tools\guide\*.md nesta etapa.

O que fazer, nesta ordem (cada sub-tópico termina com verificação; se falhar, pare e relate):
4.1 Em src\tools\service.ts, remova list_tools, search_vault_tools e run_vault_tool da lista exposta de tools (BUILT-IN/listagem) e remova list_tools do if de callMcp; mantenha as funções internas. Verificação: npm run typecheck → sem erros.
4.2 Em src\tools\toolSearch.ts, ajuste howToRun conforme a regra 4. Verificação: npm run typecheck → sem erros.
4.3 Ajuste mcp.ts (regra 6), hubMetadata.ts (remova do que for só metadado de superfície; diga no relatório o que removeu) e i18n.ts (regra 7). Verificação: npm run typecheck → sem erros.
4.4 Ajuste localServer.ts (regra 5) e atualize os testes que citam run_vault_tool, search_vault_tools ou list_tools (procure nos arquivos de C:\Users\Trabalho\Documents\obsidian-environment-variables\tests\). Verificação: npm test → passa.

Critérios (BDD) que você deve provar:
- Dado tools/list, Então não há list_tools, search_vault_tools nem run_vault_tool.
- Dado tool com expose false, Então run.call é tools_run e arguments.id é o nome.
- Dado tool com expose true, Então run.call é o próprio nome.
- Dado POST /v1/tools/<nome> com tool expose false, Então roda pela função interna e a resposta não mudou.
- Dado GET /v1/tools e o painel, Então list_vault_tools interno continua com o mesmo formato.
- Nada quebrou: npm test passa.

Não faça: não altere src\tools\guide\*.md (outra etapa); não altere mcpDb.ts; não altere src\ui\; não rode npm run build.

Se algo não bater com o descrito (nome diferente, assinatura diferente), pare e relate, sem improvisar.

Relatório final: arquivos criados e alterados com caminho absoluto; saída real de cada verificação; resultado de cada sub-tópico (4.1 a 4.4); o que foi removido de hubMetadata.ts; desvios e dúvidas.
```

## Etapa 5: Campos padrão, conversão ADF e paginação por tool [Haiku 5.5 | esforço: alto]

**Objetivo:** cada tool de pacote declara os campos de resposta que devolve (item 6); uma opção `adf: "text"` converte ADF em Markdown (item 10); a paginação automática com limite segue `startAt` ou `nextPageToken` (item 18).
**Depende de:** Etapas 2 e 4
**Paralelizável com:** Etapas 6 e 7 (arquivos diferentes)

**Arquivos**
- Criar: `C:\Users\Trabalho\Documents\obsidian-environment-variables\src\tools\adfText.ts` (conversão ADF → Markdown)
- Criar: `C:\Users\Trabalho\Documents\obsidian-environment-variables\src\tools\pagination.ts`
- Criar: `C:\Users\Trabalho\Documents\obsidian-environment-variables\tests\adfText.test.ts`, `tests\toolPagination.test.ts`
- Alterar: `C:\Users\Trabalho\Documents\obsidian-environment-variables\src\tools\mcpDb.ts` (campo `response_fields` lido do banco, quando existir; só leitura do banco aqui)
- Alterar: `C:\Users\Trabalho\Documents\obsidian-environment-variables\src\tools\service.ts` (aplicar projeção por tool, `adf` e paginação no run)
- Alterar: `C:\Users\Trabalho\Documents\obsidian-environment-variables\src\tools\definition.ts` (se os parâmetros especiais `adf`, `page_limit` forem validados aqui)
- Não tocar: qualquer gerador externo de pacotes (não existe neste repositório; ver dúvida na seção "Ações do usuário")

**Regras de implementação**
1. Item 6: se a linha da tool no banco tiver `response_fields` (lista de caminhos), aplique `projectFields` (de `src\tools\responseShape.ts`) à resposta da tool. Sem `response_fields`, a resposta não muda. Não crie `response_fields` no banco.
2. Item 10: parâmetro opcional `adf` em tools que devolvem ADF (descrição, comentários do Jira). Valor `"text"` converte o ADF em Markdown simples (parágrafos, títulos, listas, código, links, menções); `adf` ausente ou outro valor: ADF intacto. Conversão só para nós conhecidos; nó desconhecido vira o texto de seus filhos.
3. Item 18: paginação só quando a tool recebe `page_limit` (inteiro 1 a 1000; padrão ausente = sem paginação). Segue `startAt` (com `maxResults`/`total`) ou `nextPageToken` (com `isLast`). Para ao atingir `page_limit` ou quando a API indicar fim. Nunca passa de 20 páginas por chamada (limite fixo).
4. A paginação faz chamadas sequenciais (nunca em paralelo), para não estourar o rate limit.
5. Se a resposta paginada passar de `maxResponseMB`, corte e informe `truncated: true`.
6. Os três recursos são opcionais; sem os parâmetros, a resposta é a mesma de hoje.

**Passos**
- **5.1 Conversão ADF:** objetivo: regra 2.
  1. Crie `src\tools\adfText.ts` com `export function adfToMarkdown(node: unknown): string`. Trate: `doc`, `paragraph`, `heading` (nível em `attrs.level`), `bulletList`, `orderedList`, `listItem`, `codeBlock` (com a linguagem), `text` com marcas `strong`, `em`, `code`, `link` (`attrs.href`), `mention` (`attrs.text`), `hardBreak`. Nó desconhecido: concatene o texto dos filhos.
  2. Exporte `export function convertAdfFields(obj: unknown, paths: string[]): unknown` que substitui por Markdown os campos listados (caminhos com ponto) que são ADF.
  - Verificação: `npm run typecheck` → sem erros.
- **5.2 Paginação:** objetivo: regra 3 e 4.
  1. Crie `src\tools\pagination.ts` com `export async function paginate(fetchPage: (cursor: { startAt?: number; nextPageToken?: string }) => Promise<any>, pageLimit: number): Promise<unknown[]>`. Use startAt ou nextPageToken conforme o que a resposta trouxer (startAt + total ou nextPageToken + isLast).
  2. Limite fixo de 20 páginas por chamada.
  - Verificação: `npm run typecheck` → sem erros.
- **5.3 Ligação no run:** objetivo: aplicar tudo em `service.ts` e `mcpDb.ts`.
  1. Em `mcpDb.ts`, leia `response_fields` da linha da tool quando existir (campo opcional; se a coluna não existir, devolva undefined sem erro).
  2. Em `service.ts`, no run de tools com `kind` request: aplique `adf` (se o argumento vier), `page_limit` (com `paginate`) e `response_fields` (com `projectFields`) nesta ordem: paginar, converter ADF, projetar.
  3. Valide `page_limit` e `adf` em `definition.ts` (`checkValue`) só se o schema da tool os declarar; não invente parâmetro para tools sem essa declaração.
  - Verificação: `npm run typecheck` → sem erros.
- **5.4 Testes:** objetivo: cobrir.
  1. `tests\adfText.test.ts`: parágrafo com negrito e link; título nível 2; lista com itens; bloco de código com linguagem; nó desconhecido.
  2. `tests\toolPagination.test.ts`: `startAt` com 3 páginas; `nextPageToken` com `isLast`; limite de 20 páginas; `page_limit` 5 para na 5ª.
  - Verificação: `npm test -- tests\adfText.test.ts` e `npm test -- tests\toolPagination.test.ts` → passam.

**BDD (estado esperado ao concluir)**
- Dado ADF com um parágrafo em negrito e um link, Quando `adfToMarkdown` roda, Então devolve `**texto** [rótulo](url)` no lugar certo.
- Dado nó ADF desconhecido com filhos de texto, Então devolve o texto dos filhos, sem erro.
- Dado `page_limit` 5 e API com 3 páginas de `startAt`, Quando roda, Então devolve os itens das 3 páginas e para.
- Dado `page_limit` ausente, Então faz uma chamada só, como antes.
- Dado tool com `response_fields` no banco, Quando roda, Então a resposta traz só esses campos.
- Dado tool sem `response_fields`, Então a resposta é igual à de antes.
- Nada quebrou: npm test passa.

**Verificação**
- `npm run typecheck` → sem erros.
- `npm test -- tests\adfText.test.ts` e `npm test -- tests\toolPagination.test.ts` → passam.
- `npm test` → suíte completa passa.
- `npm run lint` → sem erros novos.

**Prompt para o subagente**
```text
Papel: você é um implementador de código TypeScript. Vai implementar uma única área de um plugin do Obsidian, sem decidir requisitos.

Contexto completo: o projeto é o plugin "Environment Keys" do Obsidian (TypeScript, desktop only). Expõe um servidor MCP local com tools de pacotes (Jira, Confluence, Bitbucket etc.) guardadas no banco mcp.db e tools de usuário (notas). Raiz absoluta: C:\Users\Trabalho\Documents\obsidian-environment-variables. Código em src\, testes em tests\ (Vitest). Objetivo geral: implementar 23 itens aceitos; você faz os itens 6, 10 e 18. Etapas 1 a 4 já foram feitas: save_to, projeção de campos (src\tools\responseShape.ts, função projectFields), índice de endpoints, e superfície MCP enxuta (run de tools com expose false usa tools_run).

Convenções: comentários em inglês. Nenhuma dependência nova; não altere package.json. Não faça commit, push nem branch. Não leia .env nem credenciais. Comandos, com o diretório de trabalho em C:\Users\Trabalho\Documents\obsidian-environment-variables: npm run typecheck, npm test, npm test -- tests\adfText.test.ts, npm test -- tests\toolPagination.test.ts, npm run lint. Não rode npm run build nem npm run deploy.

Regras de implementação:
1. Item 6: se a linha da tool no banco mcp.db tiver response_fields (lista de caminhos), aplique projectFields à resposta da tool. Sem response_fields, nada muda. Não crie response_fields no banco.
2. Item 10: parâmetro opcional adf em tools que devolvem ADF do Jira. adf: "text" converte para Markdown simples (parágrafo, título, lista, código, link, menção, quebra de linha, negrito, itálico, código inline). Outro valor ou ausente: ADF intacto. Nó desconhecido: texto dos filhos.
3. Item 18: paginação só quando a tool recebe page_limit (inteiro de 1 a 1000). Segue startAt (com total) ou nextPageToken (com isLast). Para ao atingir page_limit, ao fim da API, ou em 20 páginas (limite fixo). Chamadas sequenciais, nunca em paralelo.
4. Se a resposta paginada passar de maxResponseMB (src\settings.ts), corte e informe truncated: true.
5. Os três recursos são opcionais; sem os parâmetros a resposta é igual à de hoje.

O que fazer, nesta ordem (cada sub-tópico termina com verificação; se falhar, pare e relate):
5.1 Crie C:\Users\Trabalho\Documents\obsidian-environment-variables\src\tools\adfText.ts com adfToMarkdown(node) e convertAdfFields(obj, paths). Verificação: npm run typecheck → sem erros.
5.2 Crie C:\Users\Trabalho\Documents\obsidian-environment-variables\src\tools\pagination.ts com paginate(fetchPage, pageLimit). Verificação: npm run typecheck → sem erros.
5.3 Em C:\Users\Trabalho\Documents\obsidian-environment-variables\src\tools\mcpDb.ts, leia response_fields da linha da tool (campo opcional; se a coluna não existir, devolva undefined). Em C:\Users\Trabalho\Documents\obsidian-environment-variables\src\tools\service.ts, no run de tools kind request, aplique nesta ordem: paginar (se page_limit), converter ADF (se adf "text"), projetar (se response_fields). Valide page_limit e adf em definition.ts só se o schema da tool declarar esses parâmetros. Verificação: npm run typecheck → sem erros.
5.4 Crie tests\adfText.test.ts e tests\toolPagination.test.ts com os casos: parágrafo com negrito e link; título nível 2; lista; bloco de código com linguagem; nó desconhecido; startAt com 3 páginas; nextPageToken com isLast; limite de 20 páginas; page_limit 5 para na 5ª. Verificação: as duas npm test -- ... passam.

Critérios (BDD) que você deve provar:
- Dado ADF com parágrafo em negrito e um link, Então adfToMarkdown devolve **texto** [rótulo](url) no lugar certo.
- Dado nó desconhecido com filhos de texto, Então devolve o texto dos filhos, sem erro.
- Dado page_limit 5 e API com 3 páginas startAt, Então devolve os itens das 3 páginas e para.
- Dado page_limit ausente, Então uma chamada só, como antes.
- Dado response_fields no banco, Então a resposta traz só esses campos; sem response_fields, igual a antes.
- Nada quebrou: npm test passa.

Não faça: não crie gerador de pacotes; não altere src\ui\; não altere os guias (src\tools\guide\*.md); não rode npm run build.

Se algo não bater com o descrito (coluna ou função com outro nome), pare e relate, sem improvisar.

Relatório final: arquivos criados e alterados com caminho absoluto; saída real de cada verificação; resultado de cada sub-tópico (5.1 a 5.4); desvios e dúvidas.
```

## Etapa 6: Listagem de segredos enxuta e fim do acesso total para cliente desconhecido [Haiku 5.5 | esforço: alto]

**Objetivo:** `list_secrets` devolve só `name`, `type`, `hosts` e `fullAccess`, com `detail: true` para o resto, e deixa de auditar cada listagem (item 13); um cliente do AI Ecosystem não registrado no plugin passa a não ter nenhum segredo (item 17).
**Depende de:** Etapa 4
**Paralelizável com:** Etapas 5, 7 e 8

**Arquivos**
- Alterar: `C:\Users\Trabalho\Documents\obsidian-environment-variables\src\secrets\broker.ts` (`listSecrets`, linha ~74-83)
- Alterar: `C:\Users\Trabalho\Documents\obsidian-environment-variables\src\server\mcp.ts` (schema de `list_secrets` em `BUILT_IN_TOOLS`: parâmetro `detail`)
- Alterar: `C:\Users\Trabalho\Documents\obsidian-environment-variables\src\main.ts` (`resolveHubClient`, linha ~530-542: fallback)
- Alterar: `C:\Users\Trabalho\Documents\obsidian-environment-variables\src\secrets\types.ts` ou onde `SecretMetadata` está definido (procure `SecretMetadata` em `src\`)
- Alterar: testes em `C:\Users\Trabalho\Documents\obsidian-environment-variables\tests\` que citam `list_secrets` ou `resolveHubClient` (`tests\secretMetadata.test.ts`, `tests\ecosystem.test.ts`)
- Criar: `C:\Users\Trabalho\Documents\obsidian-environment-variables\tests\clientFallback.test.ts`

**Regras de implementação**
1. Item 13: `list_secrets` aceita `detail` (booleano, padrão `false`). Sem `detail`, cada item tem só `name`, `type`, `hosts`, `fullAccess`. Com `detail: true`, tem o resto do `SecretMetadata` atual (descrição, placement, approval etc.).
2. Item 13: a listagem não gera entrada de auditoria. Remova a chamada `this.audit.add({... action: "list" ...})` de `listSecrets` no caminho com sucesso; mantenha o registro quando estiver bloqueado (`outcome: "locked"`), porque é um evento útil.
3. Nunca devolver `value`, `username` ou `id` do segredo, com ou sem `detail`.
4. Item 17: em `resolveHubClient`, quando nenhum cliente registrado casa com o `client.id` ou `client.name`, o cliente recebe `access: { mode: "some", secretIds: [] }` (nenhum segredo). Não use `mode: "all"`. O cliente continua podendo chamar o que não depende de segredo (ex.: list_secrets devolve lista vazia).
5. Não altere o `localClient` do painel (`src\main.ts`, linha ~91): ele continua com `mode: "all"` porque é o próprio usuário no Obsidian.
6. Trate o caso em que o AI Ecosystem registra um cliente novo pela primeira vez: a regra 4 vale; o usuário precisa registrar o cliente nas configurações. Escreva isso no relatório como dúvida.

**Passos**
- **6.1 Listagem:** objetivo: regras 1, 2, 3.
  1. Em `broker.ts`, altere `listSecrets` para receber `detail: boolean = false`; monte o mapeamento de saída conforme a regra 1 (crie `toCompactMetadata(s)` ao lado de `toMetadata`).
  2. Remova o `audit.add` de sucesso; mantenha o de `locked`.
  3. Em `mcp.ts`, adicione `detail: { type: "boolean", description: "Include the full metadata (description, placement rules, approval policy)." }` ao inputSchema de `list_secrets`. Passe o argumento no handler.
  - Verificação: `npm run typecheck` → sem erros.
- **6.2 Fallback de acesso:** objetivo: regra 4 e 5.
  1. Em `main.ts`, em `resolveHubClient`, troque o retorno do fallback para `{ id, name, access: { mode: "some", secretIds: [] } }`.
  2. Confirme que `localClient` continua com `mode: "all"`.
  - Verificação: `npm run typecheck` → sem erros.
- **6.3 Testes:** objetivo: cobrir.
  1. Crie `tests\clientFallback.test.ts`: cliente desconhecido não recebe segredo; cliente registrado com `mode all` recebe.
  2. Atualize `tests\secretMetadata.test.ts` e `tests\ecosystem.test.ts` se assumirem o fallback antigo ou a auditoria de listagem.
  - Verificação: `npm test -- tests\clientFallback.test.ts` → passa; `npm test` → passa.

**BDD (estado esperado ao concluir)**
- Dado um cliente do AI Ecosystem não registrado no plugin, Quando chama list_secrets, Então recebe lista vazia.
- Dado um cliente não registrado, Quando tenta usar `{{secret:NAME}}` em http_request, Então a chamada é recusada antes de inserir o valor.
- Dado list_secrets sem `detail`, Quando devolve a lista, Então cada item tem só name, type, hosts e fullAccess, sem value, username ou id.
- Dado `detail: true`, Então os campos completos aparecem, sem value.
- Dado uma listagem bem-sucedida, Quando termina, Então não há nova entrada de auditoria com action list.
- Dado o painel do Obsidian, Quando lista ou usa segredos, Então continua com acesso total (localClient).
- Nada quebrou: npm test passa.

**Verificação**
- `npm run typecheck` → sem erros.
- `npm test -- tests\clientFallback.test.ts` → passa.
- `npm test` → suíte completa passa.
- `npm run lint` → sem erros novos.

**Prompt para o subagente**
```text
Papel: você é um implementador de código TypeScript. Vai implementar uma única área de um plugin do Obsidian, com foco em segurança, sem decidir requisitos.

Contexto completo: o projeto é o plugin "Environment Keys" do Obsidian (TypeScript, desktop only). Guarda segredos cifrados e os usa em requisições HTTP de agentes de IA sem mostrar os valores. Raiz absoluta: C:\Users\Trabalho\Documents\obsidian-environment-variables. Código em src\, testes em tests\ (Vitest). Objetivo geral: implementar 23 itens aceitos; você faz os itens 13 e 17. Etapas 1 a 5 já foram feitas (http_request com save_to, projeção, índice, superfície MCP, campos e paginação de tools). Não altere essas partes.

Convenções: comentários em inglês. Nenhuma dependência nova; não altere package.json. Não faça commit, push nem branch. Não leia .env nem credenciais. Nunca escreva, logue ou devolva valor de segredo. Comandos, com o diretório de trabalho em C:\Users\Trabalho\Documents\obsidian-environment-variables: npm run typecheck, npm test, npm test -- tests\clientFallback.test.ts, npm run lint. Não rode npm run build nem npm run deploy.

Regras de implementação:
1. list_secrets aceita detail (booleano, padrão false). Sem detail, cada item tem só name, type, hosts e fullAccess. Com detail true, tem os campos completos atuais de SecretMetadata. Nunca value, username ou id, com ou sem detail.
2. A listagem bem-sucedida não gera entrada de auditoria (action "list"). O registro de bloqueio (outcome "locked") continua.
3. Em C:\Users\Trabalho\Documents\obsidian-environment-variables\src\main.ts, em resolveHubClient (~linha 530-542), cliente não registrado recebe access { mode: "some", secretIds: [] }. Nunca mode "all" para cliente desconhecido.
4. O localClient do painel (~linha 91 de main.ts, { id: "obsidian", access: { mode: "all" } }) não muda.

O que fazer, nesta ordem (cada sub-tópico termina com verificação; se falhar, pare e relate):
6.1 Em C:\Users\Trabalho\Documents\obsidian-environment-variables\src\secrets\broker.ts, altere listSecrets (~linha 74-83) para aceitar detail (padrão false); crie toCompactMetadata ao lado de toMetadata; remova o audit.add de sucesso; mantenha o de locked. Em C:\Users\Trabalho\Documents\obsidian-environment-variables\src\server\mcp.ts, adicione detail (boolean) ao inputSchema de list_secrets e passe o argumento ao broker. Verificação: npm run typecheck → sem erros.
6.2 Em main.ts, troque o fallback de resolveHubClient para access { mode: "some", secretIds: [] }. Verificação: npm run typecheck → sem erros.
6.3 Crie C:\Users\Trabalho\Documents\obsidian-environment-variables\tests\clientFallback.test.ts: cliente desconhecido recebe lista vazia no list_secrets e não consegue usar {{secret:NAME}} (erro antes de inserir valor); cliente registrado com mode all continua recebendo. Atualize tests\secretMetadata.test.ts e tests\ecosystem.test.ts se assumirem o comportamento antigo. Verificação: npm test -- tests\clientFallback.test.ts → passa; npm test → passa.

Critérios (BDD) que você deve provar:
- Dado cliente não registrado, Quando chama list_secrets, Então recebe lista vazia.
- Dado cliente não registrado, Quando usa {{secret:NAME}} em http_request, Então a chamada é recusada antes de inserir o valor.
- Dado list_secrets sem detail, Então cada item tem só name, type, hosts, fullAccess; sem value, username ou id.
- Dado detail true, Então os campos completos aparecem, sem value.
- Dado listagem bem-sucedida, Então não há nova entrada action "list" na auditoria.
- Dado o painel, Então localClient continua com acesso total.
- Nada quebrou: npm test passa.

Não faça: não altere a cifragem (src\crypto\); não altere src\secrets\redact.ts; não altere src\ui\; não altere os guias; não rode npm run build; não remova a auditoria de bloqueio.

Se algo não bater com o descrito (função ou campo com outro nome), pare e relate, sem improvisar.

Relatório final: arquivos criados e alterados com caminho absoluto; saída real de cada verificação; resultado de cada sub-tópico (6.1 a 6.3); desvios e dúvidas, inclusive sobre clientes do AI Ecosystem ainda não registrados.
```

## Etapa 7: Argumentos numéricos e limites de scripts de tool [Haiku 5.5 | esforço: médio]

**Objetivo:** aceitar número e booleano onde o spec pede string (item 15) e pôr limites nas chamadas de `ctx.http` e no tempo total dos scripts, com log do `ctx.log` (item 19).
**Depende de:** Etapa 5
**Paralelizável com:** Etapa 6, 8

**Arquivos**
- Alterar: `C:\Users\Trabalho\Documents\obsidian-environment-variables\src\tools\definition.ts` (`checkValue` e `validateArgs`, ~linhas 196-240)
- Alterar: `C:\Users\Trabalho\Documents\obsidian-environment-variables\src\tools\service.ts` (bridge de `ctx.http`, ~linha 300-316; ligação do `onLog`)
- Alterar: `C:\Users\Trabalho\Documents\obsidian-environment-variables\src\tools\scriptRunner.ts` (`job.onLog`, linha ~75 e ~155; limite de chamadas)
- Criar: `C:\Users\Trabalho\Documents\obsidian-environment-variables\tests\argsAndScriptLimits.test.ts`
- Não tocar: `C:\Users\Trabalho\Documents\obsidian-environment-variables\src\tools\requestNote.ts`

**Regras de implementação**
1. Item 15: quando o spec é `string` e o valor é `number` (finito) ou `boolean`, converta para string com `String(value)` antes de validar; o valor convertido segue para a requisição. Para spec `number`/`integer`/`boolean`, o comportamento não muda. Converta só esse caso.
2. Item 19: o `ctx.log` do script chega ao `onLog` do runner; a linha vai para o log de atividade já existente (use a função de log do service, se houver; senão `console.debug` nunca com valor de segredo). Mascare a linha com `redact` antes de registrar.
3. Item 19: limite de 200 chamadas de `ctx.http` por execução. Ao passar, a chamada lança erro `limit_reached` para o script (não derruba o runner).
4. Item 19: tempo total do script limitado por `scriptTimeoutSeconds` (já existe em `settings`); confirme que a contagem usa o mesmo limite em todas as chamadas de `ctx.http` (não reinicie o contador por chamada).
5. Nada disso altera o sandbox (sem rede, sem Node, sem timers).

**Passos**
- **7.1 Conversão de tipo:** objetivo: regra 1.
  1. Em `definition.ts`, em `validateArgs`, para cada parâmetro com `spec.type === "string"` e valor `number` finito ou `boolean`, troque por `String(value)` antes de chamar `checkValue`.
  2. Mantenha a regra de enum: converta antes e valide o enum com o texto.
  - Verificação: `npm run typecheck` → sem erros.
- **7.2 Log do script:** objetivo: regra 2.
  1. Em `service.ts`, ao chamar `this.deps.runner.run({...})`, passe `onLog: (line) => <função de log existente, com redact>`. Procure um logger existente (`activity`, `log`, `audit`) em `service.ts`/`main.ts`; use o que já existe, não crie um novo sistema de log.
  - Verificação: `npm run typecheck` → sem erros.
- **7.3 Limite de chamadas:** objetivo: regra 3 e 4.
  1. Em `service.ts`, no `bridge`/`ctx.http`, conte as chamadas por execução. Ao chegar a 200, lance erro `limit_reached` com mensagem clara.
  2. Confirme que o timeout total já vem de `timeoutMs` (`scriptTimeoutSeconds * 1000`) e não é reiniciado por chamada.
  - Verificação: `npm run typecheck` → sem erros.
- **7.4 Testes:** objetivo: cobrir.
  1. Crie `tests\argsAndScriptLimits.test.ts`: número 5 em parâmetro string vira "5"; booleano true vira "true"; número em parâmetro number continua número; enum com número convertido; 201ª chamada de `ctx.http` falha com `limit_reached`; linha de `ctx.log` com valor de segredo sai mascarada.
  - Verificação: `npm test -- tests\argsAndScriptLimits.test.ts` → passa; `npm test` → passa.

**BDD (estado esperado ao concluir)**
- Dado `jira_get_changelogs` com `maxResults` 5 (spec string), Quando chamado, Então a chamada é aceita e o valor segue como "5".
- Dado parâmetro number com valor string "5", Então continua rejeitado com "must be of type number".
- Dado um script que chama `ctx.log` com um valor de segredo, Quando roda, Então a linha registrada sai com `***`.
- Dado um script que chama `ctx.http` 201 vezes, Quando roda, Então a 201ª falha com `limit_reached` e o runner segue vivo.
- Dado script com timeout de N segundos, Quando faz várias chamadas, Então o tempo total respeita N, sem reinício por chamada.
- Nada quebrou: npm test passa.

**Verificação**
- `npm run typecheck` → sem erros.
- `npm test -- tests\argsAndScriptLimits.test.ts` → passa.
- `npm test` → suíte completa passa.
- `npm run lint` → sem erros novos.

**Prompt para o subagente**
```text
Papel: você é um implementador de código TypeScript. Vai implementar uma única área de um plugin do Obsidian, sem decidir requisitos.

Contexto completo: o projeto é o plugin "Environment Keys" do Obsidian (TypeScript, desktop only). Tools do cofre são notas que viram tools MCP; tools do tipo script rodam em QuickJS (sandbox sem rede, sem Node) com a API ctx (ctx.requests.run, ctx.http, ctx.notes.get, ctx.notes.query, ctx.log). Raiz absoluta: C:\Users\Trabalho\Documents\obsidian-environment-variables. Código em src\, testes em tests\ (Vitest). Objetivo geral: implementar 23 itens aceitos; você faz os itens 15 e 19. Etapas 1 a 6 já foram feitas; não altere save_to, projeção, índice, superfície MCP, listagem de segredos nem fallback de cliente.

Convenções: comentários em inglês. Nenhuma dependência nova; não altere package.json. Não faça commit, push nem branch. Não leia .env nem credenciais. Nunca escreva valor de segredo. Comandos, com o diretório de trabalho em C:\Users\Trabalho\Documents\obsidian-environment-variables: npm run typecheck, npm test, npm test -- tests\argsAndScriptLimits.test.ts, npm run lint. Não rode npm run build nem npm run deploy.

Regras de implementação:
1. Item 15: em validateArgs (C:\Users\Trabalho\Documents\obsidian-environment-variables\src\tools\definition.ts, ~linhas 196-240), quando spec.type é "string" e o valor é número finito ou booleano, converta com String(value) antes de checkValue. Converta só esse caso. Para number, integer e boolean, nada muda. Valide o enum depois da conversão.
2. Item 19: a linha de ctx.log chega ao onLog do runner (C:\Users\Trabalho\Documents\obsidian-environment-variables\src\tools\scriptRunner.ts, ~linhas 75 e 155). Em service.ts, passe onLog para registrar a linha no log de atividade já existente, depois de redact. Use um logger que já exista no projeto; não crie sistema novo.
3. Item 19: no bridge de ctx.http (service.ts, ~linhas 300-316), limite de 200 chamadas por execução; ao passar, lance erro com código limit_reached (use ToolError existente).
4. Item 19: o timeout total já vem de scriptTimeoutSeconds (timeoutMs). Confirme que não é reiniciado por chamada.

O que fazer, nesta ordem (cada sub-tópico termina com verificação; se falhar, pare e relate):
7.1 Em definition.ts, aplique a regra 1 em validateArgs. Verificação: npm run typecheck → sem erros.
7.2 Em service.ts, passe onLog para runner.run, com redact e um logger existente. Verificação: npm run typecheck → sem erros.
7.3 Em service.ts, conte as chamadas de ctx.http por execução e aplique a regra 3. Verifique a regra 4. Verificação: npm run typecheck → sem erros.
7.4 Crie C:\Users\Trabalho\Documents\obsidian-environment-variables\tests\argsAndScriptLimits.test.ts: "5" de número em parâmetro string; true em string vira "true"; número em parâmetro number continua número; enum com valor convertido; 201ª chamada de ctx.http falha com limit_reached; linha de ctx.log com segredo sai com ***. Verificação: npm test -- tests\argsAndScriptLimits.test.ts → passa; npm test → passa.

Critérios (BDD) que você deve provar:
- Dado jira_get_changelogs com maxResults 5 (spec string), Então a chamada é aceita e o valor segue como "5".
- Dado parâmetro number com valor "5" (texto), Então continua rejeitado com "must be of type number".
- Dado script que chama ctx.log com um segredo, Então a linha registrada sai com ***.
- Dado script com 201 chamadas de ctx.http, Então a 201ª falha com limit_reached e o runner segue.
- Dado timeout de N segundos, Então o total respeita N, sem reinício por chamada.
- Nada quebrou: npm test passa.

Não faça: não altere o sandbox (sem rede, sem Node, sem timers); não altere requestNote.ts; não altere src\ui\; não rode npm run build.

Se algo não bater com o descrito (função ou nome diferente), pare e relate, sem improvisar.

Relatório final: arquivos criados e alterados com caminho absoluto; saída real de cada verificação; resultado de cada sub-tópico (7.1 a 7.4); desvios e dúvidas.
```

## Etapa 8: Textos pt-BR da chave de recuperação corrigidos [Haiku 5.5 | esforço: médio]

**Objetivo:** restaurar os acentos corrompidos das strings pt-BR (item 20) e impedir que o problema volte.
**Depende de:** Etapa 4
**Paralelizável com:** Etapas 5, 6, 7

**Arquivos**
- Alterar: `C:\Users\Trabalho\Documents\obsidian-environment-variables\src\i18n.ts` (linhas ~498-515 e as outras linhas pt com `?` corrompido; procure por `??`, `?rea`, `voc?`, `?NICA`, `?` seguido de letra)
- Alterar: `C:\Users\Trabalho\Documents\obsidian-environment-variables\src\ui\recoveryModals.ts` (linha ~171)
- Criar: `C:\Users\Trabalho\Documents\obsidian-environment-variables\tests\i18nPt.test.ts`
- Não tocar: os textos en de `i18n.ts`, exceto se estiverem corrompidos também

**Regras de implementação**
1. Restaure os acentos e cedilhas corretos em cada string pt-BR corrompida (`recuperação`, `área de transferência`, `você`, `É`, `ÚNICA`, `não`, etc.). Não reescreva o sentido da frase.
2. O padrão de corrupção é `?` no lugar de letra acentuada ou cedilha, e `??` no lugar de `çã`. Ao corrigir, confira que o texto ficou em português correto.
3. Não altere chaves de tradução, só os valores.
4. O teste `tests\i18nPt.test.ts` falha se alguma string pt contiver o padrão `\w\?\w` (letra, `?`, letra), exceto em caracteres de comando (ex.: `{{`, `?`). Liste as exceções no próprio teste.
5. Não altere a ordem das chaves nem a estrutura do objeto.

**Passos**
- **8.1 Correção:** objetivo: regras 1 a 3.
  1. Abra `i18n.ts` e localize todas as strings pt com `?` no lugar de letra (procure por `\w\?\w` no bloco pt; ver também `src\ui\recoveryModals.ts`).
  2. Corrija cada uma com o texto em português correto.
  3. Corrija a string em `recoveryModals.ts` (~linha 171).
  - Verificação: `npm run typecheck` → sem erros.
- **8.2 Teste:** objetivo: regra 4.
  1. Crie `tests\i18nPt.test.ts` que importa o dicionário pt de `src\i18n.ts` e falha se alguma string tiver `\w\?\w`. Exporte o dicionário se ele ainda não for exportado (sem mudar o comportamento).
  - Verificação: `npm test -- tests\i18nPt.test.ts` → passa; `npm test -- tests\i18n.test.ts` → passa.

**BDD (estado esperado ao concluir)**
- Dado a chave `view.recovery.showTitle` em pt, Quando lida, Então o texto é "Guarde sua chave de recuperação".
- Dado a chave `view.recovery.copied` em pt, Quando lida, Então o texto contém "área de transferência".
- Dado qualquer string pt do dicionário, Quando o teste roda, Então nenhuma contém o padrão letra-?-letra.
- Dado a interface em português, Quando a tela de recuperação abre, Então não aparece nenhum `?` no meio de palavra.
- Nada quebrou: npm test passa, inclusive tests\i18n.test.ts.

**Verificação**
- `npm run typecheck` → sem erros.
- `npm test -- tests\i18nPt.test.ts` → passa.
- `npm test` → suíte completa passa.
- `npm run lint` → sem erros novos.

**Prompt para o subagente**
```text
Papel: você é um implementador de código TypeScript. Vai corrigir textos de interface em português, sem reescrever o sentido.

Contexto completo: o projeto é o plugin "Environment Keys" do Obsidian (TypeScript, desktop only). As strings de interface ficam em C:\Users\Trabalho\Documents\obsidian-environment-variables\src\i18n.ts, com chaves em inglês e valores em pt e en. Raiz absoluta: C:\Users\Trabalho\Documents\obsidian-environment-variables. Testes em C:\Users\Trabalho\Documents\obsidian-environment-variables\tests\ (Vitest). Objetivo geral: implementar 23 itens aceitos; você faz o item 20: textos pt-BR corrompidos (ex.: "recupera??o", "?rea de transfer?ncia", "voc?", "?NICA", "?rea"). As etapas anteriores não tocaram nessas strings.

Convenções: comentários em inglês. Nenhuma dependência nova; não altere package.json. Não faça commit, push nem branch. Não leia .env nem credenciais. Comandos, com o diretório de trabalho em C:\Users\Trabalho\Documents\obsidian-environment-variables: npm run typecheck, npm test, npm test -- tests\i18nPt.test.ts, npm test -- tests\i18n.test.ts, npm run lint. Não rode npm run build nem npm run deploy.

Regras de implementação:
1. Restaure acentos e cedilhas corretos em cada string pt corrompida (ex.: recuperação, área de transferência, você, ÚNICA). Não mude o sentido da frase.
2. Padrão de corrupção: "?" no lugar de letra acentuada ou cedilha; "??" no lugar de "çã". Confira o resultado em português correto.
3. Não altere chaves; só valores. Não reordene o objeto.
4. Crie tests\i18nPt.test.ts que falha se alguma string pt contiver o padrão letra-?-letra (regex \w\?\w). Exporte o dicionário pt de i18n.ts só se ele não for exportado, sem mudar comportamento.
5. As strings en de i18n.ts só mudam se também estiverem corrompidas.

O que fazer, nesta ordem (cada sub-tópico termina com verificação; se falhar, pare e relate):
8.1 Em C:\Users\Trabalho\Documents\obsidian-environment-variables\src\i18n.ts, localize as strings pt com o padrão (há cerca de 9 linhas na faixa 498-515 e outras). Corrija todas. Em C:\Users\Trabalho\Documents\obsidian-environment-variables\src\ui\recoveryModals.ts, corrija a string da linha ~171. Verificação: npm run typecheck → sem erros.
8.2 Crie C:\Users\Trabalho\Documents\obsidian-environment-variables\tests\i18nPt.test.ts conforme a regra 4. Verificação: npm test -- tests\i18nPt.test.ts → passa; npm test -- tests\i18n.test.ts → passa.

Critérios (BDD) que você deve provar:
- Dado a chave view.recovery.showTitle em pt, Então o texto é "Guarde sua chave de recuperação".
- Dado a chave view.recovery.copied em pt, Então o texto contém "área de transferência".
- Dado qualquer string pt, Então nenhuma contém o padrão letra-?-letra.
- Dado a tela de recuperação em português, Então não aparece "?" no meio de palavra.
- Nada quebrou: npm test passa.

Não faça: não altere textos en (salvo corrupção); não altere lógica de telas; não altere src\ui\ além da linha indicada; não rode npm run build.

Se algo não bater com o descrito, pare e relate, sem improvisar.

Relatório final: arquivos alterados com caminho absoluto; lista das strings corrigidas (chave e texto novo); saída real de cada verificação; desvios e dúvidas.
```

## Etapa 9: Guia de autoria por tópicos [Haiku 5.5 | esforço: alto]

**Objetivo:** o `get_tool_authoring_guide` e o prompt `configure_vault_tools` deixam de entregar 36,5 mil caracteres de uma vez; passam a aceitar `topic` e devolver um índice curto, com o conteúdo do tópico pedido (item 22). Também atualizam os guias para o novo contrato da Etapa 4.
**Depende de:** Etapas 4, 5 e 7
**Paralelizável com:** Etapa 8

**Arquivos**
- Alterar: `C:\Users\Trabalho\Documents\obsidian-environment-variables\src\tools\guide.ts`
- Alterar: `C:\Users\Trabalho\Documents\obsidian-environment-variables\src\tools\guide\guide.pt.md` e `guide.en.md`
- Alterar: `C:\Users\Trabalho\Documents\obsidian-environment-variables\src\tools\guide\setup.pt.md` e `setup.en.md`
- Alterar: `C:\Users\Trabalho\Documents\obsidian-environment-variables\src\server\mcp.ts` (schema da tool `get_tool_authoring_guide` e argumento `topic` do prompt `configure_vault_tools`)
- Alterar: `C:\Users\Trabalho\Documents\obsidian-environment-variables\src\server\localServer.ts` (rota `GET /v1/tools/guide`, aceitar `topic`)
- Criar: `C:\Users\Trabalho\Documents\obsidian-environment-variables\tests\guideTopics.test.ts`
- Não tocar: `C:\Users\Trabalho\Documents\obsidian-environment-variables\src\tools\service.ts` (exceto se o schema da tool de guia estiver lá; nesse caso só o schema)

**Regras de implementação**
1. `topic` é opcional. Sem `topic`, a resposta é um índice curto (até ~1.500 caracteres): título de cada tópico e como pedi-lo. Com `topic` válido, a resposta é só a seção desse tópico. `topic` inválido: erro com a lista de tópicos válidos.
2. Divida os guias em tópicos por cabeçalho `##` (o próprio arquivo `.md` já tem cabeçalhos). Cada tópico tem um slug em inglês (ex.: `note-formats`, `service-notes`, `tools`, `scripts`, `security`, `plan`) igual nos dois idiomas. O idioma segue o do plugin (`settings.language`).
3. O prompt `configure_vault_tools` aceita o argumento `topic` opcional, com a mesma regra.
4. Os guias, que hoje citam `list_vault_tools`, `search_vault_tools` e `run_vault_tool`, passam a usar o contrato da Etapa 4: a tool de busca é `tools_find` do AI Ecosystem quando disponível; `list_vault_tools` continua listado como ferramenta do cliente quando existir. Escreva as duas alternativas em um único parágrafo.
5. Não remova regras de segurança dos guias. Cada regra que estava no arquivo tem que estar em algum tópico. Confira com o `grep` do passo 9.4.
6. Os guias são lidos com o `text` loader do esbuild (ver `src\types\md.d.ts`); não mude a forma de importar.

**Passos**
- **9.1 Índice e tópicos:** objetivo: regras 1 e 2.
  1. Em `guide.ts`, crie `export function guideTopics(lang): { slug, title }[]` e `export function guideTopic(lang, slug): string | undefined`, lendo as seções dos `.md` pelo cabeçalho `##`.
  2. Crie `export function guideIndex(lang): string` que devolve o índice (até ~1.500 caracteres) com "Pass topic: <slug> to read a section".
  - Verificação: `npm run typecheck` → sem erros.
- **9.2 Ligação:** objetivo: regras 1 e 3.
  1. Em `mcp.ts` e `localServer.ts`, aceite `topic` e devolva `guideIndex` sem `topic`, `guideTopic` com `topic` válido, erro com a lista para `topic` inválido.
  2. Atualize o schema de `get_tool_authoring_guide` em `mcp.ts`.
  - Verificação: `npm run typecheck` → sem erros.
- **9.3 Conteúdo:** objetivo: regra 4.
  1. Nos quatro arquivos `.md`, troque as menções ao contrato antigo conforme a regra 4.
  2. Mantenha os cabeçalhos `##` com os slugs definidos.
  - Verificação: `npm test -- tests\guideTopics.test.ts` (criado no 9.4) → passa.
- **9.4 Testes:** objetivo: regra 5.
  1. Crie `tests\guideTopics.test.ts`: índice tem menos de 1.500 caracteres; cada slug devolve conteúdo não vazio; slug inválido devolve erro com a lista; antes e depois, cada regra de segurança listada no arquivo original continua presente em algum tópico (teste por palavras-chave: "allowed hosts", "{{secret:", "never", "approval").
  2. Atualize `tests\` que checam o guia completo, se houver.
  - Verificação: `npm test -- tests\guideTopics.test.ts` → passa; `npm test` → passa.

**BDD (estado esperado ao concluir)**
- Dado get_tool_authoring_guide sem topic, Quando roda, Então a resposta tem menos de 1.500 caracteres e lista os slugs.
- Dado topic "security", Quando roda, Então devolve só a seção de segurança.
- Dado topic inexistente, Quando roda, Então erro com a lista de tópicos válidos.
- Dado o prompt configure_vault_tools com topic, Quando pedido, Então devolve a mesma seção.
- Dado os guias pt e en, Quando comparados, Então têm os mesmos slugs.
- Nada quebrou: npm test passa.

**Verificação**
- `npm run typecheck` → sem erros.
- `npm test -- tests\guideTopics.test.ts` → passa.
- `npm test` → suíte completa passa.
- `npm run lint` → sem erros novos.

**Prompt para o subagente**
```text
Papel: você é um implementador de código TypeScript e redator técnico de guias. Vai dividir um guia em tópicos sem perder regra nenhuma.

Contexto completo: o projeto é o plugin "Environment Keys" do Obsidian (TypeScript, desktop only). Ele expõe um guia de autoria de tools para agentes de IA, em Markdown, em C:\Users\Trabalho\Documents\obsidian-environment-variables\src\tools\guide\ (guide.pt.md, guide.en.md, setup.pt.md, setup.en.md), com cerca de 36,5 mil caracteres. Hoje o guia inteiro vai numa só resposta da tool get_tool_authoring_guide e do prompt configure_vault_tools. Raiz absoluta: C:\Users\Trabalho\Documents\obsidian-environment-variables. Código em src\, testes em tests\ (Vitest). Objetivo geral: implementar 23 itens aceitos; você faz o item 22. Na Etapa 4, as tools list_tools, search_vault_tools e run_vault_tool saíram da lista do MCP; tools_run (do AI Ecosystem) passou a ser o caminho para tools com expose false. Os guias precisam refletir isso.

Convenções: comentários em inglês; textos do guia no idioma de cada arquivo. Nenhuma dependência nova; não altere package.json. Não faça commit, push nem branch. Não leia .env nem credenciais. Comandos, com o diretório de trabalho em C:\Users\Trabalho\Documents\obsidian-environment-variables: npm run typecheck, npm test, npm test -- tests\guideTopics.test.ts, npm run lint. Não rode npm run build nem npm run deploy.

Regras de implementação:
1. topic é opcional. Sem topic: índice curto (até ~1.500 caracteres) com título e slug de cada tópico e a frase "Pass topic: <slug> to read a section". Com topic válido: só a seção. Topic inválido: erro com a lista de slugs válidos.
2. Tópicos por cabeçalho "## " de cada arquivo .md. Slugs em inglês, iguais nos dois idiomas (ex.: note-formats, service-notes, tools, scripts, security, plan). Escolha o idioma pelo settings.language do plugin (procure language em src\settings.ts).
3. O prompt configure_vault_tools aceita topic opcional, com a mesma regra.
4. Nos guias, o contrato novo: a busca de tools é tools_find do AI Ecosystem quando disponível; list_vault_tools continua disponível como ferramenta do cliente quando existir. Escreva as duas alternativas num parágrafo. Não cite run_vault_tool nem search_vault_tools como ferramentas de cliente.
5. Nenhuma regra de segurança some. Cada regra do arquivo original tem que estar em algum tópico.
6. Os .md são importados como texto pelo esbuild (ver C:\Users\Trabalho\Documents\obsidian-environment-variables\src\types\md.d.ts). Não mude a forma de importar.

O que fazer, nesta ordem (cada sub-tópico termina com verificação; se falhar, pare e relate):
9.1 Em C:\Users\Trabalho\Documents\obsidian-environment-variables\src\tools\guide.ts, crie guideTopics(lang), guideTopic(lang, slug) e guideIndex(lang), lendo as seções pelos cabeçalhos "## ". Verificação: npm run typecheck → sem erros.
9.2 Em C:\Users\Trabalho\Documents\obsidian-environment-variables\src\server\mcp.ts, aceite topic em get_tool_authoring_guide (schema) e no prompt configure_vault_tools (argumento). Em C:\Users\Trabalho\Documents\obsidian-environment-variables\src\server\localServer.ts, aceite topic em GET /v1/tools/guide (query string ?topic=). Verificação: npm run typecheck → sem erros.
9.3 Nos quatro arquivos .md de C:\Users\Trabalho\Documents\obsidian-environment-variables\src\tools\guide\, atualize as menções ao contrato conforme a regra 4. Verificação: npm test -- tests\guideTopics.test.ts → passa (depois de 9.4).
9.4 Crie C:\Users\Trabalho\Documents\obsidian-environment-variables\tests\guideTopics.test.ts: índice com menos de 1.500 caracteres; cada slug devolve texto não vazio; slug inválido devolve erro com a lista; pt e en têm os mesmos slugs; palavras-chave de segurança ("allowed hosts", "{{secret:", "never", "approval") continuam presentes nos guias. Ajuste testes que checavam o guia inteiro. Verificação: npm test -- tests\guideTopics.test.ts → passa; npm test → passa.

Critérios (BDD) que você deve provar:
- Dado get_tool_authoring_guide sem topic, Então a resposta tem menos de 1.500 caracteres e lista os slugs.
- Dado topic "security", Então devolve só a seção de segurança.
- Dado topic inexistente, Então erro com a lista de slugs.
- Dado configure_vault_tools com topic, Então devolve a mesma seção.
- Dado pt e en, Então os slugs são iguais.
- Nada quebrou: npm test passa.

Não faça: não remova regra de segurança; não invente regra nova; não altere src\ui\; não altere a forma de importar os .md; não rode npm run build.

Se algo não bater com o descrito (arquivo com outro nome, cabeçalho diferente), pare e relate, sem improvisar.

Relatório final: arquivos alterados com caminho absoluto; lista de tópicos (slug e título) em pt; saída real de cada verificação; resultado de cada sub-tópico (9.1 a 9.4); desvios e dúvidas.
```

## Etapa 10: Higiene de testes e listagem com limite [Haiku 5.5 | esforço: médio]

**Objetivo:** apagar o rascunho de medição, pôr `limit` e `offset` na listagem de `list_vault_tools` e mostrar a dica do `http_request` uma vez por tool (item 23).
**Depende de:** Etapa 4
**Paralelizável com:** Etapas 8, 9

**Arquivos**
- Excluir: `C:\Users\Trabalho\Documents\obsidian-environment-variables\tests\_measure.test.ts`
- Alterar: `C:\Users\Trabalho\Documents\obsidian-environment-variables\src\tools\service.ts` (`status()` ~linha 208; `hintFor` ~linha 395)
- Alterar: `C:\Users\Trabalho\Documents\obsidian-environment-variables\src\server\mcp.ts` (schema de `list_vault_tools`: `limit`, `offset`)
- Criar: `C:\Users\Trabalho\Documents\obsidian-environment-variables\tests\listLimit.test.ts`

**Regras de implementação**
1. Apague `_measure.test.ts` (é um rascunho; não está em uso). Confirme antes que nenhum import aponta para ele.
2. `list_vault_tools` aceita `limit` (inteiro 1 a 200, padrão 50) e `offset` (inteiro ≥ 0, padrão 0). A resposta traz `total` (quantos tools casaram) e `next_offset` (ou `null`). A listagem sem filtro deixa de devolver o registro inteiro.
3. A dica `hint` do `http_request` (via `hintFor`, Etapa 3) é mostrada uma vez por tool por sessão do cliente: mantenha um conjunto de nomes já mostrados, por cliente; a segunda vez a dica vem só com `tool` (sem `message` nem `run`).
4. Não altere a forma das outras chaves de `status()`.

**Passos**
- **10.1 Apagar rascunho:** objetivo: regra 1.
  1. Confirme com Grep em `C:\Users\Trabalho\Documents\obsidian-environment-variables\tests\` que nada importa `_measure`.
  2. Apague `tests\_measure.test.ts`.
  - Verificação: `npm test` → passa.
- **10.2 Listagem com limite:** objetivo: regra 2 e 4.
  1. Em `status()` de `service.ts`, aplique `offset` e `limit` ao array `tools` depois dos filtros; devolva `total`, `next_offset`.
  2. Em `mcp.ts`, adicione `limit` e `offset` ao schema de `list_vault_tools`.
  - Verificação: `npm run typecheck` → sem erros.
- **10.3 Dica uma vez:** objetivo: regra 3.
  1. Em `hintFor` de `service.ts`, mantenha um `Set<string>` de nomes já informados por cliente (chave: `client.id`). Na primeira vez, devolva o hint completo; depois, só `{ tool }`.
  - Verificação: `npm run typecheck` → sem erros.
- **10.4 Testes:** objetivo: cobrir.
  1. Crie `tests\listLimit.test.ts`: limit 2 devolve 2 e `next_offset` 2; offset 2 devolve os seguintes; sem filtro, `total` é o número real; segunda chamada do hint vem reduzida.
  - Verificação: `npm test -- tests\listLimit.test.ts` → passa; `npm test` → passa.

**BDD (estado esperado ao concluir)**
- Dado `tests\_measure.test.ts` removido, Quando `npm test` roda, Então passa sem ele.
- Dado list_vault_tools com limit 2 e 5 tools, Quando roda, Então devolve 2 tools, `total` 5 e `next_offset` 2.
- Dado list_vault_tools com offset 4 e limit 2, Quando roda, Então devolve a 5ª tool e `next_offset` null.
- Dado limit 500, Quando roda, Então erro de validação (máximo 200).
- Dado a mesma tool chamada duas vezes pelo mesmo cliente, Quando o http_request casa com ela, Então a segunda dica não traz `message` nem `run`.
- Nada quebrou: npm test passa.

**Verificação**
- `npm run typecheck` → sem erros.
- `npm test -- tests\listLimit.test.ts` → passa.
- `npm test` → suíte completa passa.
- `npm run lint` → sem erros novos.

**Prompt para o subagente**
```text
Papel: você é um implementador de código TypeScript. Vai fazer uma limpeza e duas mudanças pequenas e bem definidas.

Contexto completo: o projeto é o plugin "Environment Keys" do Obsidian (TypeScript, desktop only), com servidor MCP local e tools do cofre. Raiz absoluta: C:\Users\Trabalho\Documents\obsidian-environment-variables. Código em src\, testes em tests\ (Vitest). Objetivo geral: implementar 23 itens aceitos; você faz o item 23. Etapas 1 a 9 já foram feitas; não altere save_to, projeção, índice, superfície MCP, listagem de segredos, scripts nem guias (src\tools\guide\). Na Etapa 3, hintFor passou a devolver via_tool; na Etapa 4, list_vault_tools saiu da lista exposta mas a função status() continua.

Convenções: comentários em inglês. Nenhuma dependência nova; não altere package.json. Não faça commit, push nem branch. Não leia .env nem credenciais. Comandos, com o diretório de trabalho em C:\Users\Trabalho\Documents\obsidian-environment-variables: npm run typecheck, npm test, npm test -- tests\listLimit.test.ts, npm run lint. Não rode npm run build nem npm run deploy.

Regras de implementação:
1. Apague C:\Users\Trabalho\Documents\obsidian-environment-variables\tests\_measure.test.ts (rascunho de medição). Antes, confirme que nenhum outro arquivo importa `_measure`.
2. list_vault_tools aceita limit (inteiro 1 a 200, padrão 50) e offset (inteiro ≥ 0, padrão 0). Resposta com total (tools que casaram após filtros) e next_offset (número ou null). Sem filtro, não devolve mais o registro inteiro.
3. A dica do http_request (hintFor em C:\Users\Trabalho\Documents\obsidian-environment-variables\src\tools\service.ts) é completa na primeira vez que uma tool aparece para um cliente; nas seguintes, só { tool }. Use um Set por client.id.
4. Não altere as outras chaves de status().

O que fazer, nesta ordem (cada sub-tópico termina com verificação; se falhar, pare e relate):
10.1 Confirme com Grep que nenhum arquivo importa _measure; apague tests\_measure.test.ts. Verificação: npm test → passa.
10.2 Em status() de service.ts, aplique offset e limit depois dos filtros e devolva total e next_offset. Em mcp.ts, adicione limit e offset ao schema de list_vault_tools. Verificação: npm run typecheck → sem erros.
10.3 Em hintFor de service.ts, aplique a regra 3. Verificação: npm run typecheck → sem erros.
10.4 Crie C:\Users\Trabalho\Documents\obsidian-environment-variables\tests\listLimit.test.ts: limit 2 de 5 tools → 2 tools, total 5, next_offset 2; offset 4 com limit 2 → 1 tool, next_offset null; limit 500 → erro; mesma tool duas vezes → segunda dica reduzida. Verificação: npm test -- tests\listLimit.test.ts → passa; npm test → passa.

Critérios (BDD) que você deve provar:
- Dado _measure.test.ts removido, Então npm test passa.
- Dado list_vault_tools limit 2 de 5 tools, Então 2 tools, total 5, next_offset 2.
- Dado offset 4 e limit 2, Então a 5ª tool e next_offset null.
- Dado limit 500, Então erro de validação (máximo 200).
- Dado a mesma tool duas vezes para o mesmo cliente, Então a segunda dica não traz message nem run.
- Nada quebrou: npm test passa.

Não faça: não altere guias; não altere src\ui\; não remova outros testes; não rode npm run build.

Se algo não bater com o descrito, pare e relate, sem improvisar.

Relatório final: arquivos criados, alterados e excluídos com caminho absoluto; saída real de cada verificação; resultado de cada sub-tópico (10.1 a 10.4); desvios e dúvidas.
```

## Etapa 11: Sincronização sob demanda e data.json enxuto [Haiku 5.5 | esforço: alto]

**Objetivo:** o índice de tools só é ressincronizado quando o conteúdo muda (item 12); o `data.json` deixa de guardar logos repetidos e grupos vazios duplicados, e a auditoria passa para arquivo próprio (item 14).
**Depende de:** Etapa 3
**Paralelizável com:** Etapas 5, 6, 7, 8

**Arquivos**
- Alterar: `C:\Users\Trabalho\Documents\obsidian-environment-variables\src\main.ts` (`syncEcosystemTools`, `scheduleSave`, `loadData`/`saveData`, `mcpGroups`, auditoria; referências em ~linhas 139-141 e 531-537 e 1513)
- Alterar: `C:\Users\Trabalho\Documents\obsidian-environment-variables\src\tools\service.ts` (`syncEcosystemTools` do lado do serviço, `buildEcosystemRegistration` ou equivalente, ~linhas 421-431)
- Alterar: `C:\Users\Trabalho\Documents\obsidian-environment-variables\src\tools\mcpGroups.ts` (guardar cada logo uma vez por chave; remover grupos duplicados vazios)
- Alterar: `C:\Users\Trabalho\Documents\obsidian-environment-variables\src\audit\auditLog.ts` (gravar em arquivo próprio)
- Criar: `C:\Users\Trabalho\Documents\obsidian-environment-variables\tests\storageSplit.test.ts`, `tests\syncHash.test.ts`
- Não tocar: `C:\Users\Trabalho\Documents\obsidian-environment-variables\src\crypto\vaultFile.ts` (o arquivo cifrado não muda)

**Regras de implementação**
1. Item 12: `syncEcosystemTools` calcula um hash (SHA-256 de `JSON.stringify` da lista de tools e das instâncias, em ordem estável) e só sincroniza com o banco do AI Ecosystem quando o hash mudar desde a última sincronização. Guarde o hash em memória (não em `data.json`).
2. Item 14: logos (base64) são guardados uma vez por chave única em `data.json`; os grupos MCP referenciam a chave. Se um logo estiver repetido, a migração mantém um só. Grupos vazios e duplicados (mesmo nome e mesmo conjunto de tags/links) são removidos na migração.
3. Item 14: a auditoria sai de `data.json` para `.obsidian/plugins/environment-variables/audit.json` (caminho relativo ao cofre, pelo `app.vault.adapter`). Na primeira carga, se `data.audit` existir, migre para o arquivo e apague do `data.json`.
4. A migração é idempotente: rodar duas vezes não muda o resultado. Antes de regravar `data.json`, faça uma cópia `data.json.bak` apenas se não existir.
5. Nunca grave nem leia valores de segredo nesse fluxo. O `vault.enc` (cifrado) não é tocado.

**Passos**
- **11.1 Hash de sincronização:** objetivo: regra 1.
  1. Em `service.ts`, no método de sincronização, calcule o hash com `crypto.subtle.digest` ou o módulo `crypto` que o projeto já usa (procure `createHash` ou `subtle` em `src\`); escolha o que já existe.
  2. Pule a sincronização quando o hash for igual ao último.
  - Verificação: `npm run typecheck` → sem erros.
- **11.2 Logos e grupos:** objetivo: regra 2.
  1. Em `mcpGroups.ts`, crie um mapa `logos: Record<string, string>` por chave (hash curto do conteúdo) e faça os grupos apontarem para a chave.
  2. Em `main.ts`, faça a migração na carga, idempotente, removendo grupos vazios duplicados.
  - Verificação: `npm run typecheck` → sem erros.
- **11.3 Auditoria em arquivo:** objetivo: regra 3 e 4.
  1. Em `auditLog.ts` e `main.ts`, leia e grave a auditoria em `.obsidian/plugins/environment-variables/audit.json` pelo `app.vault.adapter`.
  2. Na primeira carga com `data.audit`, migre e apague a chave do `data.json`.
  3. Crie `data.json.bak` uma vez antes da primeira migração.
  - Verificação: `npm run typecheck` → sem erros.
- **11.4 Testes:** objetivo: cobrir.
  1. `tests\syncHash.test.ts`: mesma entrada → mesmo hash; ordem diferente → mesmo hash; uma tool muda → hash muda; sincronização pulada quando o hash não muda.
  2. `tests\storageSplit.test.ts`: logo repetido 7 vezes vira 1 chave; grupo vazio duplicado sai; auditoria migra para o arquivo; segunda migração não muda nada.
  - Verificação: `npm test -- tests\syncHash.test.ts` e `npm test -- tests\storageSplit.test.ts` → passam; `npm test` → passa.

**BDD (estado esperado ao concluir)**
- Dado o registro de tools sem mudança, Quando um evento de metadados dispara, Então a sincronização não roda.
- Dado uma tool nova, Quando dispara, Então a sincronização roda uma vez.
- Dado um data.json com um logo repetido 7 vezes, Quando carrega, Então o logo fica guardado uma vez.
- Dado um data.json com auditoria, Quando carrega pela primeira vez, Então a auditoria está em audit.json e saiu do data.json.
- Dado a migração já feita, Quando carrega de novo, Então nada muda.
- Dado qualquer arquivo gerado, Quando inspecionado, Então não há valor de segredo.
- Nada quebrou: npm test passa; vault.enc não foi alterado.

**Verificação**
- `npm run typecheck` → sem erros.
- `npm test -- tests\syncHash.test.ts` e `npm test -- tests\storageSplit.test.ts` → passam.
- `npm test` → suíte completa passa.
- `npm run lint` → sem erros novos.

**Prompt para o subagente**
```text
Papel: você é um implementador de código TypeScript. Vai mexer na persistência e na sincronização de um plugin do Obsidian; trabalhe com cuidado para não perder dados.

Contexto completo: o projeto é o plugin "Environment Keys" do Obsidian (TypeScript, desktop only). Guarda segredos cifrados em .obsidian\plugins\environment-variables\vault.enc (não tocar) e configurações, grupos MCP, logos e auditoria em data.json (via loadData/saveData do Obsidian). Raiz absoluta: C:\Users\Trabalho\Documents\obsidian-environment-variables. Código em src\, testes em tests\ (Vitest). Objetivo geral: implementar 23 itens aceitos; você faz os itens 12 e 14. Etapas 1 a 10 já foram feitas; não altere save_to, projeção, índice, superfície MCP, listagem de segredos, scripts, guias nem a cifragem.

Convenções: comentários em inglês. Nenhuma dependência nova; não altere package.json. Não faça commit, push nem branch. Não leia .env nem credenciais. Nunca grave, logue ou devolva valor de segredo. Comandos, com o diretório de trabalho em C:\Users\Trabalho\Documents\obsidian-environment-variables: npm run typecheck, npm test, npm test -- tests\syncHash.test.ts, npm test -- tests\storageSplit.test.ts, npm run lint. Não rode npm run build nem npm run deploy.

Regras de implementação:
1. Item 12: syncEcosystemTools só sincroniza quando o hash (SHA-256 de JSON.stringify da lista de tools e instâncias, em ordem estável) muda. Guarde o último hash em memória, não em data.json. Use o módulo de hash que o projeto já usa (procure createHash ou crypto.subtle em src\).
2. Item 14: logos em base64 ficam uma vez por chave única; grupos MCP referenciam a chave. Migração idempotente: mantém um logo por conteúdo; remove grupos vazios e duplicados (mesmo nome e mesmo conjunto de tags/links).
3. Item 14: auditoria em .obsidian/plugins/environment-variables/audit.json (caminho relativo à raiz do cofre, via app.vault.adapter). Na primeira carga com data.audit, migre e remova do data.json.
4. Antes da primeira migração, crie data.json.bak se não existir. Migração idempotente.
5. Os pontos de código são: em C:\Users\Trabalho\Documents\obsidian-environment-variables\src\main.ts (syncEcosystemTools, scheduleSave, carga de data, mcpGroups, audit, perto das linhas 139-141, 531-537 e 1513); em src\tools\service.ts (sincronização do serviço, perto das linhas 421-431); em src\tools\mcpGroups.ts; em src\audit\auditLog.ts.

O que fazer, nesta ordem (cada sub-tópico termina com verificação; se falhar, pare e relate):
11.1 Implemente o hash e o pulo da sincronização (regra 1). Verificação: npm run typecheck → sem erros.
11.2 Implemente logos por chave e a migração de grupos (regra 2). Verificação: npm run typecheck → sem erros.
11.3 Implemente auditoria em arquivo, a migração e o backup (regras 3 e 4). Verificação: npm run typecheck → sem erros.
11.4 Crie tests\syncHash.test.ts (mesma entrada → mesmo hash; ordem diferente → mesmo hash; tool muda → hash muda; sincronização pulada sem mudança) e tests\storageSplit.test.ts (logo repetido 7 vezes → 1 chave; grupo vazio duplicado sai; auditoria migra; segunda migração não muda nada). Verificação: npm test -- tests\syncHash.test.ts e npm test -- tests\storageSplit.test.ts → passam; npm test → passa.

Critérios (BDD) que você deve provar:
- Dado registro de tools sem mudança, Quando dispara um evento, Então a sincronização não roda.
- Dado tool nova, Então a sincronização roda uma vez.
- Dado data.json com logo repetido 7 vezes, Quando carrega, Então fica guardado uma vez.
- Dado data.json com auditoria, Quando carrega pela primeira vez, Então a auditoria está em audit.json e saiu do data.json.
- Dado migração já feita, Quando carrega de novo, Então nada muda.
- Dado arquivo gerado, Então não há valor de segredo.
- Nada quebrou: npm test passa; vault.enc não foi alterado.

Não faça: não altere src\crypto\; não altere src\secrets\redact.ts; não apague dados sem backup; não altere src\ui\ além do necessário para ler o novo local; não rode npm run build.

Se algo não bater com o descrito (função ou campo com outro nome), pare e relate, sem improvisar.

Relatório final: arquivos criados e alterados com caminho absoluto; saída real de cada verificação; resultado de cada sub-tópico (11.1 a 11.4); desvios e dúvidas.
```

## Etapa 12: Bundle com QuickJS e logos sob demanda [Haiku 5.5 | esforço: alto]

**Objetivo:** tirar do `main.js` o QuickJS em WASM (59% do arquivo) e os logos padrão (13%), carregando-os de arquivos próprios só quando forem necessários (item 21).
**Depende de:** Etapa 7
**Paralelizável com:** Etapas 9, 10, 11

**Arquivos**
- Alterar: `C:\Users\Trabalho\Documents\obsidian-environment-variables\esbuild.config.mjs` (novos entry points ou plugin de texto/binário)
- Alterar: `C:\Users\Trabalho\Documents\obsidian-environment-variables\src\tools\scriptRunner.ts` (`loadQuickJS`, linha ~80 e o uso de `@jitl/quickjs-singlefile-cjs-release-sync`)
- Alterar: `C:\Users\Trabalho\Documents\obsidian-environment-variables\src\ui\defaultLogos.ts` (virar carregamento sob demanda)
- Criar: `C:\Users\Trabalho\Documents\obsidian-environment-variables\src\ui\defaultLogosLoader.ts` (se necessário)
- Criar: `C:\Users\Trabalho\Documents\obsidian-environment-variables\tests\lazyBundle.test.ts`
- Não tocar: `C:\Users\Trabalho\Documents\obsidian-environment-variables\package.json` (dependências continuam as mesmas)
- Não tocar: `C:\Users\Trabalho\Documents\obsidian-environment-variables\main.js` (gerado; só é reescrito pelo build quando a etapa 13 pedir)

**Regras de implementação**
1. Item 21: o QuickJS (`@jitl/quickjs-singlefile-cjs-release-sync`) sai do bundle principal. Ele é gravado num arquivo separado do plugin, `quickjs.js` (ou `.wasm`), gerado pelo esbuild como segundo entry point. `loadQuickJS()` carrega esse arquivo com `app.vault.adapter.read` + `new Function`/`eval`-equivalente apenas na primeira execução de um script. Se o arquivo não existir, a mensagem de erro diz para reinstalar o plugin.
2. Os logos padrão (`defaultLogos.ts`) viram carregamento sob demanda: o arquivo com os logos é um JSON separado, lido pela primeira vez que a interface precisar de um logo padrão.
3. Não mude a API externa de `scriptRunner` nem o comportamento de scripts.
4. Não use dependências novas nem CDN.
5. O `manifest.json` e o `scripts\deploy.mjs` não são tocados nesta etapa; registre no relatório que o deploy precisa copiar os arquivos novos (quickjs.js e logos.json).
6. Teste que o bundle principal não contém a string base64 do WASM (`main.js` gerado não é testado nesta etapa; teste pelo `esbuild` em memória ou pelo tamanho do output via `esbuild.build({ write: false })`).

**Passos**
- **12.1 Entry point do QuickJS:** objetivo: regra 1.
  1. Em `esbuild.config.mjs`, adicione um entry point `src\tools\quickjsEntry.ts` que reexporta o QuickJS, gerado como `quickjs.js` no mesmo diretório do plugin; ajuste o `outfile` ou `outdir` sem mudar o `main.js`.
  2. Crie `src\tools\quickjsEntry.ts` com `export * from "@jitl/quickjs-singlefile-cjs-release-sync";`.
  3. Em `scriptRunner.ts`, troque o import estático por carregamento sob demanda do arquivo `quickjs.js` no diretório do plugin, com mensagem de erro clara quando faltar.
  - Verificação: `npm run typecheck` → sem erros.
- **12.2 Logos sob demanda:** objetivo: regra 2.
  1. Mova o conteúdo de `defaultLogos.ts` para `src\ui\defaultLogos.json` (ou gere um JSON no build) e leia sob demanda.
  2. Mantenha a mesma API pública (mesmos nomes de exports lidos pelo resto do código).
  - Verificação: `npm run typecheck` → sem erros.
- **12.3 Build e teste:** objetivo: regra 6.
  1. Crie `tests\lazyBundle.test.ts`: o build em memória do `main.ts` (sem `write`) tem menos de 600 KB; a string base64 do início do QuickJS não aparece no output.
  2. Não rode `npm run build`; use o `esbuild` em memória dentro do teste.
  - Verificação: `npm test -- tests\lazyBundle.test.ts` → passa; `npm test` → passa.

**BDD (estado esperado ao concluir)**
- Dado o build em memória, Quando medido, Então o bundle principal tem menos de 600 KB.
- Dado o build, Quando procuro o início do QuickJS em base64 no bundle principal, Então não aparece.
- Dado um script de tool pela primeira vez, Quando roda, Então quickjs.js é carregado e o script funciona como antes.
- Dado o arquivo quickjs.js ausente, Quando um script roda, Então erro claro pedindo reinstalar o plugin.
- Dado a interface sem nenhum logo personalizado, Quando abre, Então os logos padrão aparecem como antes.
- Nada quebrou: npm test passa; tests\scriptRunner.test.ts passa.

**Verificação**
- `npm run typecheck` → sem erros.
- `npm test -- tests\lazyBundle.test.ts` → passa.
- `npm test` → suíte completa passa.
- `npm run lint` → sem erros novos.

**Prompt para o subagente**
```text
Papel: você é um implementador de código TypeScript com experiência em build (esbuild). Vai separar partes pesadas do bundle de um plugin do Obsidian, sem mudar comportamento.

Contexto completo: o projeto é o plugin "Environment Keys" do Obsidian (TypeScript, desktop only). O bundle main.js tem ~1,4 MB; 59% é o QuickJS em WASM em base64 (usado por scripts de tool, em src\tools\scriptRunner.ts) e 13% são logos padrão (src\ui\defaultLogos.ts, ~181 KB). Raiz absoluta: C:\Users\Trabalho\Documents\obsidian-environment-variables. Build com esbuild em C:\Users\Trabalho\Documents\obsidian-environment-variables\esbuild.config.mjs. Testes em tests\ (Vitest). Objetivo geral: implementar 23 itens aceitos; você faz o item 21. Etapas 1 a 11 já foram feitas.

Convenções: comentários em inglês. Nenhuma dependência nova; não altere package.json nem package-lock.json. Não faça commit, push nem branch. Não leia .env nem credenciais. Comandos, com o diretório de trabalho em C:\Users\Trabalho\Documents\obsidian-environment-variables: npm run typecheck, npm test, npm test -- tests\lazyBundle.test.ts, npm run lint. Não rode npm run build nem npm run deploy: o build reescreve main.js, que é artefato gerado, e isso fica para a etapa de verificação geral.

Regras de implementação:
1. O QuickJS (@jitl/quickjs-singlefile-cjs-release-sync) sai do bundle principal. Ele vira um segundo entry point gerado como quickjs.js no diretório do plugin (ao lado de main.js). Crie src\tools\quickjsEntry.ts com export * from "@jitl/quickjs-singlefile-cjs-release-sync". Em scriptRunner.ts, carregue quickjs.js do diretório do plugin na primeira execução de um script, via app.vault.adapter (ou a API equivalente que o plugin já usa para ler arquivos do próprio plugin). Se o arquivo faltar, erro com a mensagem "Environment Keys: quickjs.js is missing. Reinstall the plugin."
2. Os logos padrão de src\ui\defaultLogos.ts viram JSON separado (src\ui\defaultLogos.json), lido na primeira necessidade. A API pública (nomes exportados) fica igual.
3. A API de scriptRunner e o comportamento de scripts não mudam.
4. Nada de CDN nem dependência nova.
5. Não toque em manifest.json nem scripts\deploy.mjs. No relatório, diga que o deploy precisa copiar quickjs.js e defaultLogos.json.
6. O teste mede o build em memória (esbuild.build com write: false) do entry principal: o tamanho tem que ser menor que 600 KB e a string base64 inicial do QuickJS não pode aparecer no output principal.

O que fazer, nesta ordem (cada sub-tópico termina com verificação; se falhar, pare e relate):
12.1 Ajuste C:\Users\Trabalho\Documents\obsidian-environment-variables\esbuild.config.mjs para gerar quickjs.js como segundo entry point, sem mudar o outfile de main.js. Crie src\tools\quickjsEntry.ts. Ajuste scriptRunner.ts para carregamento sob demanda com a mensagem de erro acima. Verificação: npm run typecheck → sem erros.
12.2 Mova o conteúdo de src\ui\defaultLogos.ts para src\ui\defaultLogos.json, mantendo a mesma API de exports (use um loader que lê o JSON sob demanda). Verificação: npm run typecheck → sem erros.
12.3 Crie C:\Users\Trabalho\Documents\obsidian-environment-variables\tests\lazyBundle.test.ts com o build em memória conforme a regra 6. Verificação: npm test -- tests\lazyBundle.test.ts → passa; npm test -- tests\scriptRunner.test.ts → passa; npm test → passa.

Critérios (BDD) que você deve provar:
- Dado o build em memória, Então o bundle principal tem menos de 600 KB.
- Dado o build, Então a string base64 inicial do QuickJS não aparece no bundle principal.
- Dado primeira execução de script, Então quickjs.js é carregado e o script roda como antes.
- Dado quickjs.js ausente, Então erro com a mensagem acima.
- Dado a interface sem logo personalizado, Então os logos padrão aparecem como antes.
- Nada quebrou: npm test passa.

Não faça: não altere package.json; não altere main.js; não rode npm run build; não altere o comportamento de scripts; não altere src\ui\ além do necessário para ler o JSON de logos.

Se algo não bater com o descrito (versão do esbuild, nome de export, API de leitura do plugin), pare e relate, sem improvisar.

Relatório final: arquivos criados e alterados com caminho absoluto; saída real de cada verificação; resultado de cada sub-tópico (12.1 a 12.3); tamanho medido no teste; lista dos arquivos que o deploy precisa copiar; desvios e dúvidas.
```

## Etapa 13: Verificação geral [Haiku 5.5 | esforço: alto]

**Objetivo:** confirmar que os 23 itens estão no código, que typecheck, lint e testes passam, e gerar o `main.js` com o build de produção para conferência, sem deploy.
**Depende de:** Etapas 1 a 12
**Paralelizável com:** nenhuma

**Arquivos**
- Alterar: nenhum arquivo de código. Só leitura, mais `main.js` gerado pelo build.
- Pode ler: todos os arquivos alterados nas etapas 1 a 12.
- Não tocar: `C:\Users\Trabalho\Documents\obsidian-environment-variables\package.json`, nenhum arquivo em `src\` ou `tests\`, exceto correção trivial de lint que o relatório registre.

**Regras de implementação**
1. Não altere lógica nesta etapa. Se achar falha, relate com o arquivo e a linha; não corrija. (Exceção: erro de lint trivial, como import sem uso, que pode ser corrigido e registrado.)
2. Rode os comandos a partir de `C:\Users\Trabalho\Documents\obsidian-environment-variables`.
3. Não rode `npm run deploy`. Não copie arquivos para cofres.
4. Gere `main.js` com `npm run build` apenas no fim, depois de tipos, lint e testes passarem.

**Passos**
- **13.1 Tipos e lint:** objetivo: passar em tipos e lint.
  1. `npm run typecheck` → sem erros.
  2. `npm run lint` → sem erros novos em relação à linha de base (se houver erros que já existiam antes das etapas, liste-os e não corrija).
- **13.2 Testes:** objetivo: suíte inteira.
  1. `npm test` → todos passam. Liste os arquivos de teste que falharam, se houver.
- **13.3 Conferência dos 23 itens:** objetivo: provar cada item no código.
  1. Para cada item de `C:\Users\Trabalho\AppData\Local\Temp\claude\C--Users-Trabalho-Documents-Cofre\f7346580-c5be-4117-a93c-bde037b7aa6b\scratchpad\itens-env.md`, procure a evidência: `save_to` em mcp.ts; `fields`, `max_chars`, `headers` em http_request; `getRequestForTool` em service.ts; `via_tool`; `tools_run` no run; `response_fields`; `adf`; `page_limit`; `detail` em list_secrets; fallback `mode: "some"` em main.ts; `limit`/`offset` em list_vault_tools; `_measure.test.ts` ausente; logos e QuickJS separados; guia com `topic`; pt sem `?` no meio de palavra.
  2. Para cada item, registre: "ok" ou "não encontrado" com caminho e linha.
- **13.4 Build de produção:** objetivo: gerar o artefato para conferência.
  1. `npm run build` → sem erros. Anote o tamanho de `C:\Users\Trabalho\Documents\obsidian-environment-variables\main.js` e o de `quickjs.js` no mesmo diretório.
  2. Confirme que `main.js` tem menos de 600 KB.

**BDD (estado esperado ao concluir)**
- Dado o projeto, Quando roda `npm run typecheck`, Então sem erros.
- Dado o projeto, Quando roda `npm run lint`, Então sem erros novos em relação à linha de base.
- Dado o projeto, Quando roda `npm test`, Então todos os testes passam.
- Dado a lista dos 23 itens, Quando conferida no código, Então cada item tem evidência.
- Dado `npm run build`, Quando roda, Então gera main.js e quickjs.js sem erro, e main.js tem menos de 600 KB.
- Dado o resultado, Então nenhum arquivo foi copiado para cofre nem publicado.

**Verificação**
- `npm run typecheck` → sem erros.
- `npm run lint` → sem erros novos.
- `npm test` → todos passam.
- `npm run build` → sem erros; main.js abaixo de 600 KB.

**Prompt para o subagente**
```text
Papel: você é um revisor de verificação. Vai rodar tipos, lint, testes e build, e conferir os 23 itens no código. Não altera lógica.

Contexto completo: o projeto é o plugin "Environment Keys" do Obsidian (TypeScript, desktop only). Raiz absoluta: C:\Users\Trabalho\Documents\obsidian-environment-variables. Nas etapas 1 a 12, foram implementados os 23 itens de uma auditoria, listados em C:\Users\Trabalho\AppData\Local\Temp\claude\C--Users-Trabalho-Documents-Cofre\f7346580-c5be-4117-a93c-bde037b7aa6b\scratchpad\itens-env.md. Você faz só a verificação.

Convenções: nenhuma alteração de lógica. Não faça commit, push ou branch. Não rode npm run deploy. Não copie nada para cofres. Não leia .env nem credenciais. Comandos, com o diretório de trabalho em C:\Users\Trabalho\Documents\obsidian-environment-variables: npm run typecheck, npm run lint, npm test, npm run build.

O que fazer, nesta ordem (se um passo falhar, pare e relate com a saída real; não corrija lógica):
13.1 npm run typecheck → deve passar. npm run lint → sem erros novos; se houver erros que já existiam, liste-os.
13.2 npm test → todos passam. Liste os que falharem, com o arquivo.
13.3 Para cada item do arquivo itens-env.md, procure a evidência no código: save_to em src\server\mcp.ts; fields, max_chars e headers em http_request; getRequestForTool em src\tools\service.ts; via_tool; tools_run no campo run (src\tools\toolSearch.ts); response_fields e adf; page_limit; detail em list_secrets (src\secrets\broker.ts); mode "some" com secretIds vazio em src\main.ts; limit e offset em list_vault_tools; ausência de tests\_measure.test.ts; quickjs.js e defaultLogos.json; topic em src\tools\guide.ts; ausência de padrão letra-?-letra em src\i18n.ts. Registre "ok" ou "não encontrado" com caminho absoluto e linha.
13.4 npm run build → deve passar. Anote o tamanho de C:\Users\Trabalho\Documents\obsidian-environment-variables\main.js e de quickjs.js (mesmo diretório). main.js deve estar abaixo de 600 KB.

Relatório final: saída real de cada comando (resumo curto e as linhas de erro, se houver); tabela dos 23 itens com "ok" ou "não encontrado" e caminho:linha; tamanhos dos dois arquivos; lista dos arquivos que o deploy precisa copiar; desvios e dúvidas.
```

## 6. Critérios de aceite finais (BDD)
- Dado o plugin construído, Quando `npm run typecheck`, `npm run lint` e `npm test` rodam, Então passam sem erros novos em relação à linha de base.
- Dado o item 1, Quando `http_request` roda com `save_to: true`, Então a resposta traz o caminho do arquivo e nenhum segredo aparece no arquivo gravado.
- Dado o item 3, Quando busco `.../issue/ABC-1/changelog`, Então acho a tool do banco mcp.db.
- Dado o item 8 e o item 16, Quando o cliente pede `tools/list`, Então não há `list_tools`, `search_vault_tools` nem `run_vault_tool`, e tools com `expose: false` indicam `tools_run`.
- Dado o item 17, Quando um cliente não registrado pede segredos, Então recebe lista vazia.
- Dado o item 20, Quando a interface em pt é lida, Então não há letra-?-letra no dicionário.
- Dado o item 21, Quando o build roda, Então `main.js` tem menos de 600 KB.
- Dado a lista de 23 itens, Quando conferida, Então cada um tem evidência no código (etapa 13).

## Ações do usuário

Nenhum dos 23 itens depende de ação do usuário para ser codificado. Ficam aqui as decisões que a implementação precisa de você antes de começar ou antes de publicar. Todas estão marcadas como dúvidas reais:

1. **Item 8 contra o guia (Etapas 4 e 9):** o item manda remover `list_vault_tools` da lista do MCP, mas o guia de autoria e o prompt `configure_vault_tools` usam `list_vault_tools` como passo de validação, e `tools_find` só existe com o AI Ecosystem. O plano segue o item (removido da lista, continua como função interna e no REST `GET /v1/tools`). Confirme se prefere manter `list_vault_tools` exposto.
2. **Item 16 e tools com `expose: false` (Etapa 4):** sem `run_vault_tool`, essas tools só são chamáveis via `tools_run` do AI Ecosystem ou via REST `POST /v1/tools/<nome>`. Clientes MCP sem AI Ecosystem perdem o acesso a elas. Confirme se é aceitável.
3. **Item 17 (Etapa 6):** clientes do AI Ecosystem que ainda não estão registrados no plugin deixam de receber segredos até serem registrados. Confirme se o registro automático do AI Ecosystem já cobre todos os clientes usados.
4. **Item 1 (Etapa 1):** a pasta escolhida é `.obsidian/plugins/environment-variables/respostas`, sem limpeza automática. Confirme o local e se quer retenção (ex.: apagar após N dias).
5. **Item 6 (Etapa 5):** o "gerador dos pacotes" citado na auditoria não está neste repositório. Sem o gerador, o plano só lê `response_fields` do banco mcp.db; quem preenche essa coluna precisa ser ajustado em outro projeto. Confirme onde fica o gerador.
6. **Item 14 (Etapa 11):** a migração de `data.json` (backup `data.json.bak`, auditoria em `audit.json`) mexe em dados reais de quem já usa o plugin. Confirme que um backup automático antes da migração é suficiente.
7. **Item 21 (Etapa 12):** `quickjs.js` e `defaultLogos.json` passam a ser arquivos extras do plugin. Confirme que o processo de release (`scripts\deploy.mjs` e a publicação do plugin) copia esses arquivos.

Itens não cobertos: nenhum. Os 23 itens têm etapa. Itens onde o código atual divergiu da evidência da auditoria, e que o plano trata com cuidado: item 3 (confirmado: `buildEndpointIndex` não usa `getRequestForTool`), item 16 (`run_vault_tool` está no `howToRun`, confirmado), item 20 (strings corrompidas confirmadas em `src\i18n.ts`). Os números de linha da auditoria batem com o código em pontos gerais, mas não em todos; o plano manda o subagente localizar pelo nome da função, não pela linha.
