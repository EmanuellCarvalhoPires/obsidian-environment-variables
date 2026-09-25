// One-click connection of AI clients to the local MCP server.
// Runs only when the user clicks "Connect". The client token goes straight
// from the plugin into the client's configuration and is never shown.
//
// Each vault registers its server under its own name (see server/vaultIdentity.ts), so two vaults
// open at the same time never overwrite each other's registration.

import { execFile } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/** Name used by vaults connected before 1.3.0. New vaults use a name of their own. */
export const MCP_SERVER_NAME = "environment-variables";

export type IntegrationId = "claude-code" | "codex" | "antigravity" | "cursor";

export interface Integration {
  id: IntegrationId;
  label: string;
  /** True when the client seems to be installed on this computer. */
  detect(): Promise<boolean>;
  /** Registers the server under `name`, the MCP server name of this vault. */
  connect(url: string, token: string, name: string): Promise<void>;
  disconnect(name: string): Promise<void>;
  /**
   * The bearer token registered under `name`, or null when there is none or it cannot be read.
   * Read-only. Lets a vault check that a registration is its own before reusing the name.
   */
  registeredToken(name: string): Promise<string | null>;
}

// ---------- helpers ----------

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function run(file: string, args: string[], timeoutMs = 30_000): Promise<RunResult> {
  // .cmd/.bat files need a shell on Windows.
  const needsShell = process.platform === "win32" && /\.(cmd|bat)$/i.test(file);
  const quote = (a: string) => `"${a.replace(/"/g, '""')}"`;
  // With a shell, pass one pre-quoted command line (Node does not escape shell arguments).
  const finalFile = needsShell ? [file, ...args].map(quote).join(" ") : file;
  const finalArgs = needsShell ? [] : args;
  return new Promise((resolve) => {
    execFile(finalFile, finalArgs, { timeout: timeoutMs, windowsHide: true, shell: needsShell }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as NodeJS.ErrnoException & { code?: unknown }).code === "number" ? Number(err.code) : 1) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr || (err ? err.message : "")) });
    });
  });
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function scrub(text: string, token: string): string {
  return text.split(token).join("***").trim();
}

/** "Bearer evc_..." → "evc_...". */
export function bearerOf(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const m = /^Bearer\s+(\S+)$/i.exec(value.trim());
  return m ? m[1] : null;
}

/** Token of the `mcpServers[name]` entry of a JSON config file, or null. */
function tokenInJson(file: string, name: string): string | null {
  try {
    const servers = (readJsonObject(file).mcpServers ?? {}) as Record<string, { headers?: Record<string, unknown> } | undefined>;
    return bearerOf(servers[name]?.headers?.Authorization);
  } catch {
    return null;
  }
}

// ---------- Claude Code (CLI) ----------

let cachedClaude: string | null | undefined;

/** Finds the claude CLI. GUI apps often lack the terminal PATH, so known locations come first. */
export async function findClaude(): Promise<string | null> {
  if (cachedClaude !== undefined && (cachedClaude === null || isFile(cachedClaude))) return cachedClaude;
  const home = os.homedir();
  const candidates =
    process.platform === "win32"
      ? [
          path.join(home, ".local", "bin", "claude.exe"),
          path.join(process.env.APPDATA ?? path.join(home, "AppData", "Roaming"), "npm", "claude.cmd"),
          path.join(home, ".claude", "local", "claude.exe"),
        ]
      : [
          path.join(home, ".local", "bin", "claude"),
          path.join(home, ".claude", "local", "claude"),
          "/opt/homebrew/bin/claude",
          "/usr/local/bin/claude",
          path.join(home, ".npm-global", "bin", "claude"),
          "/usr/bin/claude",
        ];
  for (const c of candidates) {
    if (isFile(c)) return (cachedClaude = c);
  }
  // Fall back to the system search path (a login shell on macOS/Linux loads the user's PATH).
  const lookup =
    process.platform === "win32"
      ? await run("where", ["claude"], 10_000)
      : await run(process.env.SHELL || "/bin/sh", ["-lc", "command -v claude"], 10_000);
  const found = lookup.code === 0 ? lookup.stdout.split(/\r?\n/).map((l) => l.trim()).find((l) => l && isFile(l)) : undefined;
  return (cachedClaude = found ?? null);
}

