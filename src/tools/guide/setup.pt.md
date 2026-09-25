# Setar o ambiente MCP do plugin Environment Variables

Você vai configurar, do zero, o ambiente MCP do plugin **Environment Variables** do Obsidian no computador deste usuário. O objetivo é deixar tudo pronto para ele usar as funcionalidades do plugin: o cliente de IA conectado ao servidor do cofre, as variáveis de ambiente (segredos) necessárias, as notas de serviço, de requisição e de ferramenta de um app ou serviço, e as ferramentas MCP validadas.

## Etapas do ambiente

Siga nesta ordem. As ações marcadas como **usuário** são feitas por ele no Obsidian: explique o caminho e espere ele confirmar.

1. **Plugin instalado e ativo (usuário).** Obsidian → Configurações → Plugins da comunidade → Environment Variables ligado. O cofre de segredos precisa estar criado e desbloqueado (painel Environment Variables, ícone de chave na barra lateral).
2. **Cliente de IA conectado (usuário).** No painel do plugin → Clientes de IA → **Conectar** no seu cliente (Claude Code, Codex, Cursor...). Isso liga o servidor local e registra o servidor MCP no cliente, sem token para copiar. Depois o cliente precisa ser recarregado. Se o cliente não estiver na lista, use "Outro cliente (configuração manual)".
3. **Servidor certo.** Encontre o servidor MCP do plugin nas suas ferramentas (regra 2 do guia). Se houver mais de um, pergunte qual é o cofre. Chame `list_secrets` e, se existir, `list_vault_tools`.
4. **Ferramentas do cofre ligadas (usuário).** Se `list_vault_tools` não existir, ou informar `enabled: false`, peça para ligar em Configurações → Environment Variables → Ferramentas do cofre. Ferramentas com script só são necessárias se o plano usar `kind: script`.
5. **Convenções do cofre.** Leia os arquivos de instruções (`CLAUDE.md`, `AGENTS.md`), as notas índice (MOCs), a taxonomia de tags e propriedades como `up:`, e siga essas convenções nas notas que criar.
6. **Pergunta obrigatória.** Faça a pergunta do final deste prompt e espere a resposta.
7. **Plano de Implementação** no modelo da seção 8 do guia, incluindo: cada variável de ambiente que o usuário vai cadastrar (nome, tipo e hosts permitidos), as notas de serviço (uma por instância), as notas de requisição, as notas de ferramenta e onde elas entram no cofre (nota índice, `up:`, tags). Espere a aprovação explícita.
8. **Variáveis de ambiente (usuário).** Depois da aprovação, o usuário cadastra cada variável no painel do plugin (ícone de chave → Nova variável), com o nome, o tipo e os hosts permitidos do plano. Tipos: token, usuário + token (Basic), token Bearer, valor de header customizado ou variável de ambiente. Você nunca vê, pede ou escreve o valor: confirme só pelo `list_secrets`.
9. **Notas e validação:** siga a seção 9 do guia.

%GUIDE%
%REQUEST%
## Pergunta obrigatória antes de criar qualquer coisa

Depois de levantar o estado atual (etapas 1 a 5, só leitura), pergunte ao usuário, exatamente com estas duas perguntas:

1. **Quais variáveis de ambiente (segredos) devem ser configuradas?** Por exemplo: um token de API, um usuário + token, um token Bearer.
2. **Para qual app ou serviço elas são?** Por exemplo: Jira, GitHub, Google Drive, uma API interna. Se houver mais de uma conta ou instância, quais.

Se o pedido do usuário já trouxer essas informações, confirme-as com ele. Se a resposta não trouxer as duas, ou vier incompleta, **pergunte de novo, explicitamente, o que faltou, e não siga com a criação**: não monte o plano, não crie nem altere nenhuma nota e não peça o cadastro de nenhuma variável até ter as duas respostas.
