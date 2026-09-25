# Guia para agentes de IA: criar ferramentas do cofre (vault tools)

Você vai configurar **ferramentas MCP definidas por notas** do cofre do Obsidian deste usuário, usando o plugin **Environment Variables**. Uma ferramenta pode ser uma só (ex.: "buscar um ticket do Jira") ou um conjunto para um app ou serviço (ex.: "ferramentas para o Google Drive").

Você **não mexe no código do plugin**. Toda a configuração é feita criando e editando notas Markdown. O plugin encontra as notas sozinho e as publica como ferramentas MCP para qualquer cliente conectado (Claude Code, Codex, Cursor...).

## 1. Regras obrigatórias

1. **Leia este guia inteiro antes de agir.**
2. **Levante o estado atual antes de perguntar qualquer coisa:**
   - **confirme que está falando com o servidor deste cofre.** Cada cofre do Obsidian tem o próprio servidor MCP, com nome, porta, segredos e ferramentas próprios. Este guia é do cofre **%VAULT_NAME%**, cujo servidor se chama `%MCP_SERVER_NAME%` (`%SERVER_URL%`). Use só as ferramentas desse servidor (no Claude Code elas aparecem como `mcp__%MCP_SERVER_NAME%__list_vault_tools`, `mcp__%MCP_SERVER_NAME%__list_secrets` etc.). Se o cliente tiver outros servidores `environment-variables…`, ignore-os: são de outros cofres. Se o servidor deste cofre não aparecer, peça ao usuário para conectar o cliente em Obsidian → painel Environment Variables → Clientes de IA;
   - chame `list_vault_tools` para ver as ferramentas e as notas de requisição que já existem, e os problemas delas;
   - chame `list_secrets` para ver os segredos cadastrados (nome, tipo, hosts permitidos, onde podem ser usados). Os valores nunca aparecem;
   - procure no cofre as notas de serviço, de requisição e de ferramenta que já existem (pelas tags da seção 10) e reaproveite o que der;
   - leia as convenções do cofre: arquivos de instruções como `CLAUDE.md` ou `AGENTS.md`, notas índice (MOCs), taxonomia de tags e propriedades como `up:`. Siga essas convenções nas notas que criar.
3. **Se faltar qualquer informação, pergunte ao usuário antes de montar o plano.** Use a lista da seção 3. Faça todas as perguntas de uma vez, numeradas. **Nunca invente valores**: URLs, IDs, nomes de segredos, escopos, nomes de campos ou endpoints que você não confirmou na documentação oficial ou com o usuário.
4. **Nunca peça, leia, escreva ou registre o valor de um token, senha ou chave.** Se um segredo ainda não existe, o usuário cadastra no painel do plugin no Obsidian (ícone de chave → "Nova variável"). Você só usa o nome dele em placeholders como `{{basic:NOME}}`.
5. **As notas que você cria são genéricas.** Todos os valores de uma instância ou conta (URL, IDs, placeholder do segredo) ficam **só na nota de serviço daquela instância**, uma nota por instância. Notas de requisição e de ferramenta **nunca** contêm esses valores: elas usam `{{service.<propriedade>}}` e recebem os valores da instância escolhida na chamada. Crie **uma** ferramenta genérica com `service_tag` e `service_param` (seção 4.3), nunca uma ferramenta por instância. Isso vale mesmo quando hoje só existe uma instância: uma nova instância passa a funcionar só com uma nova nota de serviço.
6. **Gere sempre um Plano de Implementação**, no modelo da seção 8, e **espere a aprovação explícita do usuário** antes de criar ou editar qualquer nota. Se o usuário pedir mudanças, atualize o plano e peça aprovação de novo.
7. **Depois de implementar, valide:** chame `list_vault_tools` até nenhuma ferramenta nova ter `problems`. Teste só ferramentas de leitura. Uma ferramenta que grava dados (`writes: true`) só pode ser executada com autorização explícita do usuário para aquela execução.
8. **Segredos que permitem qualquer domínio: peça autorização sempre.** Em `list_secrets`, esses segredos aparecem com `allowAnyHost: true`. O plugin não confere para onde eles vão e não abre nenhuma janela de aprovação quando uma ferramenta os usa: **a conferência é sua**. Antes de **cada** execução de uma ferramenta cuja nota de serviço usa um desses segredos (mesmo que seja só leitura, e mesmo em testes), mostre ao usuário o nome do segredo e a URL completa de destino e espere a autorização explícita dele para aquela execução. Nunca execute sem essa resposta, e nunca troque a URL da nota de serviço sem avisar. Ao planejar, prefira pedir ao usuário que troque "qualquer domínio" pelo host exato da API.
9. **Trabalhe só neste cofre.** Crie e edite notas apenas dentro de `%VAULT_PATH%`: notas em outro cofre não viram ferramentas aqui, e os segredos deste cofre não funcionam em outro. Se o usuário quiser as mesmas ferramentas em outro cofre, elas precisam ser criadas lá, com o guia daquele cofre e os segredos cadastrados nele.
10. **Não edite** `data.json`, `vault.enc` nem nada dentro de `.obsidian/`. Não tente contornar as regras de segurança do plugin (hosts permitidos, aprovações, mascaramento).