/** Registers the MCP server in Claude Code at user scope (all projects). Exported for tests. */
export async function registerWithClaude(claude: string, url: string, token: string, name = MCP_SERVER_NAME): Promise<void> {
  // Replace any previous registration so the new token takes effect.
  await run(claude, ["mcp", "remove", name, "--scope", "user"]);
  const res = await run(claude, ["mcp", "add", "--transport", "http", "--scope", "user", name, url, "--header", `Authorization: Bearer ${token}`]);
  if (res.code !== 0) throw new Error(scrub(res.stderr || res.stdout, token) || "claude mcp add failed.");
}

/** Claude Code keeps user-scope servers in ~/.claude.json (or $CLAUDE_CONFIG_DIR/.claude.json). */
export function claudeConfigFile(): string {
  const dir = process.env.CLAUDE_CONFIG_DIR;
  return dir ? path.join(dir, ".claude.json") : path.join(os.homedir(), ".claude.json");
}

const claudeCode: Integration = {
  id: "claude-code",
  label: "Claude Code",
  async detect() {
    return (await findClaude()) !== null;
  },
  async connect(url, token, name) {
    const claude = await findClaude();
    if (!claude) throw new Error("Claude Code (claude) was not found on this computer.");
    await registerWithClaude(claude, url, token, name);
  },
  async disconnect(name) {
    const claude = await findClaude();
    if (claude) await run(claude, ["mcp", "remove", name, "--scope", "user"]);
  },
  async registeredToken(name) {
    return tokenInJson(claudeConfigFile(), name);
  },
};

// ---------- Codex (config.toml) ----------

export const codexBlockStart = (name: string) => `# >>> ${name} (managed by the Environment Keys Obsidian plugin) >>>`;
export const codexBlockEnd = (name: string) => `# <<< ${name} <<<`;
export const CODEX_BLOCK_START = codexBlockStart(MCP_SERVER_NAME);
export const CODEX_BLOCK_END = codexBlockEnd(MCP_SERVER_NAME);
/** Start marker written before the plugin was renamed to Environment Keys. Still recognized so old blocks are replaced, not duplicated. */
const legacyCodexBlockStart = (name: string) => `# >>> ${name} (managed by the Environment Variables Obsidian plugin) >>>`;

/** Position of our managed block's start marker for `name` (current or legacy), or -1. */
function codexBlockStartAt(text: string, name: string): number {
  const start = text.indexOf(codexBlockStart(name));
  return start >= 0 ? start : text.indexOf(legacyCodexBlockStart(name));
}

/** Server names only contain [a-z0-9_-], so they are safe inside a regular expression. */
function unmanagedCodexEntry(name: string): RegExp {
  return new RegExp(String.raw`^\s*\[\s*mcp_servers\s*\.\s*["']?${name}["']?\s*\]`, "m");
}

function codexHome(): string {
  return process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
}

/** A JSON string is a valid TOML basic string for URLs and tokens. */
function tomlString(value: string): string {
  return JSON.stringify(value);
}

/** Removes our managed block for `name`. Returns the text unchanged when there is none. */
export function removeCodexBlock(text: string, name = MCP_SERVER_NAME): string {
  const endMarker = codexBlockEnd(name);
  const start = codexBlockStartAt(text, name);
  if (start < 0) return text;
  const endAt = text.indexOf(endMarker, start);
  if (endAt < 0) throw new Error("config.toml has an incomplete Environment Keys block. Fix or remove it by hand.");
  let end = endAt + endMarker.length;
  if (text[end] === "\r") end++;
  if (text[end] === "\n") end++;
  const before = text.slice(0, start).replace(/(\r?\n){2,}$/, "\n");
  return before + text.slice(end);
}

/** Adds (or replaces) our managed block at the end of config.toml, leaving everything else as it was. */
export function upsertCodexBlock(text: string, url: string, token: string, name = MCP_SERVER_NAME): string {
  const base = removeCodexBlock(text, name);
  if (unmanagedCodexEntry(name).test(base)) {
    throw new Error(`config.toml already has an [mcp_servers.${name}] entry that was not added by this plugin. Remove it and connect again.`);
  }
  const block = [
    codexBlockStart(name),
    `[mcp_servers.${name}]`,
    `url = ${tomlString(url)}`,
    `http_headers = { "Authorization" = ${tomlString(`Bearer ${token}`)} }`,
    codexBlockEnd(name),
    "",
  ].join("\n");
  const trimmed = base.replace(/\s+$/, "");
  return trimmed ? `${trimmed}\n\n${block}` : block;
}

