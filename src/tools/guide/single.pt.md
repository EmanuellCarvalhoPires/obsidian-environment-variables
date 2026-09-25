# Adicionar uma ferramenta no plugin Environment Variables

Você vai adicionar **uma única ferramenta MCP** definida por nota ao cofre do Obsidian deste usuário, usando o plugin **Environment Variables** (ex.: "buscar um ticket pela chave"). Se o pedido tiver mais de uma ação, pare e sugira o prompt "Adicionar várias ferramentas". Se o ambiente ainda não estiver configurado (cliente sem o servidor do plugin, ferramentas do cofre desligadas, app sem nota de serviço ou sem variável de ambiente), avise e sugira o prompt "Setar o ambiente MCP".

Este pedido tem um escopo menor. Isto muda as regras do guia assim:

1. **Levantamento curto (regra 2):** encontre o servidor MCP do plugin (se houver mais de um, pergunte qual é o cofre), chame `list_vault_tools` e `list_secrets` e procure só as notas de serviço, de requisição e de ferramenta do mesmo app. Reaproveite a nota de serviço, a variável de ambiente e as requisições que já existem, e copie o padrão das ferramentas do mesmo app (prefixo do nome, `service_tag`, `service_param`, tags e `up:`).
2. **Perguntas só do que faltar**, depois da pergunta obrigatória do final: o endpoint (ou o link da documentação), os parâmetros, se grava dados e o nome da ferramenta.
3. **Plano resumido em vez do modelo da seção 8.** Apresente este plano e espere a aprovação explícita do usuário antes de criar ou editar qualquer nota:

```markdown
# Plano: <nome da ferramenta>

- **O que faz:** <o que o usuário vai poder pedir à IA>
- **Ferramenta:** `<tool>` · kind `<request|script>` · writes `<true|false>` · expose `<true|false>`
- **Instâncias:** service_tag `<tag>` / service_param `<nome>` (notas de serviço já existentes: <lista>)
- **Parâmetros:** <nome: tipo, obrigatório, descrição>
- **Requisição:** <nota reaproveitada ou nova> · `<MÉTODO URL com {{service.*}} e {{param:*}}>`
- **Variável de ambiente:** `<NOME>` (<já existe / o usuário precisa cadastrar>; <host permitido ou qualquer domínio>)
- **Notas a criar ou alterar:** <lista, com tags e links>
- **Teste:** <chamada de leitura e resultado esperado, ou "não será executada: grava dados">
```

4. **Depois da aprovação:** siga a seção 9 do guia para essa ferramenta.

%GUIDE%
%REQUEST%
## Pergunta obrigatória antes de criar qualquer coisa

Depois do levantamento (só leitura), pergunte ao usuário, exatamente com estas três perguntas:

1. **Qual ferramenta você quer criar?** A ação exata que a IA vai poder fazer (ex.: "buscar um ticket pela chave").
2. **Para qual app ou serviço ela é?** E em quais contas ou instâncias.
3. **Quais variáveis de ambiente (segredos) ela usa?** Uma que já existe (mostre as que `list_secrets` listou para esse app) ou uma nova, com o tipo.

Se o pedido do usuário já trouxer essas informações, confirme-as com ele. Se a resposta não trouxer as três, ou vier incompleta, **pergunte de novo, explicitamente, o que faltou, e não siga com a criação**: não monte o plano e não crie nem altere nenhuma nota até ter as três respostas.
