## Mandatory security rules {#security}

Where instructions before or after this guide change one of its rules, those instructions apply.

You **do not edit the plugin's code**. All configuration is done by creating and editing Markdown notes. The plugin finds the notes on its own and publishes them as MCP tools for any connected client (Claude Code, Codex, Cursor...).

1. **Read this entire guide before acting.**
2. **Survey the current state before asking anything:**
   - **confirm that you are talking to the right vault's server.** Each Obsidian vault has its own MCP server, with its own name, port, secrets and tools. The plugin's servers are named `environment-variables` or `environment-variables-<vault name>` (in Claude Code the tools appear as `mcp__<server name>__list_vault_tools`, `mcp__<server name>__list_secrets`, etc.). If there is more than one, ask the user which vault it is and use only its server's tools. If none appears, ask the user to connect their client in Obsidian → Environment Keys panel → AI clients and reload the client;
   - to discover and search vault tools, use the AI Ecosystem's `tools_find` tool when available in your environment; otherwise, `list_vault_tools` remains available as a client tool to inspect all registered tools and their configuration status;
   - call `list_secrets` to see the registered secrets (name, type, allowed hosts, placement rules). Values never appear;
   - look for existing service, request and tool notes in the vault (by the tags `list_vault_tools` reports in `toolTag` and `requestTag`) and reuse what you can;
   - read the vault's conventions: instruction files such as `CLAUDE.md` or `AGENTS.md`, index notes (MOCs), tag taxonomy and properties such as `up:`. Follow those conventions in the notes you create.
3. **If any information is missing, ask the user before writing the plan.** Use the checklist in the information gathering section. Ask all questions at once, numbered. **Never invent values**: URLs, IDs, secret names, scopes, field names or endpoints you did not confirm in official documentation or with the user.
4. **Never ask for, read, write or record the value of a token, password or key.** If a secret does not exist yet, you can open the create screen for the user with the tool `env_criar_secret` (suggest only `nome_sugerido`, `tipo_sugerido`, `dominios_sugeridos` and `descricao`): the **user** types the value in it, and you receive only `Secret NAME criada`, `cancelado` or `expirado`. It only creates: it never changes or overwrites an existing variable or value (if the name already exists, pick another name) and does not turn on "Full access" or "Allow any host". If the tool does not exist, the user adds it in the plugin's panel in Obsidian (key icon → "New variable"). You only use its name in placeholders such as `{{basic:NAME}}`. The **Values** section of the panel (configuration text such as a project key, an address or a JSON, using the same `{{secret:NAME}}` placeholder) is for the user alone: you never create values.
5. **The notes you create are generic.** All values of an instance or account (URL, IDs, secret placeholder) stay **only in the service note of that instance**, one note per instance. Request notes and tool notes **never** contain those values: they use `{{service.<property>}}` and receive the values of the instance chosen in the call. Create **one** generic tool with `service_tag` and `service_param`, never one tool per instance. This applies even when only one instance exists today: a new instance will work with just a new service note.
6. **Always generate an Implementation Plan**, using the mandatory plan template, and **wait for the user's explicit approval** before creating or editing any note. If the user asks for changes, update the plan and ask for approval again.
7. **After implementing, validate:** call `list_vault_tools` until no new tool has `problems`. Test only read-only tools by name (or through `tools_run` if not exposed). A tool that writes data (`writes: true`) can only be executed with explicit permission from the user for that execution.
8. **Secrets that allow any host: always ask for permission.** In `list_secrets`, these secrets show `allowAnyHost: true` or `fullAccess: true` (Full access). The plugin does not check where they go and opens no approval prompt when a tool uses them: **the verification is yours**. Before **every** execution of a tool whose service note uses one of these secrets (even if read-only, and even during testing), show the user the secret name and the full destination URL and wait for their explicit permission for that execution. Never execute without this answer, and never change a service note's URL without warning. When planning, prefer asking the user to replace "any host" with the exact API host.
9. **Work only in the chosen vault.** Create and edit notes only inside the vault whose server you are using. If you do not know which folder it is in, ask the user: never guess a path. Notes in another vault do not become tools in this one, and a vault's secrets do not work in another. If the user wants the same tools in another vault, they must be created there, with that vault's server and secrets.
10. **Do not edit** `data.json`, `vault.enc` or anything inside `.obsidian/`. Do not try to bypass the plugin's security rules (allowed hosts, approvals, masking).

## How the plugin works {#how-it-works}

