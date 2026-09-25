# Guide for AI agents: creating vault tools

You are going to configure **MCP tools defined by notes** in this user's Obsidian vault, using the **Environment Variables** plugin. A tool can be a single one (e.g. "get a Jira issue") or a set for an app or service (e.g. "tools for Google Drive").

You **do not change the plugin's code**. All configuration is done by creating and editing Markdown notes. The plugin finds the notes by itself and publishes them as MCP tools to every connected client (Claude Code, Codex, Cursor...).

## 1. Mandatory rules

1. **Read this whole guide before acting.**
2. **Survey the current state before asking anything:**
   - **make sure you are talking to this vault's server.** Each Obsidian vault has its own MCP server, with its own name, port, secrets and tools. This guide belongs to the vault **%VAULT_NAME%**, whose server is named `%MCP_SERVER_NAME%` (`%SERVER_URL%`). Only use that server's tools (in Claude Code they show up as `mcp__%MCP_SERVER_NAME%__list_vault_tools`, `mcp__%MCP_SERVER_NAME%__list_secrets` and so on). If the client has other `environment-variables…` servers, ignore them: they belong to other vaults. If this vault's server is missing, ask the user to connect the client in Obsidian → Environment Variables panel → AI clients;
   - call `list_vault_tools` to see the existing tools and request notes, and their problems;
   - call `list_secrets` to see the stored secrets (name, type, allowed hosts, where they may be placed). Values are never shown;
   - search the vault for existing service, request and tool notes (by the tags in section 10) and reuse what you can;
   - read the vault's conventions: instruction files such as `CLAUDE.md` or `AGENTS.md`, index notes (MOCs), the tag taxonomy and properties such as `up:`. Follow those conventions in the notes you create.
3. **If any information is missing, ask the user before writing the plan.** Use the list in section 3. Ask all questions at once, numbered. **Never invent values**: URLs, IDs, secret names, scopes, field names or endpoints you have not confirmed in the official documentation or with the user.
4. **Never ask for, read, write or log the value of a token, password or key.** If a secret does not exist yet, the user creates it in the plugin's panel in Obsidian (key icon → "New variable"). You only use its name in placeholders such as `{{basic:NAME}}`.
5. **The notes you create are generic.** Every value of an instance or account (URL, IDs, secret placeholder) lives **only in the service note of that instance**, one note per instance. Request and tool notes **never** hold those values: they use `{{service.<property>}}` and receive the values of the instance chosen in the call. Create **one** generic tool with `service_tag` and `service_param` (section 4.3), never one tool per instance. This applies even when there is only one instance today: a new instance then works with just a new service note.
6. **Always produce an Implementation Plan**, using the template in section 8, and **wait for the user's explicit approval** before creating or editing any note. If the user asks for changes, update the plan and ask for approval again.
7. **After implementing, validate:** call `list_vault_tools` until no new tool has `problems`. Only test read-only tools. A tool that writes data (`writes: true`) may only run with the user's explicit permission for that run.
8. **Secrets that allow any host: always ask for permission.** In `list_secrets`, these secrets show `allowAnyHost: true`. The plugin does not check where they go and opens no approval dialog when a tool uses them: **checking is up to you**. Before **every** run of a tool whose service note uses one of these secrets (even read-only, even in tests), show the user the secret name and the full destination URL and wait for their explicit permission for that run. Never run it without that answer, and never change the service note's URL without saying so. When planning, prefer asking the user to replace "any host" with the API's exact host.
9. **Work in this vault only.** Create and edit notes only inside `%VAULT_PATH%`: notes in another vault do not become tools here, and this vault's secrets do not work in another one. If the user wants the same tools in another vault, they must be created there, with that vault's guide and the secrets stored in it.
10. **Do not edit** `data.json`, `vault.enc` or anything inside `.obsidian/`. Do not try to work around the plugin's security rules (allowed hosts, approvals, masking).

## 2. How the plugin works

- The plugin runs inside Obsidian and has **one local MCP server per vault**. This vault's server is named `%MCP_SERVER_NAME%` and listens on `%SERVER_URL%`. Each vault has its own secrets, client tokens, notes and tools; one vault's token is refused by another vault's server. While the secret vault is locked, calls that use secrets fail until the user unlocks it.
- The **tool registry** scans the vault for notes with the tool tag (section 10), validates each one and publishes the valid ones in MCP `tools/list`. The list updates by itself when a note changes. If the client does not reload the list, use `run_vault_tool`.
- **Secrets** are encrypted inside the plugin. Notes only hold placeholders (`{{secret:NAME}}`, `{{basic:NAME}}`, `{{bearer:NAME}}`), replaced with the real value at the last moment by the *broker*, which checks that the destination host is allowed for that secret and masks the value in the response.
- The plugin finds notes **by tags and links, never by folder**. Notes can live anywhere in the vault.

