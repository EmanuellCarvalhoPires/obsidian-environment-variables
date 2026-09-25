# Add one tool to the Environment Keys plugin

You are going to add **a single MCP tool** defined by a note to this user's Obsidian vault, using the **Environment Keys** plugin (e.g. "get an issue by key"). If the request has more than one action, stop and suggest the "Add several tools" prompt. If the environment is not set up yet (client without the plugin's server, vault tools off, app without a service note or environment variable), say so and suggest the "Set up the MCP environment" prompt.

This request has a smaller scope. It changes the guide's rules as follows:

1. **Short survey (rule 2):** find the plugin's MCP server (if there is more than one, ask which vault it is), call `list_vault_tools` and `list_secrets`, and look only for the service, request and tool notes of the same app. Reuse the service note, the environment variable and the requests that already exist, and copy the pattern of the app's existing tools (name prefix, `service_tag`, `service_param`, tags and `up:`).
2. **Ask only what is missing**, after the mandatory question at the end: the endpoint (or the documentation link), the parameters, whether it writes data and the tool name.
3. **Short plan instead of the template in section 8.** Present this plan and wait for the user's explicit approval before creating or editing any note:

```markdown
# Plan: <tool name>

- **What it does:** <what the user will be able to ask the AI>
- **Tool:** `<tool>` · kind `<request|script>` · writes `<true|false>` · expose `<true|false>`
- **Instances:** service_tag `<tag>` / service_param `<name>` (existing service notes: <list>)
- **Parameters:** <name: type, required, description>
- **Request:** <reused or new note> · `<METHOD URL with {{service.*}} and {{param:*}}>`
- **Environment variable:** `<NAME>` (<exists / the user must add it>; <allowed host or any host>)
- **Notes to create or change:** <list, with tags and links>
- **Test:** <read call and expected result, or "will not be run: writes data">
```

4. **After approval:** follow section 9 of the guide for this tool.

%GUIDE%
%REQUEST%
## Mandatory question before creating anything

After the survey (read-only), ask the user exactly these three questions:

1. **Which tool do you want to create?** The exact action the AI will be able to do (e.g. "get an issue by key").
2. **Which app or service is it for?** And on which accounts or instances.
3. **Which environment variables (secrets) does it use?** One that already exists (show the ones `list_secrets` listed for that app) or a new one, with its type.

If the user's request already has this information, confirm it with them. If the answer does not have all three, or is incomplete, **ask again, explicitly, for what is missing, and do not go on with the creation**: do not write the plan and do not create or change any note until you have all three answers.
