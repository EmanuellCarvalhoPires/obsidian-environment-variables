---
tags:
  - trello/account
  - template
up: "[[MCP Tools]]"
url: https://api.trello.com/1
token_type: API key + token (custom header)
auth_token:
---
# Trello Access - Template

Este é um molde de **nota de serviço** do plugin Environment Keys. As requisições do Trello escolhem a conta pelo parâmetro `instance` e leem as propriedades abaixo. Notas com a tag `template` nunca são usadas como instância.

## Como preencher

1. Duplique esta nota e dê o nome da conta (ex.: "Trello Access - Empresa").
2. Tire a tag `template` da cópia.
3. Preencha as propriedades:

| Propriedade | O que colocar |
| --- | --- |
| `url` | Mantenha `https://api.trello.com/1` |
| `auth_token` | `"{{secret:NOME}}"`: uma variável valor de header customizado, domínio permitido `api.trello.com`, com o valor `OAuth oauth_consumer_key="<key>", oauth_token="<token>"` |

Pegue a API key e o token em `trello.com/power-ups/admin`. Crie a variável no painel do plugin (ícone de chave → Nova variável). Nunca cole um token aqui: só o placeholder.

## Teste

- [ ] `Trello - Get a Member` com `id: me` retorna a sua conta