There are three kinds of notes:

| Note | Purpose | Has code? |
| --- | --- | --- |
| **Service** | **One per instance or account.** Holds its values: base URL, secret placeholder, IDs. All service notes of the same app share the same tag and the same properties | No |
| **Request** | A saved HTTP call, like in Postman, in a ```` ```http ```` block. Generic: only uses `{{service.*}}` and `{{param:*}}` | No |
| **Tool** | What the AI can call: name, description, parameters. Generic: the instance is a parameter of the call. `kind: request` runs a request note; `kind: script` runs a ```` ```js ```` block of the note itself | Only `kind: script` |

Prefer `kind: request`. Use `kind: script` only when the tool needs to combine several calls, paginate, filter or transform the response. Scripts must be turned on in the settings. The plugin does not ask for approval to run tools, nor for the requests they make: the AI client asks the user for permission (e.g. Claude Code asks before calling an MCP tool). This also applies to secrets that allow any host: in that case you ask the user for permission before every run (rule 8). So ask the user for permission before running any tool that writes data.

## 3. Information to gather (ask for what you do not know)

1. **Service and instances:** which app or API, which accounts, instances or workspaces will use the tools (e.g. `acme.atlassian.net`), whether service notes already exist for them (with which tag and properties), and whether a note with that tag is a template that must be left out.
2. **Documentation:** link to the official API documentation, or the exact endpoints to use.
3. **Base URL** of the API.
4. **Authentication:** API key, Basic (user or e-mail + token), Bearer/Personal Access Token or OAuth 2.0. Read section 7 before planning OAuth.
5. **Secret:** if it already exists in this vault's `list_secrets`, which one, and whether its allowed hosts include the API host. If not, the name the user will create, its type and allowed hosts.
6. **Operations:** the list of actions the user wants (e.g. list files, get a file, create a folder) and **which ones write data**.
7. **Parameters** of each operation: name, type, required or not, allowed values.
8. **Expected result:** is the raw API response enough, or must it be summarized, filtered or paginated (this decides between `request` and `script`).
9. **Names and place of the notes:** tool name prefix (e.g. `gdrive_`), note names and where they fit in the vault structure (MOC, `up:`, tags).
10. **Exposure:** should each tool show up directly in the client's list (`expose: true`) or only through `run_vault_tool` (`expose: false`, useful for large sets).

## 4. Note formats

### 4.1 Service note

**One note per instance or account**, all with the same tag and the same properties. Property names are free. If the vault already has such notes (e.g. notes describing access to an instance), **use the tag and properties they already have** and only add what is missing.

The note name becomes the value the AI picks in the call, without the part all of them share: "Jira - ACME" and "Jira - Globex" become `ACME` and `Globex`.

```markdown
---
tags: [<the tag the vault uses for this kind of note>]
url: https://acme.atlassian.net
auth: "{{basic:JIRA_ACME}}"
cloud_id: 1234abcd-...
---
Free notes about the account. Saved as "Jira - ACME"; the Globex instance would be another note, "Jira - Globex", with its own values.
```

### 4.2 Request note (tag `%REQUEST_TAG%`)

````markdown
---
tags: [%REQUEST_TAG%]
---
Gets an issue with the requested fields, on any instance.

```http
GET {{service.url}}/rest/api/3/issue/{{param:key}}?fields={{param:fields}}
Authorization: {{service.auth}}
Accept: application/json
```
````

Rules of the ```` ```http ```` block:

- 1st line: `METHOD URL` (GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS). The URL must be absolute (`https://...`) once filled.
- Then one header per line as `Name: value`.
- A blank line and, if any, the body.
- `{{service.<property>}}`: the property's value in the service note **of the instance chosen in the call**, inserted as is. It may contain secret placeholders. Never write an instance's URL, ID or secret in the request.
- `{{param:<name>}}`: an argument of the call. In the URL the value is encoded. In a JSON body, text goes **inside quotes** (`"{{param:title}}"`) and numbers, booleans, objects and arrays go **without quotes** (`{{param:limit}}`).
- An optional parameter that was not given and is the whole value of a query pair (`?fields={{param:fields}}`) removes the pair from the URL. Anywhere else, a missing parameter is an error.
- Secret placeholders only work in **headers**, unless the secret allows the URL or the body. The URL host can never come from a secret placeholder.
- Arguments from the AI may never contain secret placeholders: the plugin refuses them.