## 2. Como o plugin funciona

- O plugin roda dentro do Obsidian e tem **um servidor MCP local por cofre**. O deste cofre se chama `%MCP_SERVER_NAME%` e fica em `%SERVER_URL%`. Cada cofre tem os próprios segredos, tokens de cliente, notas e ferramentas; o token de um cofre é recusado pelo servidor de outro. Com o cofre de segredos bloqueado, as chamadas que usam segredos falham até o usuário desbloquear.
- O **registro de ferramentas** varre o cofre atrás das notas com a tag de ferramenta (seção 9), valida cada uma e publica as válidas no `tools/list` do MCP. A lista se atualiza sozinha quando uma nota muda. Se o cliente não recarregar a lista, use `run_vault_tool`.
- Os **segredos** ficam cifrados no plugin. As notas só contêm placeholders (`{{secret:NOME}}`, `{{basic:NOME}}`, `{{bearer:NOME}}`), trocados pelo valor real no último momento pelo *broker*, que confere se o host de destino é permitido para aquele segredo e mascara o valor na resposta.
- O plugin encontra as notas **pelas tags e pelos links**, nunca pela pasta. As notas podem ficar em qualquer lugar do cofre.

Há três tipos de nota:

| Nota | Para que serve | Tem código? |
| --- | --- | --- |
| **Serviço** | **Uma por instância ou conta.** Guarda os valores dela: URL base, placeholder do segredo, IDs. Todas as notas de serviço de um mesmo app têm a mesma tag e as mesmas propriedades | Não |
| **Requisição** | Uma chamada HTTP salva, como no Postman, num bloco ```` ```http ````. Genérica: só usa `{{service.*}}` e `{{param:*}}` | Não |
| **Ferramenta** | O que a IA pode chamar: nome, descrição, parâmetros. Genérica: a instância é um parâmetro da chamada. `kind: request` executa uma requisição; `kind: script` executa um bloco ```` ```js ```` da própria nota | Só no `kind: script` |

Prefira `kind: request`. Use `kind: script` só quando a ferramenta precisar juntar várias chamadas, paginar, filtrar ou transformar a resposta. Scripts precisam estar liberados nas configurações. O plugin não pede aprovação para executar ferramentas, nem para as requisições que elas fazem: quem pede permissão ao usuário é o cliente de IA (ex.: o Claude Code pergunta antes de chamar uma ferramenta MCP). Isso vale também para os segredos que permitem qualquer domínio: nesse caso é você quem pede autorização ao usuário antes de cada execução (regra 8). Por isso, peça autorização ao usuário antes de executar qualquer ferramenta que grave dados.

## 3. Informações a levantar (pergunte o que não souber)

1. **Serviço e instâncias:** qual app ou API, quais contas, instâncias ou workspaces vão usar as ferramentas (ex.: `acme.atlassian.net`), se já existem notas de serviço para elas (e com qual tag e quais propriedades) e se alguma nota com essa tag é um molde que deve ficar de fora.
2. **Documentação:** link da documentação oficial da API, ou os endpoints exatos que devem ser usados.
3. **URL base** da API.
4. **Autenticação:** API key, Basic (usuário ou e-mail + token), Bearer/Personal Access Token ou OAuth 2.0. Veja a seção 7 antes de planejar OAuth.
5. **Segredo:** se já existe em `list_secrets` deste cofre, qual é e se os hosts permitidos incluem o host da API. Se não existe, o nome que o usuário vai cadastrar, o tipo e os hosts permitidos.
6. **Operações:** a lista de ações que o usuário quer (ex.: listar arquivos, buscar um arquivo, criar uma pasta) e **quais gravam dados**.
7. **Parâmetros** de cada operação: nome, tipo, obrigatório ou não, valores permitidos.
8. **Resultado esperado:** a resposta crua da API basta, ou é preciso resumir, filtrar ou paginar (isso decide entre `request` e `script`).
9. **Nomes e lugar das notas:** prefixo dos nomes das ferramentas (ex.: `gdrive_`), nomes das notas e onde elas entram na estrutura do cofre (MOC, `up:`, tags).
10. **Exposição:** cada ferramenta aparece direto na lista do cliente (`expose: true`) ou só pelo `run_vault_tool` (`expose: false`, útil para conjuntos grandes).

