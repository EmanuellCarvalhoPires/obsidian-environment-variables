---
tags:
  - bitbucket/workspace
  - template
up: "[[MCP Tools]]"
url: https://api.bitbucket.org/2.0
workspace:
token_type: Workspace access token
auth_token:
---
# Bitbucket Access - Template

Este é um molde de **nota de serviço** do plugin Environment Keys. As ferramentas `bitbucket_*` escolhem o workspace pelo parâmetro `instance` e leem as propriedades abaixo. Notas com a tag `template` nunca são usadas como instância.

## Como preencher

1. Duplique esta nota e dê o nome do workspace (ex.: "Bitbucket Access - Empresa").
2. Tire a tag `template` da cópia.
3. Preencha as propriedades:

| Propriedade | O que colocar |
| --- | --- |
| `url` | Mantenha `https://api.bitbucket.org/2.0` |
| `workspace` | O slug do workspace, como em `bitbucket.org/<workspace>` |
| `auth_token` | `"{{bearer:NOME}}"`: uma variável token Bearer com um access token do workspace (ou do repositório) |

Crie a variável no painel do plugin (ícone de chave → Nova variável) com o domínio permitido `api.bitbucket.org`. Nunca cole um token aqui: só o placeholder.

## Teste

- [ ] `bitbucket_list_repositories_in_a_workspace` lista os repositórios do workspace
