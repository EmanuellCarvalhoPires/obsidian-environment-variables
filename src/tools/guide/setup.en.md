# Set up the MCP environment of the Environment Keys plugin

You are going to set up, from scratch, the MCP environment of the Obsidian plugin **Environment Keys** on this user's computer. The goal is to leave everything ready for them to use the plugin's features: the AI client connected to the vault's server, the environment variables (secrets) needed, the service, request and tool notes of an app or service, and the MCP tools validated.

## Environment steps

Follow this order. Steps marked **user** are done by the user in Obsidian: explain where to click and wait for them to confirm.

1. **Plugin installed and on (user).** Obsidian → Settings → Community plugins → Environment Keys on. The secret vault must be created and unlocked (Environment Keys panel, key icon in the sidebar).
2. **AI client connected (user).** In the plugin's panel → AI clients → **Connect** on their client (Claude Code, Codex, Cursor...). This turns on the local server and registers the MCP server in the client, with no token to copy. Then the client must be reloaded. If the client is not listed, use "Other client (manual setup)".
3. **Right server.** Find the plugin's MCP server among your tools (rule 2 of the guide). If there is more than one, ask which vault it is. Call `list_secrets` and, if it exists, `list_vault_tools`.
4. **Vault tools on (user).** If `list_vault_tools` does not exist, or reports `enabled: false`, ask the user to turn them on in Settings → Environment Keys → Vault tools. Script tools are only needed if the plan uses `kind: script`.
5. **Vault conventions.** Read the instruction files (`CLAUDE.md`, `AGENTS.md`), the index notes (MOCs), the tag taxonomy and properties such as `up:`, and follow those conventions in the notes you create.
6. **Mandatory question.** Ask the question at the end of this prompt and wait for the answer.
7. **Implementation Plan** with the template in section 8 of the guide, including: each environment variable the user will add (name, type and allowed hosts), the service notes (one per instance), the request notes, the tool notes and where they go in the vault (index note, `up:`, tags). Wait for explicit approval.
8. **Environment variables (user).** After approval, the user adds each variable in the plugin's panel (key icon → New variable), with the name, type and allowed hosts from the plan. Types: token, username + token (Basic), Bearer token, custom header value or environment variable. You never see, ask for or write the value: check only with `list_secrets`.
9. **Notes and validation:** follow section 9 of the guide.

%GUIDE%
%REQUEST%
## Mandatory question before creating anything

After surveying the current state (steps 1 to 5, read-only), ask the user exactly these two questions:

1. **Which environment variables (secrets) must be set up?** For example: an API token, a username + token, a Bearer token.
2. **Which app or service are they for?** For example: Jira, GitHub, Google Drive, an internal API. If there is more than one account or instance, which ones.

If the user's request already has this information, confirm it with them. If the answer does not have both, or is incomplete, **ask again, explicitly, for what is missing, and do not go on with the creation**: do not write the plan, do not create or change any note and do not ask for any variable to be added until you have both answers.
