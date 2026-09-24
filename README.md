# Environment Variables

**Hide your API tokens and other sensitive data from AI agents** such as Claude Code, Codex, Antigravity and Cursor.

Store API tokens and environment variables encrypted inside your vault, reference them in notes by key, and let AI agents use them in HTTP requests **without ever seeing the values**.

Your notes contain only a key such as `{{basic:JIRA_ACME}}`. When an AI agent (Claude Code, Claude Desktop, Cursor, or any MCP client) needs to call an API, it sends the request to this plugin with the key. The plugin replaces the key with the real value right before sending, checks that the destination is allowed, masks the value in the response, and returns the result.

> Desktop only, Obsidian 1.13 or later. The plugin runs a local server, which needs Node.js APIs that are not available on mobile.

## Installation

- **Community plugins:** in Obsidian, open **Settings → Community plugins → Browse**, search for **Environment Variables**, install and enable it.
- **Manual:** download `main.js`, `manifest.json` and `styles.css` from the [latest release](../../releases/latest) into `<vault>/.obsidian/plugins/environment-variables/`, then enable the plugin in **Settings → Community plugins**.

## How it works

1. Click the key icon in the left ribbon to open the **Environment Variables** panel.
2. Create a master password. Your variables are encrypted with it.
3. Add a variable: a name (`JIRA_ACME`), a type, the value and the **allowed hosts** (`acme.atlassian.net`).
4. In your notes, write `{{basic:JIRA_ACME}}` instead of the token. Type `{{secret:` to autocomplete names, in the note text or in a property value, even while the vault is locked. Keys are shown as a lock chip in reading view and in the Properties panel; click a chip in Properties to edit it. A chip turns red when the name does not exist in the unlocked vault.
5. In **AI clients**, click **Connect** next to your AI tool. The plugin turns on the local server and registers itself in the tool. There is nothing to copy or paste.

Already have tokens in your notes? Select one and run **Convert selection into a variable**. When you paste something that looks like a token (Atlassian, GitHub, GitLab, OpenAI, Anthropic, AWS, Google, Slack, Stripe or a JWT) into a note, the plugin offers to store it encrypted and put a key in its place. You can turn this warning off in the settings.

### Key syntax

| Key | Becomes |
|---|---|
| `{{secret:NAME}}` | The raw value |
| `{{secret:NAME.user}}` | The username of a username + token variable |
| `{{basic:NAME}}` | `Basic base64(username:token)` |
| `{{bearer:NAME}}` | `Bearer <token>` |

## Connecting an AI client

### One click: Claude Code, Codex, Antigravity and Cursor

Open the panel, expand **AI clients** and click **Connect**. The plugin:

1. turns on the local server;
2. creates a client token (it is never shown);
3. registers the server in the tool:
   - **Claude Code:** runs `claude mcp add --transport http --scope user environment-variables ...`, so it is available in every project;
   - **Codex** (CLI, IDE extension and app): adds a clearly marked `[mcp_servers.environment-variables]` block to `~/.codex/config.toml` (or `$CODEX_HOME/config.toml`). The rest of the file is left untouched;
   - **Antigravity** (IDE, CLI and 2.0): adds an `environment-variables` entry (`serverUrl` + `headers`) to `~/.gemini/config/mcp_config.json`, keeping your other servers;
   - **Cursor:** adds an `environment-variables` entry to `~/.cursor/mcp.json`, keeping your other servers.

Start a new session in the tool to load it. **Disconnect** revokes the token and removes the entry. If you change the port, connected tools are updated automatically.

### Other MCP clients

Use **Other client (manual setup)** to get a token and a ready-made command.

Add an HTTP MCP server at `http://127.0.0.1:<port>/mcp` with the header `Authorization: Bearer <client token>`. Tools:

- `list_secrets`: names, types, descriptions and allowed hosts. Never values.
- `http_request`: `{ method, url, headers, body }` with keys in header values.

### Scripts (REST)

```bash
curl -s http://127.0.0.1:27150/v1/request \
  -H "Authorization: Bearer <client token>" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://acme.atlassian.net/rest/api/3/myself","headers":{"Authorization":"{{basic:JIRA_ACME}}"}}'
```

## Security