/** The token inside our managed block for `name`, or null. */
export function codexBlockToken(text: string, name = MCP_SERVER_NAME): string | null {
  const start = codexBlockStartAt(text, name);
  if (start < 0) return null;
  const end = text.indexOf(codexBlockEnd(name), start);
  const block = text.slice(start, end < 0 ? undefined : end);
  const m = /"Authorization"\s*=\s*"Bearer\s+([^"\s]+)"/.exec(block);
  return m ? m[1] : null;
}

const codex: Integration = {
  id: "codex",
  label: "Codex",
  async detect() {
    return isDir(codexHome());
  },
  async connect(url, token, name) {
    const file = path.join(codexHome(), "config.toml");
    const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    fs.mkdirSync(codexHome(), { recursive: true });
    fs.writeFileSync(file, upsertCodexBlock(current, url, token, name), "utf8");
  },
  async disconnect(name) {
    const file = path.join(codexHome(), "config.toml");
    if (!fs.existsSync(file)) return;
    const current = fs.readFileSync(file, "utf8");
    const next = removeCodexBlock(current, name);
    if (next !== current) fs.writeFileSync(file, next, "utf8");
  },
  async registeredToken(name) {
    const file = path.join(codexHome(), "config.toml");
    try {
      return fs.existsSync(file) ? codexBlockToken(fs.readFileSync(file, "utf8"), name) : null;
    } catch {
      return null;
    }
  },
};

// ---------- JSON config files (Antigravity, Cursor) ----------

function readJsonObject(file: string): Record<string, unknown> {
  if (!fs.existsSync(file)) return {};
  const text = fs.readFileSync(file, "utf8").trim();
  if (!text) return {};
  const parsed: unknown = JSON.parse(text); // throws on invalid JSON: never overwrite a file we cannot read
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error(`${file} is not a JSON object.`);
  return parsed as Record<string, unknown>;
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n", "utf8");
}

/** A client configured through an `mcpServers` object in a JSON file. Only our entry is touched. */
function jsonFileIntegration(opts: {
  id: IntegrationId;
  label: string;
  detectDirs: () => string[];
  file: () => string;
  entry: (url: string, token: string) => Record<string, unknown>;
}): Integration {
  return {
    id: opts.id,
    label: opts.label,
    async detect() {
      return opts.detectDirs().some(isDir);
    },
    async connect(url, token, name) {
      const file = opts.file();
      const config = readJsonObject(file);
      const servers = (config.mcpServers ?? {}) as Record<string, unknown>;
      servers[name] = opts.entry(url, token);
      config.mcpServers = servers;
      writeJson(file, config);
    },
    async disconnect(name) {
      const file = opts.file();
      if (!fs.existsSync(file)) return;
      const config = readJsonObject(file);
      const servers = config.mcpServers as Record<string, unknown> | undefined;
      if (!servers || !(name in servers)) return;
      delete servers[name];
      writeJson(file, config);
    },
    async registeredToken(name) {
      return tokenInJson(opts.file(), name);
    },
  };
}

// Antigravity (IDE, CLI and 2.0) share ~/.gemini/config/mcp_config.json and require "serverUrl".
const antigravity = jsonFileIntegration({
  id: "antigravity",
  label: "Antigravity",
  detectDirs: () => ["config", "antigravity", "antigravity-ide", "antigravity-cli"].map((d) => path.join(os.homedir(), ".gemini", d)),
  file: () => path.join(os.homedir(), ".gemini", "config", "mcp_config.json"),
  entry: (url, token) => ({ serverUrl: url, headers: { Authorization: `Bearer ${token}` } }),
});

const cursor = jsonFileIntegration({
  id: "cursor",
  label: "Cursor",
  detectDirs: () => [path.join(os.homedir(), ".cursor")],
  file: () => path.join(os.homedir(), ".cursor", "mcp.json"),
  entry: (url, token) => ({ url, headers: { Authorization: `Bearer ${token}` } }),
});

export const INTEGRATIONS: Integration[] = [claudeCode, codex, antigravity, cursor];

export function integrationById(id: IntegrationId): Integration | undefined {
  return INTEGRATIONS.find((i) => i.id === id);
}