### 4.3 Tool note, `kind: request` (tag `%TOOL_TAG%`)

```markdown
---
tags: [%TOOL_TAG%]
tool: jira_get_issue
kind: request
request: "[[Jira - Get issue]]"
service_tag: jira/instance
service_param: instance
service_exclude_tag: template
description: Gets a Jira issue by key, on the chosen instance. Use when the user mentions a key such as ACME-123.
params:
  key: { type: string, required: true, description: "Issue key, e.g. ACME-123" }
  fields: { type: string, description: "Comma-separated fields", default: "summary,status,assignee" }
writes: false
expose: true
---
Free documentation of the tool for humans.
```

With `service_tag`, the plugin creates the `instance` parameter by itself (its name comes from `service_param`), required, with the list of instances found: the notes tagged `jira/instance`, minus those tagged `template`. Do not declare that parameter in `params`. The call becomes `jira_get_issue({ instance: "ACME", key: "ACME-123" })`, and every `{{service.*}}` of the request gets the value from the note "Jira - ACME". A new instance joins the list by itself when its note is created.

### 4.4 Tool note, `kind: script`

````markdown
---
tags: [%TOOL_TAG%]
tool: jira_issue_digest
kind: script
service_tag: jira/instance
service_param: instance
service_exclude_tag: template
description: Summarizes an issue, on the chosen instance, with status, assignee and number of comments.
params:
  key: { type: string, required: true, description: "Issue key, e.g. ACME-123" }
writes: false
---
```js
export default async function (ctx) {
  const issue = await ctx.requests.run("Jira - Get issue", { key: ctx.args.key, fields: "summary,status,assignee" });
  if (!issue.ok) return { error: issue.status, details: issue.json ?? issue.body };
  const comments = await ctx.requests.run("Jira - Issue comments", { key: ctx.args.key });
  return {
    instance: ctx.args.instance,
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

### 4.5 Tool note properties

| Property | Required | Description |
| --- | --- | --- |
| `tool` | yes | Tool name: lower case letters, digits and `_`, starting with a letter, up to 64 characters. Unique in the vault. Cannot be `list_secrets`, `http_request`, `get_tool_authoring_guide`, `list_vault_tools` or `run_vault_tool`. |
| `description` | yes | What the tool does and **when to use it**. This is what the AI reads to pick the tool: be specific. |
| `kind` | yes | `request` or `script`. |
| `request` | for `request` | Link to the request note. |
| `service_tag` | yes, for generic tools | Tag of the service notes (one per instance). The plugin creates the parameter that picks the instance. |
| `service_param` | no | Name of that parameter. Default `instance`. Use a name that makes sense to the user, e.g. `instance`, `account`, `workspace`. |
| `service_exclude_tag` | no | Notes with this tag are left out of the instance list (e.g. templates). |
| `service` | no | Link to **one** fixed service note. Only use it when the service has, and will always have, a single account. Cannot be used together with `service_tag`. |
| `params` | no | Map `name: { type, required, description, enum, default }`. `type`: `string`, `number`, `integer`, `boolean`, `object` or `array`. |
| `writes` | no | `true` if the tool creates, changes or deletes data. Default `false`. |
| `expose` | no | `false` hides it from the client's list; it stays reachable through `run_vault_tool`. Default `true`. |
| `title` | no | Short title. Default: the note name. |
| `enabled` | no | `false` turns the tool off without deleting the note. |

Other vault properties (`tags`, `up`, `aliases`...) can stay in the note as usual.

## 5. Script API (`ctx`)

The ```` ```js ```` block must export the function: `export default async function (ctx) { ... }`. The `return` value becomes the tool result and must be JSON-serializable.

| Call | What it does |
| --- | --- |
| `ctx.args` | Arguments already validated against `params`, with defaults applied. |
| `ctx.tool` | Tool name. |
| `ctx.service` | The service note of the chosen instance (`name`, `path`, `frontmatter`, `tags`), or `null`. |
| `await ctx.requests.run(note, params, { service })` | Runs a request note with the instance chosen in the call. `service` (optional) swaps the service note. |
| `await ctx.http({ method, url, headers, body })` | Free request, with secret placeholders in headers. An object `body` becomes JSON. |
| `await ctx.notes.get(refOrName)` | Note with `name`, `path`, `frontmatter`, `tags` and `body`, or `null`. |
| `await ctx.notes.query({ tag, name, limit })` | Notes with the tag (and subtags), without the body. |
| `ctx.log(...)` | Debug message. |

