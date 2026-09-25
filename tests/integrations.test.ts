import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterAll, describe, expect, it } from "vitest";
import { SERVER_NAME_PATTERN, serverNameFor, slugOf, vaultIdOf } from "../src/server/vaultIdentity";
import {
  CODEX_BLOCK_START,
  codexBlockToken,
  INTEGRATIONS,
  MCP_SERVER_NAME,
  registerWithClaude,
  removeCodexBlock,
  upsertCodexBlock,
} from "../src/integrations/integrations";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ev-integrations-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const TOKEN = "evc_" + "ab".repeat(32);
const URL_ = "http://127.0.0.1:27150/mcp";

/** A fake `claude` that records each call's arguments, one JSON array per line. */
function fakeClaude(): { file: string; log: string } {
  const log = path.join(tmp, `calls-${Math.random().toString(16).slice(2)}.jsonl`);
  const script = path.join(tmp, "record.js");
  fs.writeFileSync(script, `require("fs").appendFileSync(process.env.EV_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");`);
  let file: string;
  if (process.platform === "win32") {
    file = path.join(tmp, "claude.cmd");
    fs.writeFileSync(file, `@echo off\r\nnode "${script}" %*\r\n`);
  } else {
    file = path.join(tmp, "claude");
    fs.writeFileSync(file, `#!/bin/sh\nexec node "${script}" "$@"\n`, { mode: 0o755 });
  }
  process.env.EV_LOG = log;
  return { file, log };
}

describe("Claude Code integration", () => {
  it("removes the old entry and adds the server at user scope, with the header intact", async () => {
    const { file, log } = fakeClaude();
    await registerWithClaude(file, URL_, TOKEN);
    const calls = fs.readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l) as string[]);
    expect(calls[0]).toEqual(["mcp", "remove", MCP_SERVER_NAME, "--scope", "user"]);
    expect(calls[1]).toEqual(["mcp", "add", "--transport", "http", "--scope", "user", MCP_SERVER_NAME, URL_, "--header", `Authorization: Bearer ${TOKEN}`]);
  });
});

describe("Cursor integration", () => {
  const cursor = INTEGRATIONS.find((i) => i.id === "cursor")!;
  const homeVar = process.platform === "win32" ? "USERPROFILE" : "HOME";
  const originalHome = process.env[homeVar];
  const fakeHome = path.join(tmp, "home");

  it("merges into an existing mcp.json without touching other servers, then removes only its entry", async () => {
    fs.mkdirSync(path.join(fakeHome, ".cursor"), { recursive: true });
    const file = path.join(fakeHome, ".cursor", "mcp.json");
    fs.writeFileSync(file, JSON.stringify({ mcpServers: { other: { command: "x" } }, extra: 1 }));
    process.env[homeVar] = fakeHome;
    try {
      expect(await cursor.detect()).toBe(true);
      await cursor.connect(URL_, TOKEN, MCP_SERVER_NAME);
      const after = JSON.parse(fs.readFileSync(file, "utf8"));
      expect(after.extra).toBe(1);
      expect(after.mcpServers.other).toEqual({ command: "x" });
      expect(after.mcpServers[MCP_SERVER_NAME]).toEqual({ url: URL_, headers: { Authorization: `Bearer ${TOKEN}` } });
      await cursor.disconnect(MCP_SERVER_NAME);
      const removed = JSON.parse(fs.readFileSync(file, "utf8"));
      expect(removed.mcpServers).toEqual({ other: { command: "x" } });
    } finally {
      process.env[homeVar] = originalHome;
    }
  });

  it("refuses to overwrite an mcp.json it cannot parse", async () => {
    const file = path.join(fakeHome, ".cursor", "mcp.json");
    fs.writeFileSync(file, "{ not json");
    process.env[homeVar] = fakeHome;
    try {
      await expect(cursor.connect(URL_, TOKEN, MCP_SERVER_NAME)).rejects.toThrow();
      expect(fs.readFileSync(file, "utf8")).toBe("{ not json");
    } finally {
      process.env[homeVar] = originalHome;
    }
  });
});

describe("Codex integration (config.toml)", () => {
  const existing = ['model = "gpt-5"', "", "[mcp_servers.other]", 'command = "npx"', 'args = ["x"]', ""].join("\n");

  it("appends a managed block and keeps the rest of the file byte for byte", () => {
    const out = upsertCodexBlock(existing, URL_, TOKEN);
    expect(out.startsWith(existing.trimEnd())).toBe(true);
    expect(out).toContain(`[mcp_servers.${MCP_SERVER_NAME}]`);
    expect(out).toContain(`url = "${URL_}"`);
    expect(out).toContain(`http_headers = { "Authorization" = "Bearer ${TOKEN}" }`);
  });

  it("replaces the block on reconnect instead of duplicating it", () => {
    const once = upsertCodexBlock(existing, URL_, TOKEN);
    const twice = upsertCodexBlock(once, "http://127.0.0.1:28000/mcp", "evc_new");
    expect(twice.split(CODEX_BLOCK_START).length - 1).toBe(1);
    expect(twice).toContain("evc_new");
    expect(twice).not.toContain(TOKEN);
  });

  it("removes only its block", () => {
    const removed = removeCodexBlock(upsertCodexBlock(existing, URL_, TOKEN));
    expect(removed.trimEnd()).toBe(existing.trimEnd());
  });

  it("refuses to touch an entry the user wrote by hand", () => {
    const manual = existing + `\n[mcp_servers.${MCP_SERVER_NAME}]\nurl = "x"\n`;
    expect(() => upsertCodexBlock(manual, URL_, TOKEN)).toThrow(/not added by this plugin/);
  });

  it("writes and removes the file under CODEX_HOME", async () => {
    const codex = INTEGRATIONS.find((i) => i.id === "codex")!;
    const home = path.join(tmp, "codex-home");
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, "config.toml"), existing);
    const original = process.env.CODEX_HOME;
    process.env.CODEX_HOME = home;
    try {
      expect(await codex.detect()).toBe(true);
      await codex.connect(URL_, TOKEN, MCP_SERVER_NAME);
      expect(fs.readFileSync(path.join(home, "config.toml"), "utf8")).toContain(TOKEN);
      await codex.disconnect(MCP_SERVER_NAME);
      expect(fs.readFileSync(path.join(home, "config.toml"), "utf8").trimEnd()).toBe(existing.trimEnd());
    } finally {
      if (original === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = original;
    }
  });
});