## 4. Formato das notas

### 4.1 Nota de serviço

**Uma nota por instância ou conta**, todas com a mesma tag e as mesmas propriedades. Os nomes das propriedades são livres. Se o cofre já tem notas assim (ex.: notas de acesso a instâncias), **use a tag e as propriedades que elas já têm** e só complete o que faltar.

O nome da nota vira o valor que a IA escolhe na chamada, sem a parte comum a todas: "Jira - ACME" e "Jira - Globex" viram `ACME` e `Globex`.

```markdown
---
tags: [<a tag que o cofre usa para esse tipo de nota>]
url: https://acme.atlassian.net
auth: "{{basic:JIRA_ACME}}"
cloud_id: 1234abcd-...
---
Notas livres sobre a conta. Salva como "Jira - ACME"; a instância Globex seria outra nota, "Jira - Globex", com os valores dela.
```

### 4.2 Nota de requisição (tag `%REQUEST_TAG%`)

````markdown
---
tags: [%REQUEST_TAG%]
---
Busca um ticket com os campos pedidos, em qualquer instância.

```http
GET {{service.url}}/rest/api/3/issue/{{param:key}}?fields={{param:fields}}
Authorization: {{service.auth}}
Accept: application/json
```
````

Regras do bloco ```` ```http ````:

- 1ª linha: `MÉTODO URL` (GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS). A URL tem que ser absoluta (`https://...`) depois de preenchida.
- Depois, um header por linha no formato `Nome: valor`.
- Uma linha em branco e, se houver, o body.
- `{{service.<propriedade>}}`: valor da propriedade na nota de serviço **da instância escolhida na chamada**, inserido como está. Pode conter placeholders de segredo. Nunca escreva na requisição uma URL, um ID ou um segredo de uma instância.
- `{{param:<nome>}}`: argumento da chamada. Na URL o valor é codificado. Num body JSON, texto vai **entre aspas** (`"{{param:titulo}}"`) e números, booleanos, objetos e listas **sem aspas** (`{{param:limite}}`).
- Um parâmetro opcional não informado que é o valor inteiro de um par da query (`?fields={{param:fields}}`) faz o par sumir da URL. Em qualquer outro lugar, a falta de um parâmetro dá erro.
- Placeholders de segredo só funcionam nos **headers**, a menos que o segredo permita URL ou body. O host da URL nunca pode vir de um placeholder de segredo.
- Argumentos da IA nunca podem conter placeholders de segredo: o plugin recusa.

### 4.3 Nota de ferramenta, `kind: request` (tag `%TOOL_TAG%`)

```markdown
---
tags: [%TOOL_TAG%]
tool: jira_get_issue
kind: request
request: "[[Jira - Buscar ticket]]"
service_tag: jira/instancia
service_param: instancia
service_exclude_tag: molde
description: Busca um ticket do Jira pela chave, na instância escolhida. Use quando o usuário citar uma chave como ACME-123.
params:
  key: { type: string, required: true, description: "Chave do ticket, ex.: ACME-123" }
  fields: { type: string, description: "Campos separados por vírgula", default: "summary,status,assignee" }
writes: false
expose: true
---
Documentação livre da ferramenta para humanos.
```

Com `service_tag`, o plugin cria sozinho o parâmetro `instancia` (o nome vem de `service_param`), obrigatório, com a lista das instâncias encontradas: as notas com a tag `jira/instancia`, menos as com `molde`. Não declare esse parâmetro em `params`. A chamada fica `jira_get_issue({ instancia: "ACME", key: "ACME-123" })`, e cada `{{service.*}}` da requisição recebe o valor da nota "Jira - ACME". Uma instância nova entra na lista sozinha quando a nota dela é criada.

### 4.4 Nota de ferramenta, `kind: script`

````markdown
---
tags: [%TOOL_TAG%]
tool: jira_issue_digest
kind: script
service_tag: jira/instancia
service_param: instancia
service_exclude_tag: molde
description: Resume um ticket, na instância escolhida, com status, responsável e total de comentários.
params:
  key: { type: string, required: true, description: "Chave do ticket, ex.: ACME-123" }
