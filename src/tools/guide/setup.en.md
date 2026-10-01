# Set up the MCP environment of the Environment Keys plugin

You are going to set up the MCP environment of the Obsidian plugin **Environment Keys** on this user's computer. The goal is to leave everything ready for them to use the plugin's features: the AI client connected to the vault's server, the environment variables (secrets) needed, the service, request and tool notes of an app or service (downloaded from the catalog or created by you), the MCP groups in the panel, the MCP tools validated and the plugin's rules recorded in the vault's `CLAUDE.md` (with the user's permission).

The same prompt works from scratch or to complete an environment that already exists (e.g. just adding one or several tools to an app that is already set up). In that case, confirm the steps that are already done, without redoing them, and reuse the service notes, variables and requests the vault already has, copying the pattern of the tools of the same app (name prefix, `service_tag`, `service_param`, tags and `up:`).

## Environment steps

Follow this order. Steps marked **user** are done by the user in Obsidian: explain where to click and wait for them to confirm.

1. **Plugin installed and on (user).** Obsidian → Settings → Community plugins → Environment Keys on. The secret vault must be created and unlocked (Environment Keys panel, key icon in the sidebar).
2. **AI client connected (user).** In the plugin's panel → AI clients → **Connect** on their client (Claude Code, Codex, Cursor...). This turns on the local server and registers the MCP server in the client, with no token to copy. Then the client must be reloaded. If the client is not listed, use "Other client (manual setup)".
3. **Right server.** Find the plugin's MCP server among your tools (rule 2 of the guide). If there is more than one, ask which vault it is. Call `list_secrets` and, if it exists, `list_vault_tools`.
4. **Vault tools on (user).** If `list_vault_tools` does not exist, or reports `enabled: false`, ask the user to turn them on in Settings → Environment Keys → Vault tools. Script tools are only needed if the plan uses `kind: script` (catalog packages may have some: check their `kind` in `list_vault_tools` after downloading).
5. **Vault conventions.** Read the instruction files (`CLAUDE.md`, `AGENTS.md`), the index notes (MOCs), the tag taxonomy and properties such as `up:`, and follow those conventions in the notes you create.
6. **Mandatory question.** Ask the question at the end of this prompt and wait for the answer.
7. **Catalog of ready-made MCPs (user).** Before planning notes by hand, ask the user to open the plugin's panel → MCP groups → **Download MCP** and tell you whether the app is in the catalog and which tools the package has ("Show tools" button). If it is:
   - the user downloads the whole package (**Download all**) or only the tools asked for (**Download** on each one). The plugin copies the tool notes and every request they depend on, creates the packages' index note and the MCP group in the panel, and groups packages of the same app on its own (e.g. Atlassian). Notes that already exist are not overwritten;
   - if the vault has no instance of the package's service yet, the plugin creates an **instance template** in an "Instances" folder. That template is the service note: from it, build one service note per instance, with the URL and the placeholder of the variable the user will add. Do not edit the downloaded tool and request notes; to change one, propose it in the plan;
   - call `list_vault_tools` to check what was installed. The plan then covers only what is missing: service notes, environment variables and tools the package does not have.

   If the app is not in the catalog, or the user prefers not to use it, go on creating the notes by hand.
8. **Implementation Plan** with the template in section 8 of the guide, including: what came from the catalog (package and downloaded tools), each environment variable the user will add (name, type and allowed hosts), the service notes (one per instance), the request notes, the tool notes, where they go in the vault (index note, `up:`, tags) the MCP group of step 11 and a summary of what will go in `CLAUDE.md` (step 12, which has its own permission). For a single tool the plan's sections can be short, but all of them are there. Wait for explicit approval.
9. **Environment variables (user).** After approval, the user adds each variable in the plugin's panel (key icon → New variable), with the name, type and allowed hosts from the plan. Types: token, username + token (Basic), Bearer token, custom header value or environment variable. You never see, ask for or write the value: check only with `list_secrets`.
   - Always plan the exact hosts of the API. Do not suggest **Allow any host** or **Full access**: with Full access the value goes to any HTTPS address and the plugin never asks for approval for it again.
   - If `list_secrets` shows a variable with `allowAnyHost: true` or `fullAccess: true`, apply rule 8 of the guide to it and suggest the user switch it to the exact host.
