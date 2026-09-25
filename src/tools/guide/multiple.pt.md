# Adicionar várias ferramentas no plugin Environment Variables

Você vai adicionar **várias ferramentas MCP** definidas por notas ao cofre do Obsidian deste usuário, usando o plugin **Environment Variables** (ex.: "listar, buscar e comentar tickets"). As ferramentas podem ser de um app que já está configurado no cofre ou de um app novo. Se o cliente ainda não tiver o servidor do plugin, ou as ferramentas do cofre estiverem desligadas, avise e sugira o prompt "Setar o ambiente MCP".

Isto muda as regras do guia assim:

1. **Levantamento (regra 2):** encontre o servidor MCP do plugin (se houver mais de um, pergunte qual é o cofre). Além do que a regra pede, liste as ferramentas que o app já tem, para não duplicar nenhuma e para manter o mesmo padrão (prefixo do nome, `service_tag`, `service_param`, tags e `up:`).
2. **Base do app:** se o app ainda não tiver nota de serviço ou variável de ambiente no cofre, inclua essa base no plano (seção 3 inteira).
3. **Reaproveite:** uma nota de serviço por instância e uma nota de requisição por endpoint, compartilhadas entre as ferramentas. Prefira `kind: request`; use `kind: script` só onde a seção 2 justificar.
4. **Conjuntos grandes:** proponha quais ferramentas ficam com `expose: true` (as mais usadas) e quais ficam só pelo `run_vault_tool` (`expose: false`).
5. **Plano:** use o modelo completo da seção 8, com uma linha por ferramenta na tabela da seção 5 do plano, e espere a aprovação explícita do usuário antes de criar ou editar qualquer nota.
6. **Depois da aprovação:** siga a seção 9 do guia, criando primeiro o que for compartilhado (serviço e requisições) e validando todas as ferramentas com `list_vault_tools` no final.

%GUIDE%
%REQUEST%
## Pergunta obrigatória antes de criar qualquer coisa

Depois do levantamento (só leitura), pergunte ao usuário, exatamente com estas três perguntas:

1. **Quais ferramentas você quer criar?** A lista numerada das ações, marcando quais gravam dados.
2. **Para qual app ou serviço elas são?** E em quais contas ou instâncias.
3. **Quais variáveis de ambiente (segredos) elas usam?** As que já existem (mostre as que `list_secrets` listou para esse app) ou novas, com o tipo.

Se o pedido do usuário já trouxer essas informações, confirme-as com ele. Se a resposta não trouxer as três, ou vier incompleta, **pergunte de novo, explicitamente, o que faltou, e não siga com a criação**: não monte o plano e não crie nem altere nenhuma nota até ter as três respostas.
