---
tags:
  - atlassian/instance
  - template
up: "[[MCP Tools]]"
type: Cloud
url: https://empresa.atlassian.net
cloud_id:
assets_workspace_id:
api_version: 3
email:
account_id:
token_type: API token
auth_token:
org_id:
admin_auth_token:
scim_directory_id:
scim_auth_token:
---
# Atlassian Access - Template

Este é um molde de **nota de serviço** do plugin Environment Keys. As ferramentas dos apps da Atlassian (Jira, JSM, Confluence, Automation, Assets; o Bitbucket tem molde próprio) escolhem a instância pelo parâmetro `instance` e leem as propriedades abaixo. Notas com a tag `template` nunca são usadas como instância.

## Como preencher

1. Duplique esta nota e dê o nome da instância (ex.: "Atlassian Access - Empresa").
2. Tire a tag `template` da cópia.
3. Preencha as propriedades de que precisar:

| Propriedade | O que colocar |
| --- | --- |
| `url` | O seu site, ex.: `https://empresa.atlassian.net` |
| `cloud_id` | Abra `https://<site>/_edge/tenant_info` e copie o `cloudId` (Automation, Assets, Forms, JSM Ops) |
| `assets_workspace_id` | Rode a ferramenta `jsm_get_assets_workspaces` (só Assets) |
| `email`, `account_id` | Seu e-mail e o ID da sua conta Atlassian (opcional, para referência) |
| `auth_token` | `"{{basic:NOME}}"`: uma variável usuário + token com o seu e-mail e um API token da Atlassian |
| `org_id`, `admin_auth_token` | ID da organização e `"{{bearer:NOME}}"` com uma API key de admin (só APIs de Admin) |
| `scim_directory_id`, `scim_auth_token` | ID do diretório e `"{{bearer:NOME}}"` com a chave SCIM (só provisionamento de usuários) |

Crie cada variável no painel do plugin (ícone de chave → Nova variável), com o domínio permitido do site (e `api.atlassian.com` quando a ferramenta chamar esse endereço). Nunca cole um token aqui: só o placeholder.

## Teste

- [ ] `jira_get_current_user` retorna o seu usuário