writes: false
---
```js
export default async function (ctx) {
  const issue = await ctx.requests.run("Jira - Buscar ticket", { key: ctx.args.key, fields: "summary,status,assignee" });
  if (!issue.ok) return { error: issue.status, details: issue.json ?? issue.body };
  const comments = await ctx.requests.run("Jira - Comentários do ticket", { key: ctx.args.key });
  return {
    instance: ctx.args.instancia,
    site: ctx.service.frontmatter.url,
    key: ctx.args.key,
    summary: issue.json.fields.summary,
    status: issue.json.fields.status.name,
    assignee: issue.json.fields.assignee?.displayName ?? null,
    comments: comments.json?.total ?? 0,
  };
}
```
````

### 4.5 Propriedades da nota de ferramenta

| Propriedade | Obrigatória | Descrição |
| --- | --- | --- |
| `tool` | sim | Nome da ferramenta: minúsculas, dígitos e `_`, começando com letra, até 64 caracteres. Único no cofre. Não pode ser `list_secrets`, `http_request`, `get_tool_authoring_guide`, `list_vault_tools` nem `run_vault_tool`. |
| `description` | sim | O que a ferramenta faz e **quando usar**. É o que a IA lê para escolher a ferramenta: seja específico. |
| `kind` | sim | `request` ou `script`. |
| `request` | no `request` | Link para a nota de requisição. |
| `service_tag` | sim, para ferramentas genéricas | Tag das notas de serviço (uma por instância). O plugin cria o parâmetro que escolhe a instância. |
| `service_param` | não | Nome desse parâmetro. Padrão `instance`. Use o nome que fizer sentido para o usuário, ex.: `instancia`, `conta`, `workspace`. |
| `service_exclude_tag` | não | Notas com esta tag ficam fora da lista de instâncias (ex.: moldes). |
| `service` | não | Link para **uma** nota de serviço fixa. Só use quando o serviço tem, e sempre terá, uma única conta. Não pode ser usado junto com `service_tag`. |
| `params` | não | Mapa `nome: { type, required, description, enum, default }`. `type`: `string`, `number`, `integer`, `boolean`, `object` ou `array`. |
| `writes` | não | `true` se a ferramenta cria, altera ou apaga dados. Padrão `false`. |
| `expose` | não | `false` esconde da lista do cliente; continua acessível por `run_vault_tool`. Padrão `true`. |
| `title` | não | Título curto. Padrão: nome da nota. |
| `enabled` | não | `false` desativa a ferramenta sem apagar a nota. |

Outras propriedades do cofre (`tags`, `up`, `aliases`...) podem ficar na nota normalmente.

## 5. API dos scripts (`ctx`)

O bloco ```` ```js ```` precisa exportar a função: `export default async function (ctx) { ... }`. O `return` vira o resultado da ferramenta e precisa ser serializável em JSON.

| Chamada | O que faz |
| --- | --- |
| `ctx.args` | Argumentos já validados pelos `params`, com os valores padrão aplicados. |
| `ctx.tool` | Nome da ferramenta. |
| `ctx.service` | A nota de serviço da instância escolhida (`name`, `path`, `frontmatter`, `tags`), ou `null`. |
| `await ctx.requests.run(nota, params, { service })` | Executa uma nota de requisição com a instância escolhida na chamada. `service` (opcional) troca a nota de serviço. |
| `await ctx.http({ method, url, headers, body })` | Requisição livre, com placeholders de segredo nos headers. Um `body` objeto vira JSON. |
| `await ctx.notes.get(refOuNome)` | Nota com `name`, `path`, `frontmatter`, `tags` e `body`, ou `null`. |
| `await ctx.notes.query({ tag, name, limit })` | Notas com a tag (e subtags), sem o body. |
| `ctx.log(...)` | Mensagem de depuração. |

As requisições devolvem `{ status, statusText, ok, headers, json | body, truncated }`, com qualquer segredo já mascarado como `***`.

Limites: o script roda num interpretador JavaScript isolado (QuickJS, em WebAssembly). Não há `fetch`, `import`, `require`, `setTimeout`, DOM nem acesso à rede fora do `ctx`; `console.log` funciona como `ctx.log`. Scripts têm um tempo máximo de execução (%SCRIPT_TIMEOUT% s; o tempo esperando requisições e aprovações não conta) e um limite de memória de 64 MB. Um erro de requisição não interrompe o script: confira `ok` e `status`. Os erros de configuração (nota não encontrada, parâmetro faltando, host não permitido) viram exceções com mensagens explicativas.

## 6. Nomes e descrições que funcionam

- Prefixe pelo serviço e use verbo: `gdrive_list_files`, `gdrive_get_file`, `jira_create_issue`. Não coloque o nome de uma instância no nome da ferramenta: a instância é um parâmetro.
- Na `description`, diga o que a ferramenta devolve e quando usá-la, e cite exemplos de valores dos parâmetros.
- Uma ferramenta por ação. Conjuntos grandes: exponha só as mais usadas e deixe o resto com `expose: false`.

## 7. Autenticação: o que o plugin suporta

- **Suportado:** valores fixos: API key (`{{secret:NOME}}` num header como `X-API-Key`), Basic (`{{basic:NOME}}`, usuário + token), Bearer/PAT (`{{bearer:NOME}}`) e headers personalizados.
- **Ainda não suportado: OAuth 2.0 com renovação de token.** É o caso da maioria das APIs do **Google** (Drive, Gmail, Calendar) e do **Microsoft Graph**: o access token expira em cerca de 1 hora e precisa ser renovado com um refresh token, e o plugin só guarda valores fixos.
  - Diga isso ao usuário **antes** de montar o plano e apresente as alternativas: uma API key, se a API aceitar para aquele uso (ex.: dados públicos no Google, com o header `X-goog-api-key`); um conector MCP pronto para o serviço, se existir; ou aguardar o suporte a OAuth no plugin.
  - **Nunca** peça ao usuário para colar um access token numa nota nem proponha salvar tokens fora do plugin.
- Se o segredo não permite o host da API, o plugin bloqueia a chamada (`host_not_allowed`). O usuário ajusta os hosts permitidos no painel do plugin.

## 8. Modelo obrigatório do Plano de Implementação

Apresente o plano ao usuário exatamente com estas seções e espere a aprovação:

```markdown
# Plano de implementação: <nome do conjunto de ferramentas>

