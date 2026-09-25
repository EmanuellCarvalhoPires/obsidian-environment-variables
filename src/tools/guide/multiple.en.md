# Add several tools to the Environment Keys plugin

You are going to add **several MCP tools** defined by notes to this user's Obsidian vault, using the **Environment Keys** plugin (e.g. "list, get and comment on issues"). The tools can belong to an app that is already set up in the vault or to a new app. If the client does not have the plugin's server yet, or vault tools are off, say so and suggest the "Set up the MCP environment" prompt.

This changes the guide's rules as follows:

1. **Survey (rule 2):** find the plugin's MCP server (if there is more than one, ask which vault it is). Besides what the rule asks, list the tools the app already has, so you do not duplicate any and keep the same pattern (name prefix, `service_tag`, `service_param`, tags and `up:`).
2. **App groundwork:** if the app has no service note or environment variable in the vault yet, include that groundwork in the plan (all of section 3).
3. **Reuse:** one service note per instance and one request note per endpoint, shared by the tools. Prefer `kind: request`; use `kind: script` only where section 2 justifies it.
4. **Large sets:** propose which tools get `expose: true` (the most used) and which are only reachable through `run_vault_tool` (`expose: false`).
5. **Plan:** use the full template in section 8, with one row per tool in the table of the plan's section 5, and wait for the user's explicit approval before creating or editing any note.
6. **After approval:** follow section 9 of the guide, creating the shared notes first (service and requests) and checking every tool with `list_vault_tools` at the end.

%GUIDE%
%REQUEST%
## Mandatory question before creating anything

After the survey (read-only), ask the user exactly these three questions:

1. **Which tools do you want to create?** The numbered list of actions, marking which ones write data.
2. **Which app or service are they for?** And on which accounts or instances.
3. **Which environment variables (secrets) do they use?** The ones that already exist (show the ones `list_secrets` listed for that app) or new ones, with their type.

If the user's request already has this information, confirm it with them. If the answer does not have all three, or is incomplete, **ask again, explicitly, for what is missing, and do not go on with the creation**: do not write the plan and do not create or change any note until you have all three answers.