Requests return `{ status, statusText, ok, headers, json | body, truncated }`, with any secret already masked as `***`.

Limits: the script runs in an isolated JavaScript interpreter (QuickJS, in WebAssembly). There is no `fetch`, `import`, `require`, `setTimeout`, DOM or network access outside `ctx`; `console.log` works like `ctx.log`. Scripts have a maximum run time (%SCRIPT_TIMEOUT% s; time spent waiting for requests and approvals does not count) and a 64 MB memory limit. An HTTP error does not stop the script: check `ok` and `status`. Configuration errors (note not found, missing parameter, host not allowed) become exceptions with explanatory messages.

## 6. Names and descriptions that work

- Prefix by service and use a verb: `gdrive_list_files`, `gdrive_get_file`, `jira_create_issue`. Do not put an instance name in the tool name: the instance is a parameter.
- In `description`, say what the tool returns and when to use it, with example parameter values.
- One tool per action. For large sets, expose only the most used ones and leave the rest with `expose: false`.

## 7. Authentication: what the plugin supports

- **Supported:** fixed values: API key (`{{secret:NAME}}` in a header such as `X-API-Key`), Basic (`{{basic:NAME}}`, user + token), Bearer/PAT (`{{bearer:NAME}}`) and custom headers.
- **Not supported yet: OAuth 2.0 with token refresh.** This is the case for most **Google** APIs (Drive, Gmail, Calendar) and **Microsoft Graph**: the access token expires after about 1 hour and must be renewed with a refresh token, and the plugin only stores fixed values.
  - Tell the user **before** writing the plan and present the alternatives: an API key, if the API accepts one for that use (e.g. public data on Google, with the `X-goog-api-key` header); a ready-made MCP connector for the service, if one exists; or waiting for OAuth support in the plugin.
  - **Never** ask the user to paste an access token into a note, and never propose storing tokens outside the plugin.
- If the secret does not allow the API host, the plugin blocks the call (`host_not_allowed`). The user adjusts the allowed hosts in the plugin's panel.

## 8. Mandatory Implementation Plan template

Present the plan to the user with exactly these sections and wait for approval:

```markdown
# Implementation plan: <name of the tool set>

## 1. Goal
What the user will be able to ask the AI after this implementation.

## 2. Confirmed information
Vault: %VAULT_NAME% (server `%MCP_SERVER_NAME%`). Service, instances, base URL, documentation used and the user's answers.

## 3. Authentication
Secret used (name and type), whether it exists or the user must create it, and the allowed hosts needed.
User action needed: <e.g. create the secret GDRIVE_KEY of type token for the host www.googleapis.com>.

## 4. Notes to create or change
| Note | Kind (service/request/tool) | Create/change | Tags and links (up:, MOC) |
Service notes: one per instance, with the tag <tag> and the properties <list>. Requests and tools: generic, without instance values.

## 5. Tools
| Tool | kind | service_tag / service_param | Parameters | writes | expose | Request or endpoint |

## 6. Security and approvals
Which tools write data (and that you will only run with the user's permission), which secrets allow any host (before every run of the tools that use them you will ask the user for permission, showing the destination URL; recommend replacing them with the exact host), and what must be turned on in the settings.

## 7. Tests
Read-only calls you will make to validate, and the expected result.

## 8. Open questions and risks
What still depends on the user or may go wrong.
```

## 9. After approval

1. Create the service notes (if needed), then the request notes and last the tool notes, following the vault's conventions.
2. Call `list_vault_tools` and fix until no new tool has `problems`. Read the `warnings` too.
3. `kind: script` tools are only `ready` with scripts turned on in the settings; if they show `scripts-disabled`, tell the user. There is no tool approval in the plugin: the AI client asks the user for permission when the tool is called.
4. Test the read-only tools with `run_vault_tool` or by name. Do not run `writes: true` tools without permission, nor tools that use any-host secrets without the permission of rule 8.
5. Finish with a summary: tools created, notes created, tests done and what the user still has to do.

If you do not have access to this vault's MCP server (`%MCP_SERVER_NAME%`), only to the files, you can still create the notes inside `%VAULT_PATH%`. In that case ask the user to check the status in Obsidian → Environment Variables panel → Vault tools.
