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

This is a **service note** template of the Environment Keys plugin. The `bitbucket_*` tools pick a workspace through the `instance` parameter and read the properties below. Notes tagged `template` are never used as an instance.

## How to fill it in

1. Duplicate this note and name it after the workspace (e.g. "Bitbucket Access - Company").
2. Remove the `template` tag from the copy.
3. Fill in the properties:

| Property | What to put |
| --- | --- |
| `url` | Keep `https://api.bitbucket.org/2.0` |
| `workspace` | The workspace slug, as in `bitbucket.org/<workspace>` |
| `auth_token` | `"{{bearer:NAME}}"`: a Bearer token variable with a workspace (or repository) access token |

Create the variable in the plugin's panel (key icon → New variable) with the allowed host `api.bitbucket.org`. Never paste a token here: only the placeholder.

## Test

- [ ] `bitbucket_list_repositories_in_a_workspace` lists the workspace's repositories