## 1. Objetivo
O que o usuário vai poder pedir à IA depois desta implementação.

## 2. Informações confirmadas
Cofre: %VAULT_NAME% (servidor `%MCP_SERVER_NAME%`). Serviço, instâncias, URL base, documentação usada e as respostas do usuário.

## 3. Autenticação
Segredo usado (nome e tipo), se já existe ou se o usuário precisa criar, e os hosts permitidos necessários.
Ação do usuário necessária: <ex.: cadastrar o segredo GDRIVE_KEY do tipo token para o host www.googleapis.com>.

## 4. Notas a criar ou alterar
| Nota | Tipo (serviço/requisição/ferramenta) | Criar/alterar | Tags e links (up:, MOC) |
Notas de serviço: uma por instância, com a tag <tag> e as propriedades <lista>. Requisições e ferramentas: genéricas, sem valores de instância.

## 5. Ferramentas
| Ferramenta | kind | service_tag / service_param | Parâmetros | writes | expose | Requisição ou endpoint |

## 6. Segurança e aprovações
Quais ferramentas gravam dados (e que você só vai executar com autorização do usuário), quais segredos permitem qualquer domínio (antes de cada execução das ferramentas que os usam você vai pedir autorização ao usuário, mostrando a URL de destino; recomende trocar pelo host exato), e o que precisa estar ligado nas configurações.

## 7. Testes
Chamadas de leitura que você vai fazer para validar, e o resultado esperado.

## 8. Perguntas em aberto e riscos
O que ainda depende do usuário ou pode dar errado.
```

## 9. Depois da aprovação

1. Crie as notas de serviço (se preciso), depois as de requisição e por último as de ferramenta, seguindo as convenções do cofre.
2. Chame `list_vault_tools` e corrija até nenhuma ferramenta nova ter `problems`. Leia também os `warnings`.
3. Ferramentas `kind: script` só aparecem como `ready` com os scripts ligados nas configurações; se estiverem como `scripts-disabled`, avise o usuário. Não há aprovação de ferramenta no plugin: o cliente de IA pede permissão ao usuário na hora da chamada.
4. Teste as ferramentas de leitura com `run_vault_tool` ou pelo nome. Não execute ferramentas `writes: true` sem autorização, nem ferramentas que usam segredos de qualquer domínio sem a autorização da regra 8.
5. Termine com um resumo: ferramentas criadas, notas criadas, testes feitos e o que o usuário ainda precisa fazer.

Se você não tem acesso ao servidor MCP deste cofre (`%MCP_SERVER_NAME%`), só aos arquivos, ainda pode criar as notas dentro de `%VAULT_PATH%`. Nesse caso peça ao usuário para conferir o status em Obsidian → painel Environment Variables → Ferramentas do cofre.