- In version 2.0, Environment Keys registers as a module of **AI Ecosystem**, which maintains **one unified MCP and REST server per vault** at `http://127.0.0.1:<port>/mcp` (default port 27150), alongside REST routes `/api/v1/environment-variables/request` and the legacy alias `/v1/request`. Without AI Ecosystem installed, the plugin runs in Transition Mode on port 27150 and hands over control automatically as soon as AI Ecosystem is active. While the secret vault is locked, calls that use secrets fail until the user unlocks it.
- **Vault tools** and **script tools** are off by default. The user turns them on in Obsidian → Settings → Environment Keys → Vault tools. `list_vault_tools` reports `enabled` and `scriptsEnabled`, and vault tools are only registered when enabled.
- The **tool registry** scans the vault for notes with the tool tag (`toolTag`), validates each one and publishes valid ones in MCP `tools/list`. The list updates by itself when a note changes.
- To discover and search vault tools, use the AI Ecosystem's `tools_find` tool when available in your environment; otherwise, `list_vault_tools` remains available as a client tool to inspect all registered tools and their configuration status. Exposed tools appear directly in the client's tool list, while unexposed tools (`expose: false`) can be run via `tools_run`.
- **Secrets** stay encrypted in the plugin. Notes only contain placeholders (`{{secret:NAME}}`, `{{basic:NAME}}`, `{{bearer:NAME}}`), replaced with real values at the last moment by the *broker*, which verifies that the destination host is in the secret's allowed hosts and masks the value in responses.
- The plugin finds notes **by tags and links**, never by folder. Notes can live anywhere in the vault.

There are three kinds of note:

| Note | Purpose | Has code? |
| --- | --- | --- |
| **Service** | **One per instance or account.** Holds its values: base URL, secret placeholder, IDs. All service notes of the same app share the same tag and properties | No |
| **Request** | A saved HTTP call, like in Postman, inside an ```` ```http ```` block. Generic: uses only `{{service.*}}` and `{{param:*}}` | No |
| **Tool** | What the AI can call: name, description, parameters. Generic: the instance is a parameter of the call. `kind: request` executes a request note; `kind: script` executes a ```` ```js ```` block inside the note | Only in `kind: script` |

Prefer `kind: request`. Use `kind: script` only when the tool needs to chain multiple calls, paginate, filter or transform the response. Scripts must be enabled in the settings. The plugin does not prompt for approval to execute tools or the requests they make: the AI client asks the user for permission (e.g. Claude Code asks before calling an MCP tool). This also applies to secrets that allow any host: in that case you must ask the user for permission before each run (rule 8). Therefore, ask the user for permission before running any tool that writes data.

## Information to gather {#survey}

1. **Service and instances:** which app or API, which accounts, instances or workspaces will use the tools (e.g. `acme.atlassian.net`), whether service notes already exist for them (and with which tag and properties) and whether any note with that tag is a template that must be excluded.
2. **Documentation:** link to the official API documentation, or the exact endpoints to use.
3. **Base URL** of the API.
4. **Authentication:** API key, Basic (username or email + token), Bearer/Personal Access Token or OAuth 2.0. See the authentication section before planning OAuth.
5. **Secret:** whether it already exists in `list_secrets` of this vault, which one it is and whether its allowed hosts include the API host. If it does not exist, the suggested name, type and allowed hosts you will propose in `env_criar_secret` for the user to create.
6. **Operations:** the list of actions the user wants (e.g. list files, get a file, create a folder) and **which ones write data**.
7. **Parameters** of each operation: name, type, required or not, allowed values.
8. **Expected result:** is the raw API response enough, or must it be summarized, filtered or paginated (this decides between `request` and `script`).
9. **Names and place of the notes:** tool name prefix (e.g. `gdrive_`), note names and where they fit in the vault structure (MOC, `up:`, tags).
10. **Exposure:** should each tool show up directly in the client's list (`expose: true`) or only through `tools_run` (`expose: false`, useful for large sets).

## Note formats and file naming {#note-formats}

In the examples, `api/request` and `mcp/tool` are the plugin's default tags, and `service/jira` and `template` are only illustrations. Use the tags `list_vault_tools` reports in `requestTag` and `toolTag` (the user may have changed them) and the ones the vault already uses for service notes.

Use these patterns when you create notes, unless the vault already has another pattern for the same app. In that case, follow the vault's.

| Note | File name | Example |
| --- | --- | --- |
| Tool | Same as the value of `tool:` | `jira_get_issue` |
| Request | `<App> - <action>` | `Jira - Get issue` |
| Service | `<App> - <instance>` | `Jira - Acme` |
| App index | `<App>` | `Jira` |

