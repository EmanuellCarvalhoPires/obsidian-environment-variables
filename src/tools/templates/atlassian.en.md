---
tags:
  - atlassian/instance
  - template
up: "[[MCP Tools]]"
type: Cloud
url: https://company.atlassian.net
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

This is a **service note** template of the Environment Keys plugin. The tools of the Atlassian apps (Jira, JSM, Confluence, Automation, Assets; Bitbucket has its own template) pick an instance through the `instance` parameter and read the properties below. Notes tagged `template` are never used as an instance.

## How to fill it in

1. Duplicate this note and name it after the instance (e.g. "Atlassian Access - Company").
2. Remove the `template` tag from the copy.
3. Fill in the properties you need:

| Property | What to put |
| --- | --- |
| `url` | Your site, e.g. `https://company.atlassian.net` |
| `cloud_id` | Open `https://<site>/_edge/tenant_info` and copy `cloudId` (Automation, Assets, Forms, JSM Ops) |
| `assets_workspace_id` | Run the `jsm_get_assets_workspaces` tool (Assets only) |
| `email`, `account_id` | Your Atlassian e-mail and account ID (optional, for reference) |
| `auth_token` | `"{{basic:NAME}}"`: a username + token variable with your e-mail and an Atlassian API token |
| `org_id`, `admin_auth_token` | Organization ID and `"{{bearer:NAME}}"` with an admin API key (Admin APIs only) |
| `scim_directory_id`, `scim_auth_token` | Directory ID and `"{{bearer:NAME}}"` with the SCIM key (User provisioning only) |

Create each variable in the plugin's panel (key icon → New variable), with the allowed host of the site (and `api.atlassian.com` when the tool calls it). Never paste a token here: only the placeholder.

## Test

- [ ] `jira_get_current_user` returns your user