10. **Notes and validation:** follow section 9 of the guide.
11. **MCP group (user).** Downloaded packages already show in MCP groups. For tools created by hand, ask the user to create the group in the panel → MCP groups → **Add MCP**: name, a tag (tool notes with that tag and its subtags count as members, e.g. one subtag per app under the tool tag) or the notes' links, and, if they want, the app the MCP shows under (created with **Add app**, e.g. "Atlassian" for Jira and Confluence). So, in the plan, give the tool notes of an app their own tag. Check with the user that the group shows the right number of tools and requests.
12. **The plugin's rules in the vault's `CLAUDE.md` (only with permission).** So that later conversations follow the plugin's rules without this prompt, propose an "Environment Keys plugin" section for the vault's instruction file: the `CLAUDE.md` at the root of the vault, or the `AGENTS.md` if the vault only uses that one. If neither exists, propose creating `CLAUDE.md` at the root of the vault. The section must say:
    - which MCP server of the plugin belongs to this vault (the name you found in step 3) and that the plugin's other servers must not be used here;
    - that secrets only go in through placeholders (`{{secret:NAME}}`, `{{basic:NAME}}`, `{{bearer:NAME}}`), that the value is never asked for, read or written, that keys and allowed hosts are checked with `list_secrets` and that, with the secret vault locked, the user unlocks it in the Environment Keys panel;
    - that, before using `http_request`, the agent looks for a vault tool for the endpoint (`list_vault_tools`) and runs it by name or through `run_vault_tool`;
    - that tools that write data (`writes: true`) only run with the user's permission for that run, and that variables with `allowAnyHost: true` or `fullAccess: true` require showing the variable's name and the destination URL and waiting for permission before each run;
    - that, to create or change tools, the agent calls `get_tool_authoring_guide` and follows its workflow (survey, questions, Implementation Plan and approval);
    - the tool, request and service tags used in the vault, where the notes go (index note, `up:`) and that nothing inside `.obsidian/` is edited.

    Write the section in the file's language and style. If it already has a section about the plugin, propose updating it, without duplicating it, and do not touch the rest of the file.

    **Ask for permission before creating or changing the file.** Show the user the file's path and the full text that will go in (or the old and the new passage, for an update) and ask, explicitly, whether you may write it. Only write it after a clear "yes" for this change: approval of the Implementation Plan, or of any other step, does not count as permission to touch `CLAUDE.md`. If the user asks for changes, show the text again and ask for permission again. If they refuse, write nothing and give them the text to paste if they want.

%GUIDE%
%REQUEST%
## Mandatory question before creating anything

After surveying the current state (steps 1 to 5, read-only), ask the user exactly these three questions:

1. **Which environment variables (secrets) will these tools use?** You create the variables yourself, by hand, in the plugin's panel (key icon → New variable), after the plan is approved; I never see or write the values. Tell me the name and type of each variable you will create (e.g. an API token, a username + token, a Bearer token) or which of the existing ones will be reused (show the ones `list_secrets` listed for that app).
2. **Which app or service are they for?** For example: Jira, GitHub, Google Drive, an internal API. If there is more than one account or instance, which ones.
3. **Which tools do you want?** The list of actions the AI will be able to do (e.g. "get an issue by key"), marking which ones write data, or "the whole catalog package".

If the user's request already has this information, confirm it with them. If the answer does not have all three, or is incomplete, **ask again, explicitly, for what is missing, and do not go on with the creation**: do not write the plan, do not create or change any note and do not ask for any package to be downloaded or any variable to be added until you have all three answers.