- In service notes, the part after the last separator becomes the value the AI picks in the call: "Jira - Acme" and "Jira - Globex" become `Acme` and `Globex`. Use the same prefix in all of the app's service notes.
- Do not use characters that Windows does not accept in file names: `\ / : * ? " < > |`.
- Show the note names in the plan before creating them.

## Service notes {#service-notes}

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

## Request notes and secret injection {#requests}

````markdown
---
tags: [api/request]
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
- `{{service.<property>}}`: the property's value in the service note **of the instance chosen in the call**, inserted as is. It may contain secret placeholders. Nested properties use dots: `{{service.automation_web_auth.bitbucket}}`. The final value must be text or a number. Never write an instance's URL, ID or secret in the request.
- `{{param:<name>}}`: an argument of the call. In the URL the value is encoded. In a JSON body, text goes **inside quotes** (`"{{param:title}}"`) and numbers, booleans, objects and arrays go **without quotes** (`{{param:limit}}`).
- An optional parameter that was not given and is the whole value of a query pair (`?fields={{param:fields}}`) removes the pair from the URL. Anywhere else, a missing parameter is an error.
- Secret placeholders only work in **headers**, unless the secret allows the URL or the body. The URL host can never come from a secret placeholder.
- Arguments from the AI may never contain secret placeholders: the plugin refuses them. To put a secret inside a body sent by the AI, use `inject_service`.

### Secrets inside a body sent by the AI (`inject_service` - section 4.2.1)

Some APIs store a token inside the JSON you send: for example, an automation rule (Jira/Confluence Automation) whose web request action calls another API with an `Authorization` header. For this:

1. In the service note, declare a map with the values that may be injected:

   ```yaml
   automation_web_auth:
     bitbucket: "{{basic:BITBUCKET_APP}}"
     github: "{{bearer:GITHUB_PAT}}"
   ```

2. In the request body, add the `|inject_service:<map>` modifier to the parameter:

   ```http
   PUT {{service.url}}/gateway/api/automation/.../rule/{{param:rule_id}}
   Authorization: {{service.auth}}
   Content-Type: application/json

   {{param:rule|inject_service:automation_web_auth}}
   ```

3. In the call, the AI writes the marker `{{inject:<key>}}` where the secret goes, e.g. `{ "name": "Authorization", "value": "{{inject:bitbucket}}" }`. The plugin replaces each marker with the key's value in the map before sending.

Rules:

- Only keys declared in the service note's map can be injected: the AI picks the key, never the secret. An unknown key, a malformed marker, a marker in a field name or a marker in a parameter without `inject_service` is an error.
- `inject_service` only works in the body, never in the URL or headers.
- The injected secret goes to the request's host (e.g. the automation API, which stores it in the rule). So it must **allow the body** and have **that host** in its allowed hosts. Otherwise the plugin blocks the call (`placement_not_allowed` or `host_not_allowed`).
- Every secret named in the service note is masked (`***`) in the responses of requests that use that note, even when the request does not send it (e.g. when reading the rule back). So, when updating a rule you read before, replace the `***` with the `{{inject:<key>}}` marker instead of sending `***` back.

## Tool notes and properties {#tools}