describe("one server name per vault", () => {
  const A = "environment-variables-cofre";
  const B = "environment-variables-teste-plugin";
  const TOKEN_B = "evc_" + "cd".repeat(32);

  it("keeps two vaults side by side in mcp.json and reads back each token", async () => {
    const cursor = INTEGRATIONS.find((i) => i.id === "cursor")!;
    const homeVar = process.platform === "win32" ? "USERPROFILE" : "HOME";
    const originalHome = process.env[homeVar];
    const home = path.join(tmp, "two-vaults");
    fs.mkdirSync(path.join(home, ".cursor"), { recursive: true });
    process.env[homeVar] = home;
    try {
      await cursor.connect("http://127.0.0.1:27150/mcp", TOKEN, A);
      await cursor.connect("http://127.0.0.1:27151/mcp", TOKEN_B, B);
      expect(await cursor.registeredToken(A)).toBe(TOKEN);
      expect(await cursor.registeredToken(B)).toBe(TOKEN_B);
      await cursor.disconnect(B);
      expect(await cursor.registeredToken(A)).toBe(TOKEN);
      expect(await cursor.registeredToken(B)).toBeNull();
    } finally {
      process.env[homeVar] = originalHome;
    }
  });

  it("keeps one Codex block per vault and removes only the right one", () => {
    const both = upsertCodexBlock(upsertCodexBlock("", "http://127.0.0.1:27150/mcp", TOKEN, A), "http://127.0.0.1:27151/mcp", TOKEN_B, B);
    expect(codexBlockToken(both, A)).toBe(TOKEN);
    expect(codexBlockToken(both, B)).toBe(TOKEN_B);
    const onlyA = removeCodexBlock(both, B);
    expect(codexBlockToken(onlyA, A)).toBe(TOKEN);
    expect(onlyA).not.toContain(TOKEN_B);
  });

  it("reads the Claude Code entry from .claude.json without running claude", async () => {
    const claude = INTEGRATIONS.find((i) => i.id === "claude-code")!;
    const dir = path.join(tmp, "claude-config");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, ".claude.json"), JSON.stringify({ mcpServers: { [A]: { type: "http", url: URL_, headers: { Authorization: `Bearer ${TOKEN}` } } } }));
    const original = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = dir;
    try {
      expect(await claude.registeredToken(A)).toBe(TOKEN);
      expect(await claude.registeredToken(B)).toBeNull();
    } finally {
      if (original === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = original;
    }
  });

  it("derives a valid, stable name from the vault", () => {
    const id = vaultIdOf("C:\\Users\\x\\Documents\\Teste Plugin");
    expect(id).toBe(vaultIdOf("c:/users/x/documents/teste plugin"));
    expect(id).not.toBe(vaultIdOf("C:\\Users\\x\\Documents\\Cofre"));
    expect(serverNameFor("Teste Plugin", id)).toBe(B);
    expect(serverNameFor("Cofre Ação", id)).toBe("environment-variables-cofre-acao");
    expect(slugOf("!!!", id)).toBe(id.slice(0, 8));
    for (const n of [serverNameFor("Teste Plugin", id), serverNameFor("日本", id), MCP_SERVER_NAME]) expect(SERVER_NAME_PATTERN.test(n)).toBe(true);
  });
});

describe("Antigravity integration", () => {
  it("uses serverUrl (Antigravity rejects url) and keeps other servers", async () => {
    const antigravity = INTEGRATIONS.find((i) => i.id === "antigravity")!;
    const homeVar = process.platform === "win32" ? "USERPROFILE" : "HOME";
    const originalHome = process.env[homeVar];
    const home = path.join(tmp, "ag-home");
    const file = path.join(home, ".gemini", "config", "mcp_config.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ mcpServers: { "atlassian-mcp-server": { command: "npx", args: ["a"] } } }));
    process.env[homeVar] = home;
    try {
      expect(await antigravity.detect()).toBe(true);
      await antigravity.connect(URL_, TOKEN, MCP_SERVER_NAME);
      const cfg = JSON.parse(fs.readFileSync(file, "utf8"));
      expect(cfg.mcpServers[MCP_SERVER_NAME]).toEqual({ serverUrl: URL_, headers: { Authorization: `Bearer ${TOKEN}` } });
      expect(cfg.mcpServers["atlassian-mcp-server"]).toEqual({ command: "npx", args: ["a"] });
      await antigravity.disconnect(MCP_SERVER_NAME);
      expect(Object.keys(JSON.parse(fs.readFileSync(file, "utf8")).mcpServers)).toEqual(["atlassian-mcp-server"]);
    } finally {
      process.env[homeVar] = originalHome;
    }
  });
});