- **Encryption:** AES-256-GCM with a key derived from your master password (PBKDF2-SHA256, 600,000 iterations), using the Web Crypto API. The master password is never stored. The decrypted variables only exist in memory while the vault is unlocked.
- **File format v2:** the header (KDF name, parameters, salt, IV) is bound to the ciphertext as associated data, so any edit is detected. KDFs are pluggable, ready for a memory-hard KDF such as Argon2id. Files in the older format v1 still open and are upgraded on unlock.
- **Locking** drops the key, blanks every in-memory record and releases them. Decryption buffers are zeroed. JavaScript strings cannot be overwritten in place, so copies may remain in memory until garbage collection.
- **Locking:** the vault stays unlocked until you click **Lock now** or close Obsidian. Optional auto-lock after an idle time (off by default).
- **Allowed hosts:** each variable is sent only to the hosts you list. A request to any other host is refused before the value is inserted, so an AI agent tricked by a malicious page or ticket cannot send your token elsewhere.
  - **Path prefixes:** a host can be narrowed to a path, e.g. `api.example.com/v1/workspaces/123/*`. Paths with encoded slashes or backslashes are refused so a server cannot decode them into another path.
  - **Shared platforms:** a wildcard such as `*.atlassian.net` or `*.s3.amazonaws.com` also matches other customers' tenants. The plugin asks for confirmation and shows a warning; prefer the exact host. Wildcards on public suffixes (`*.com`, `*.com.br`) are refused.
  - **Any host:** if you really need a variable to work with any address, turn on **Allow any host** for it (off by default, and an empty host list still allows nothing). Every request with that variable then waits for your approval, including GET, and redirects to another host are not followed. Check the address in the approval dialog every time.
- **Per-client access (least privilege):** each AI client may use only the variables you choose when you connect it (or "all variables", which includes future ones). Other variables are refused and hidden from `list_secrets`.
- **Headers only by default:** keys in the URL or body are refused unless you allow it per variable. This prevents a value from being saved by the API, for example inside a comment.
- **HTTPS only**, except `http://localhost` when explicitly allowed.
- **Redirects** are followed manually and revalidated: a redirect is followed only if the new destination (scheme, host, port and path prefix) is allowed for every variable in the request. A variable in the URL, or in a body that a 307/308 would re-send, never follows a redirect to another origin. Otherwise the 3xx response is returned as is.
- **Masking:** values are replaced by `***` in response headers and bodies, error messages and the usage log, including their base64, base64url, URL-encoded (upper and lower case), form-encoded, hexadecimal, JSON-escaped and Basic auth forms. Fragments of 12 or more characters from long values are masked too, which covers APIs that echo a truncated token in an error.
- **Log and approval dialog** show the URL as the client wrote it (with keys), never with values.
- **Approval:** by default, requests that change data (POST, PUT, PATCH, DELETE) wait for your approval in Obsidian.
- **Local server:** listens only on `127.0.0.1`, requires a client token, rejects requests from web browsers (Origin header) and foreign Host headers (DNS rebinding). The server is off until you turn it on.
- **Usage log:** every use is logged with time, client, key names, method, URL without query string and status. Values are never logged.

### Limits

- Malware running as your user while the vault is **unlocked** could read Obsidian's memory.
- All Obsidian plugins run in the same process. A malicious plugin installed in the same vault could access this plugin while it is unlocked.
- An allowed host can still be misused (for example, an agent deleting issues). Use tokens with minimal permissions and keep approvals on.
- **There is no password recovery.** If you forget the master password, the variables are lost.

## Disclosures

- **Network use:** the plugin runs a local HTTP server on `127.0.0.1` (port 27150 by default) when you turn it on, and sends HTTP requests only to the hosts you configure for each variable, when an authorized client asks it to. It does not contact any other service.
- **Files:** the encrypted variables are stored in `<vault>/.obsidian/plugins/environment-variables/vault.enc`. Settings, client token hashes and the usage log are stored in the plugin's `data.json`, which contains no values. By default it also keeps the **names and types** of your variables (never the values), so you can insert references while the vault is locked; turn off **Show variable names while locked** to keep names inside the encrypted file only.
- **Outside the vault, only when you click Connect or Disconnect for an AI tool:**
  - **Claude Code:** the plugin looks for the `claude` program in its usual install locations and runs `claude mcp add` / `claude mcp remove`. Claude Code then updates its own configuration.
  - **Codex:** the plugin reads and updates `~/.codex/config.toml`. It only adds or removes its own block, between `# >>> environment-variables` and `# <<< environment-variables` markers, and refuses to write if you already added that server by hand.
  - **Antigravity:** the plugin reads and updates `~/.gemini/config/mcp_config.json`.
  - **Cursor:** the plugin reads and updates `~/.cursor/mcp.json`.
  - For the JSON files, the plugin refuses to write if the file is not valid JSON, and it only touches the `environment-variables` entry.
- **Clipboard:** the plugin writes to the clipboard only when you click a **Copy** button (a key such as `{{secret:NAME}}`, or the client token in manual setup). When you paste into a note, it checks the pasted text for token formats, on your device only. It never copies a secret value.
- No telemetry, no ads, no account required. Free and open source.

## Development

```bash
npm install
npm test          # unit and integration tests
npm run build     # type-check and bundle main.js
npm run deploy    # build and copy to the vault in .deploy-target
```

## License

MIT