```markdown
---
tags: [mcp/tool]
tool: jira_get_issue
kind: request
request: "[[Jira - Get issue]]"
service_tag: service/jira
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

With `service_tag`, the plugin creates the `instance` parameter by itself (its name comes from `service_param`), required, with the list of instances found: the notes tagged `service/jira`, minus those tagged `template`. Do not declare that parameter in `params`. The call becomes `jira_get_issue({ instance: "ACME", key: "ACME-123" })`, and every `{{service.*}}` of the request gets the value from the note "Jira - ACME". A new instance joins the list by itself when its note is created.

| Property | Required | Description |
| --- | --- | --- |
| `tool` | yes | Tool name: lower case letters, digits and `_`, starting with a letter, up to 64 characters. Unique in the vault. Cannot be `list_secrets`, `http_request`, `get_tool_authoring_guide` or `list_vault_tools`. |
| `description` | yes | What the tool does and **when to use it**. This is what the AI reads to pick the tool: be specific. |
| `kind` | yes | `request` or `script`. |
| `request` | for `request` | Link to the request note. |
| `service_tag` | yes, for generic tools | Tag of the service notes (one per instance). The plugin creates the parameter that picks the instance. |
| `service_param` | no | Name of that parameter. Default `instance`. Use a name that makes sense to the user, e.g. `instance`, `account`, `workspace`. |
| `service_exclude_tag` | no | Notes with this tag are left out of the instance list (e.g. templates). |
| `service` | no | Link to **one** fixed service note. Only use it when the service has, and will always have, a single account. Cannot be used together with `service_tag`. |
| `params` | no | Map `name: { type, required, description, enum, default }`. `type`: `string`, `number`, `integer`, `boolean`, `object` or `array`. |
| `writes` | no | `true` if the tool creates, changes or deletes data. Default `false`. |
| `expose` | no | `false` hides it from the client's list; it stays reachable through `tools_run`. Default `true`. |
| `title` | no | Short title. Default: the note name. |
| `enabled` | no | `false` turns the tool off without deleting the note. |

Other vault properties (`tags`, `up`, `aliases`...) can stay in the note as usual.

### Names and descriptions that work

- Prefix by service and use a verb: `gdrive_list_files`, `gdrive_get_file`, `jira_create_issue`. Do not put an instance name in the tool name: the instance is a parameter.
- In `description`, say what the tool returns and when to use it, with example parameter values.
- One tool per action. For large sets, expose only the most used ones and leave the rest with `expose: false`.

## Script tools and ctx API {#scripts}

````markdown
---
tags: [mcp/tool]
tool: jira_issue_digest
kind: script
service_tag: service/jira
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

Requests return `{ status, statusText, ok, headers, json | body | bodyBase64, truncated }`, with any secret already masked as `***`. `bodyBase64` holds an image (`image/*`; SVG comes as text in `body`); if a secret is in its bytes, the body is not returned. Other binary bodies are left out.

Limits: the script runs in an isolated JavaScript interpreter (QuickJS, in WebAssembly). There is no `fetch`, `import`, `require`, `setTimeout`, DOM or network access outside `ctx`; `console.log` works like `ctx.log`. Scripts have a maximum run time (30 s by default, adjustable in the settings; time spent waiting for requests and approvals does not count) and a 64 MB memory limit. An HTTP error does not stop the script: check `ok` and `status`. Configuration errors (note not found, missing parameter, host not allowed) become exceptions with explanatory messages.

## Authentication: what the plugin supports {#authentication}

- **Supported:** fixed values: API key (`{{secret:NAME}}` in a header such as `X-API-Key`), Basic (`{{basic:NAME}}`, user + token), Bearer/PAT (`{{bearer:NAME}}`) and custom headers.
- **Not supported yet: OAuth 2.0 with token refresh.** This is the case for most **Google** APIs (Drive, Gmail, Calendar) and **Microsoft Graph**: the access token expires after about 1 hour and must be renewed with a refresh token, and the plugin only stores fixed values.
  - Tell the user **before** writing the plan and present the alternatives: an API key, if the API accepts one for that use (e.g. public data on Google, with the `X-goog-api-key` header); a ready-made MCP connector for the service, if one exists; or waiting for OAuth support in the plugin.
  - **Never** ask the user to paste an access token into a note, and never propose storing tokens outside the plugin.
- If the secret does not allow the API host, the plugin blocks the call (`host_not_allowed`). The user adjusts the allowed hosts in the plugin's panel.

## Implementation Plan template {#plan}

Present the plan to the user with exactly these sections and wait for approval:

```markdown
# Implementation plan: <name of the tool set>

## 1. Goal
What the user will be able to ask the AI after this implementation.

## 2. Confirmed information
Vault and MCP server used. Service, instances, base URL, documentation used and the user's answers.

## 3. Authentication
Secret used (name and type), whether it exists or the user must create it, and the allowed hosts needed.
User action needed: <e.g. create the secret GDRIVE_KEY of type token for the host www.googleapis.com (in the screen `env_criar_secret` opens)>.

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

## 9. After approval and validation {#after-approval}

1. Create the service notes (if needed), then the request notes and last the tool notes, following the vault's conventions.
2. Call `list_vault_tools` and fix until no new tool has `problems`. Read the `warnings` too. To discover and search vault tools, use `tools_find` when available; otherwise, `list_vault_tools` is available as a client tool.
3. `kind: script` tools are only `ready` with scripts turned on in the settings; if they show `scripts-disabled`, tell the user. There is no tool approval in the plugin: the AI client asks the user for permission when the tool is called.
4. Test the read-only tools by name (or through `tools_run` if not exposed). Do not run `writes: true` tools without permission, nor tools that use any-host secrets without the permission of rule 8.
5. Finish with a summary: tools created, notes created, tests done and what the user still has to do.

If you do not have access to the vault's MCP server, only to the files, you can still create the notes in the vault's files (ask the user which folder it is). In that case ask the user to check the status in Obsidian → Environment Keys panel → Vault tools.
