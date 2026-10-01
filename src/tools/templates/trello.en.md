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

This is a **service note** template of the Environment Keys plugin. The Trello requests pick an account through the `instance` parameter and read the properties below. Notes tagged `template` are never used as an instance.

## How to fill it in

1. Duplicate this note and name it after the account (e.g. "Trello Access - Company").
2. Remove the `template` tag from the copy.
3. Fill in the properties:

| Property | What to put |
| --- | --- |
| `url` | Keep `https://api.trello.com/1` |
| `auth_token` | `"{{secret:NAME}}"`: a custom header value variable, allowed host `api.trello.com`, with the value `OAuth oauth_consumer_key="<key>", oauth_token="<token>"` |

Get the API key and the token at `trello.com/power-ups/admin`. Create the variable in the plugin's panel (key icon → New variable). Never paste a token here: only the placeholder.

## Test

- [ ] `Trello - Get a Member` with `id: me` returns your account
