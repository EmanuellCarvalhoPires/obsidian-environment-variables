import { describe, expect, it } from "vitest";
import { AuditLog } from "../src/audit/auditLog";
import { createSetupHandler, HooksDataPusher, hooksHosts, SetupDeps, toolNoteFolders } from "../src/ecosystem/hooksFeed";
import { ApprovalRequest, Broker } from "../src/secrets/broker";
import { PlaceholderError } from "../src/secrets/placeholders";
import { PolicyError } from "../src/secrets/prepare";
import { createRedactor } from "../src/secrets/redact";
import { createSecretVaultService } from "../src/secrets/secretVaultService";
import { Transport, TransportRequest } from "../src/secrets/transport";
import { ClientContext } from "../src/server/clients";
import { decryptVault, encryptPayload } from "../src/crypto/vaultFile";
import { SecretStore, VaultLockedError } from "../src/store/secretStore";
import { ValueRecord } from "../src/store/types";
import { PASSWORD, secretInput, unlockedStore } from "./helpers";

const limits = () => ({ timeoutMs: 5000, maxResponseBytes: 1_000_000, maxRedirects: 3 });
const client: ClientContext = { id: "c1", name: "claude", access: { mode: "all" } };

/** A transport that records what it was asked to send and answers 200 with a body of your choice. */
function fakeTransport(body = "{}"): { transport: Transport; sent: TransportRequest[] } {
  const sent: TransportRequest[] = [];
  const transport: Transport = async (req) => {
    sent.push(req);
    return {
      status: 200,
      statusText: "OK",
      headers: {},
      body,
      bodyEncoding: "text",
      bodyBytes: body.length,
      truncated: false,
      finalUrl: req.url.toString(),
      redirects: 0,
    };
  };
  return { transport, sent };
}

async function setup() {
  const { store, io } = await unlockedStore();
  const audit = new AuditLog();
  const { transport, sent } = fakeTransport();
  const service = createSecretVaultService({ store, transport, audit, limits });
  return { store, io, audit, service, sent };
}

const PROJECT_KEY = "ACMEPROJ-77";

async function withValues(store: SecretStore) {
  await store.addValue({ name: "PROJECT_KEY", kind: "texto", value: PROJECT_KEY, description: "Jira key", allowedHosts: ["acme.atlassian.net"] });
  await store.addValue({ name: "PAGE_SIZE", kind: "numero", value: "250", description: "", allowedHosts: [] });
  await store.addValue({ name: "SHORT", kind: "texto", value: "abc", description: "", allowedHosts: ["acme.atlassian.net"] });
}

describe("values: storage", () => {
  it("lives in the same encrypted file as the secrets and survives a lock and unlock", async () => {
    const { store, io } = await unlockedStore();
    await store.add(secretInput());
    await withValues(store);
    expect(io.content).not.toContain(PROJECT_KEY); // encrypted, never in clear text
    store.lock();
    expect(() => store.listValues()).toThrow(VaultLockedError);

    const again = new SecretStore(io, { iterations: 1000 });
    await again.unlock(PASSWORD);
    expect(again.listValues().map((v) => v.name)).toEqual(["PAGE_SIZE", "PROJECT_KEY", "SHORT"]);
    expect(again.getValue("PROJECT_KEY")?.value).toBe(PROJECT_KEY);
    expect(again.list()).toHaveLength(1);
  });

  it("opens a vault file written before values existed", async () => {
    const { store, io } = await unlockedStore();
    await store.add(secretInput());
    const { derived } = await decryptVault<{ secrets: unknown[] }>(io.content!, PASSWORD);
    // The old payload had no `values` field at all.
    const old = await decryptVault<{ secrets: unknown[]; values?: unknown }>(io.content!, PASSWORD);
    io.content = await encryptPayload({ secrets: old.payload.secrets }, derived);

    const reopened = new SecretStore(io, { iterations: 1000 });
    await reopened.unlock(PASSWORD);
    expect(reopened.list()).toHaveLength(1);
    expect(reopened.listValues()).toEqual([]);
    await reopened.addValue({ name: "NEW_ONE", kind: "texto", value: "hello world", description: "", allowedHosts: [] });
    expect(reopened.listValues()).toHaveLength(1);
  });

  it("blanks the values when the vault locks", async () => {
    const { store } = await unlockedStore();
    await withValues(store);
    const kept = store.getValue("PROJECT_KEY")!;
    store.lock();
    expect(kept.value).toBe("");
  });

  it("shares one namespace with the secrets: a name is unique across both, and nothing is overwritten", async () => {
    const { store } = await unlockedStore();
    await store.add(secretInput({ name: "JIRA_ACME" }));
    await withValues(store);
    expect(store.nameExists("JIRA_ACME")).toBe(true);
    expect(store.nameExists("PROJECT_KEY")).toBe(true);
    expect(store.nameExists("FREE_NAME")).toBe(false);
    await expect(store.addValue({ name: "JIRA_ACME", kind: "texto", value: "x-value", description: "", allowedHosts: [] })).rejects.toThrow(/already exists/);
    await expect(store.add(secretInput({ name: "PROJECT_KEY" }))).rejects.toThrow(/already exists/);
    await expect(store.addValue({ name: "PROJECT_KEY", kind: "texto", value: "other-one", description: "", allowedHosts: [] })).rejects.toThrow(/already exists/);
    expect(store.getValue("PROJECT_KEY")?.value).toBe(PROJECT_KEY);
    // A secret cannot be renamed onto a value either.
    const jira = store.list().find((s) => s.name === "JIRA_ACME")!;
    await expect(store.update(jira.id, { name: "PAGE_SIZE" })).rejects.toThrow(/already exists/);
  });

  it("checks the text against the kind", async () => {
    const { store } = await unlockedStore();
    const add = (kind: ValueRecord["kind"], value: string) => store.addValue({ name: `V_${kind}_${value.length}`, kind, value, description: "", allowedHosts: [] });
    await expect(add("numero", "twelve")).rejects.toThrow(/not valid/);
    await expect(add("url", "not a url")).rejects.toThrow(/not valid/);
    await expect(add("email", "nobody")).rejects.toThrow(/not valid/);
    await expect(add("json", "{oops")).rejects.toThrow(/not valid/);
    await expect(add("texto", "   ")).rejects.toThrow(/empty/);
    await expect(add("numero", "12.5")).resolves.toBeDefined();
    await expect(add("json", '{"a":1}')).resolves.toBeDefined();
  });
});

describe("secrets service: createValue and nameExists", () => {
  it("creates a value without returning it, and never overwrites", async () => {
    const { service, store, audit } = await setup();
    await store.add(secretInput({ name: "JIRA_ACME" }));
    const typed = "typed-by-the-user-9f3a";

    expect(service.nameExists!("NEW_PASSWORD")).toBe(false);
    const created = await service.createValue!({ name: "NEW_PASSWORD", kind: "senha", value: typed, description: "desc", createdBy: "ai-ecosystem" });
    expect(created).toEqual({ ok: true });
    expect(store.getValue("NEW_PASSWORD")).toMatchObject({ kind: "senha", createdBy: "ai-ecosystem", allowedHosts: [] });
    expect(service.nameExists!("NEW_PASSWORD")).toBe(true);
    expect(service.nameExists!("JIRA_ACME")).toBe(true); // a secret counts too

    expect(await service.createValue!({ name: "NEW_PASSWORD", kind: "senha", value: "another-one", createdBy: "x" })).toEqual({ ok: false, reason: "exists" });
    expect(await service.createValue!({ name: "JIRA_ACME", kind: "texto", value: "another-one", createdBy: "x" })).toEqual({ ok: false, reason: "exists" });
    expect(store.getValue("NEW_PASSWORD")?.value).toBe(typed);

    expect(await service.createValue!({ name: "bad name", kind: "texto", value: "abcdefg", createdBy: "x" })).toEqual({ ok: false, reason: "invalid_name" });
    expect(await service.createValue!({ name: "EMPTY_ONE", kind: "texto", value: "  ", createdBy: "x" })).toEqual({ ok: false, reason: "empty" });
    expect(await service.createValue!({ name: "BAD_NUMBER", kind: "numero", value: "abc", createdBy: "x" })).toEqual({ ok: false, reason: "invalid_value" });

    // The audit log names the value but never holds its text.
    const log = JSON.stringify(audit.list());
    expect(log).toContain("NEW_PASSWORD");
    expect(log).not.toContain(typed);
  });

  it("answers locked while the vault is locked, and nameExists is false", async () => {
    const { service, store } = await setup();
    await withValues(store);
    store.lock();
    expect(await service.createValue!({ name: "WHILE_LOCKED", kind: "texto", value: "abcdefg", createdBy: "x" })).toEqual({ ok: false, reason: "locked" });
    expect(service.nameExists!("PROJECT_KEY")).toBe(false);
  });
});

describe("values in scripts and templates", () => {
  it("resolves text and number values in the environment AND in the args", async () => {
    const { service, store, audit } = await setup();
    await store.add(secretInput({ name: "JIRA_ACME", type: "token", value: "token-value-abcdef", username: undefined }));
    await withValues(store);

    let seen: { env: Record<string, string>; args: string[] } | undefined;
    await service.spawnWithSecretsAndArgs!(
      {
        env: { KEY: "{{secret:PROJECT_KEY}}", TOKEN: "{{secret:JIRA_ACME}}", PLAIN: "no placeholder" },
        args: ["--project", "{{secret:PROJECT_KEY}}", "--size={{secret:PAGE_SIZE}}", "--both={{secret:PROJECT_KEY}}/{{secret:PAGE_SIZE}}"],
      },
      async (resolved) => {
        seen = resolved;
      },
      "ai-scripts",
    );
    expect(seen).toEqual({
      env: { KEY: PROJECT_KEY, TOKEN: "token-value-abcdef", PLAIN: "no placeholder" },
      args: ["--project", PROJECT_KEY, "--size=250", `--both=${PROJECT_KEY}/250`],
    });
    expect(store.getValue("PROJECT_KEY")?.lastUsedAt).toBeDefined();
    expect(JSON.stringify(audit.list())).not.toContain(PROJECT_KEY);

    // The older env-only method also resolves values.
    let env: Record<string, string> | undefined;
    await service.spawnWithSecrets({ SIZE: "{{secret:PAGE_SIZE}}" }, async (e) => void (env = e), "ai-bridge");
    expect(env).toEqual({ SIZE: "250" });
  });

  it("refuses unknown names and kinds that do not fit a value", async () => {
    const { service, store } = await setup();
    await withValues(store);
    const run = (env: Record<string, string>, args: string[] = []) => service.spawnWithSecretsAndArgs!({ env, args }, async () => undefined, "m");
    await expect(run({ A: "{{secret:NOPE}}" })).rejects.toBeInstanceOf(PolicyError);
    await expect(run({}, ["{{secret:NOPE}}"])).rejects.toMatchObject({ code: "unknown_secret" });
    await expect(run({ A: "{{basic:PROJECT_KEY}}" })).rejects.toBeInstanceOf(PlaceholderError);
    await expect(run({ A: "{{secret:PROJECT_KEY.user}}" })).rejects.toBeInstanceOf(PlaceholderError);
    await expect(run({}, ["{{secret:PROJECT_KEY"])).rejects.toMatchObject({ code: "invalid_placeholder" });
  });

  it("blocks both spawn methods while locked", async () => {
    const { service, store } = await setup();
    await withValues(store);
    store.lock();
    await expect(service.spawnWithSecretsAndArgs!({ env: {}, args: ["{{secret:PROJECT_KEY}}"] }, async () => undefined, "m")).rejects.toBeInstanceOf(VaultLockedError);
  });

  it("resolves values, and only values, inside template data", async () => {
    const { service, store } = await setup();
    await store.add(secretInput({ name: "JIRA_ACME", type: "token", value: "token-value-abcdef", username: undefined }));
    await withValues(store);

    const data = {
      title: "Project {{secret:PROJECT_KEY}}",
      rows: [["{{secret:PAGE_SIZE}}", "{{secret:JIRA_ACME}}", "{{secret:UNKNOWN_ONE}}"], 42, null],
      nested: { link: "https://x/{{secret:PROJECT_KEY}}", basic: "{{basic:PROJECT_KEY}}", field: "{{secret:PROJECT_KEY.user}}" },
    };
    const out = (await service.resolveTemplateData!(data, "ai-templates")) as typeof data;
    expect(out.title).toBe(`Project ${PROJECT_KEY}`);
    expect(out.rows[0]).toEqual(["250", "{{secret:JIRA_ACME}}", "{{secret:UNKNOWN_ONE}}"]); // a secret stays, an unknown name stays
    expect(out.rows.slice(1)).toEqual([42, null]);
    expect(out.nested.link).toBe(`https://x/${PROJECT_KEY}`);
    expect(out.nested.basic).toBe("{{basic:PROJECT_KEY}}"); // only {{secret:NAME}} resolves a value
    expect(out.nested.field).toBe("{{secret:PROJECT_KEY.user}}");
    expect(data.title).toBe("Project {{secret:PROJECT_KEY}}"); // the input is not changed
    expect(JSON.stringify(out)).not.toContain("token-value-abcdef");
  });

  it("leaves data without placeholders alone even while locked, but refuses to resolve one while locked", async () => {
    const { service, store } = await setup();
    await withValues(store);
    store.lock();
    expect(await service.resolveTemplateData!({ a: "plain" }, "ai-templates")).toEqual({ a: "plain" });
    await expect(service.resolveTemplateData!({ a: "{{secret:PROJECT_KEY}}" }, "ai-templates")).rejects.toBeInstanceOf(VaultLockedError);
  });

  it("does not resolve a value anywhere else: redact, and the metadata of list_secrets", async () => {
    const { service, store } = await setup();
    await withValues(store);
    expect(service.redact("see {{secret:PROJECT_KEY}}")).toBe("see {{secret:PROJECT_KEY}}");
    const broker = new Broker(store, fakeTransport().transport, async () => true, new AuditLog(), limits);
    const listed = broker.listSecrets(client);
    expect(listed.ok && listed.secrets).toEqual([]); // values are not secrets: never listed, never their text
    expect(JSON.stringify(listed)).not.toContain(PROJECT_KEY);
  });
});

describe("masking values", () => {
  it("masks a value of 6 characters or more, and not a shorter one", async () => {
    const { service, store } = await setup();
    await store.addValue({ name: "SIX", kind: "texto", value: "abcdef", description: "", allowedHosts: [] });
    await store.addValue({ name: "FIVE", kind: "texto", value: "vwxyz", description: "", allowedHosts: [] });
    expect(service.redact("a abcdef b")).toBe("a [REDACTED] b");
    expect(service.redact("a vwxyz b")).toBe("a vwxyz b");
    // Its encodings are masked too.
    expect(service.redact(`b64 ${Buffer.from("abcdef").toString("base64")}`)).toBe("b64 [REDACTED]");
  });

  it("masks used values in the broker's responses, with the same minimum", async () => {
    const { store } = await unlockedStore();
    await store.addValue({ name: "SIX", kind: "texto", value: "abcdef", description: "", allowedHosts: ["api.acme.com"] });
    await store.addValue({ name: "FIVE", kind: "texto", value: "vwxyz", description: "", allowedHosts: ["api.acme.com"] });
    const { transport } = fakeTransport("echo abcdef and vwxyz");
    const broker = new Broker(store, transport, async () => true, new AuditLog(), limits);
    const res = await broker.execute({ url: "https://api.acme.com/x", headers: { "X-A": "{{secret:SIX}}", "X-B": "{{secret:FIVE}}" } }, client);
    expect(res.ok && res.body).toBe("echo *** and vwxyz");
  });

  it("createRedactor takes values separately from secrets", () => {
    const value = { value: "hello-world" } as ValueRecord;
    expect(createRedactor([], "###", [value]).redact("say hello-world").text).toBe("say ###");
    expect(createRedactor([], "###").redact("say hello-world").text).toBe("say hello-world");
  });
});

describe("values in http_request", () => {
  it("resolves them in headers, URL and body when the host is one of the value's own", async () => {
    const { store } = await unlockedStore();
    await withValues(store);
    const { transport, sent } = fakeTransport();
    const asked: ApprovalRequest[] = [];
    const broker = new Broker(store, transport, async (r) => (asked.push(r), true), new AuditLog(), limits);
    const res = await broker.execute(
      {
        method: "POST",
        url: "https://acme.atlassian.net/rest/api/3/search?size={{secret:PAGE_SIZE}}",
        headers: { "X-Project": "{{secret:PROJECT_KEY}}" },
        body: JSON.stringify({ jql: "project = {{secret:PROJECT_KEY}}" }),
      },
      client,
    );
    // PAGE_SIZE has no host list, so this request does ask; PROJECT_KEY alone would not.
    expect(res.ok).toBe(true);
    expect(asked).toHaveLength(1);
    expect(asked[0].outsideHosts).toEqual(["PAGE_SIZE"]);
    expect(sent[0].url.toString()).toBe("https://acme.atlassian.net/rest/api/3/search?size=250");
    expect(sent[0].headers["X-Project"]).toBe(PROJECT_KEY);
    expect(sent[0].body).toBe(JSON.stringify({ jql: `project = ${PROJECT_KEY}` }));
  });

  it("does not ask when every value is inside its allowed hosts", async () => {
    const { store } = await unlockedStore();
    await withValues(store);
    const { transport, sent } = fakeTransport();
    const broker = new Broker(store, transport, async () => false, new AuditLog(), limits); // would deny if asked
    const res = await broker.execute({ url: "https://acme.atlassian.net/x", headers: { "X-Project": "{{secret:PROJECT_KEY}}" } }, client);
    expect(res.ok).toBe(true);
    expect(sent).toHaveLength(1);
  });

  it("asks for approval when the host is outside the value's allowed hosts, and sends nothing if denied", async () => {
    const { store } = await unlockedStore();
    await withValues(store);
    const { transport, sent } = fakeTransport();
    const asked: ApprovalRequest[] = [];
    let answer = false;
    const broker = new Broker(store, transport, async (r) => (asked.push(r), answer), new AuditLog(), limits);
    const req = { url: "https://elsewhere.example.com/x", headers: { "X-Project": "{{secret:PROJECT_KEY}}" } };

    const denied = await broker.execute(req, client);
    expect(denied).toMatchObject({ ok: false, error: { code: "denied" } });
    expect(sent).toHaveLength(0);
    expect(asked[0]).toMatchObject({ secrets: ["PROJECT_KEY"], outsideHosts: ["PROJECT_KEY"], url: "https://elsewhere.example.com/x" });
    expect(JSON.stringify(asked[0])).not.toContain(PROJECT_KEY);

    answer = true;
    const allowed = await broker.execute(req, client);
    expect(allowed.ok).toBe(true);
    expect(sent[0].headers["X-Project"]).toBe(PROJECT_KEY);
  });

  it("only goes over https, and never follows a redirect to another origin once approved for one", async () => {
    const { store } = await unlockedStore();
    await withValues(store);
    const { transport } = fakeTransport();
    const broker = new Broker(store, transport, async () => true, new AuditLog(), limits);
    const insecure = await broker.execute({ url: "http://acme.atlassian.net/x", headers: { "X-P": "{{secret:PROJECT_KEY}}" } }, client);
    expect(insecure).toMatchObject({ ok: false, error: { code: "insecure_scheme" } });

    // A redirect: seen through the transport's redirectDecision.
    let decision: string | undefined;
    const probe: Transport = async (req) => {
      decision = req.redirectDecision(new URL("https://evil.example.org/y"), 302);
      const sameOrigin = req.redirectDecision(new URL("https://elsewhere.example.com/other"), 302);
      expect(sameOrigin).toBe("follow");
      return { status: 200, statusText: "OK", headers: {}, body: "", bodyEncoding: "text", bodyBytes: 0, truncated: false, finalUrl: req.url.toString(), redirects: 0 };
    };
    const probing = new Broker(store, probe, async () => true, new AuditLog(), limits);
    await probing.execute({ url: "https://elsewhere.example.com/x", headers: { "X-P": "{{secret:PROJECT_KEY}}" } }, client);
    expect(decision).toBe("stop");
  });

  it("refuses a malformed use of a value: basic and bearer need a secret", async () => {
    const { store } = await unlockedStore();
    await withValues(store);
    const broker = new Broker(store, fakeTransport().transport, async () => true, new AuditLog(), limits);
    const res = await broker.execute({ url: "https://acme.atlassian.net/x", headers: { Authorization: "{{bearer:PROJECT_KEY}}" } }, client);
    expect(res).toMatchObject({ ok: false, error: { code: "invalid_placeholder" } });
  });

  it("service.request sends a value only to its own hosts and masks it in the answer", async () => {
    const { store } = await unlockedStore();
    await withValues(store);
    const audit = new AuditLog();
    const { transport, sent } = fakeTransport(`{"echo":"${PROJECT_KEY}"}`);
    const service = createSecretVaultService({ store, transport, audit, limits });

    const ok = await service.request({ method: "GET", url: "https://acme.atlassian.net/x", headers: { "X-P": "{{secret:PROJECT_KEY}}" } }, "ai-bridge");
    expect(sent[0].headers["X-P"]).toBe(PROJECT_KEY);
    expect(ok.body).toBe('{"echo":"[REDACTED]"}');

    // There is no approval dialog on this path, so a host outside the value's hosts is refused.
    await expect(service.request({ method: "GET", url: "https://elsewhere.example.com/x", headers: { "X-P": "{{secret:PROJECT_KEY}}" } }, "ai-bridge")).rejects.toMatchObject({
      code: "host_not_allowed",
    });
    expect(sent).toHaveLength(1);
    expect(JSON.stringify(audit.list())).not.toContain(PROJECT_KEY);
  });
});

describe("feed of the hooks service", () => {
  it("sends the hosts of secrets that have a host list and of values, never the ones with full access or any host", () => {
    const hosts = hooksHosts(
      [
        { allowedHosts: ["acme.atlassian.net", "https://api.github.com/"], allowAnyHost: false, fullAccess: false },
        { allowedHosts: ["full.example.com"], allowAnyHost: false, fullAccess: true },
        { allowedHosts: ["any.example.com"], allowAnyHost: true, fullAccess: false },
        { allowedHosts: ["api.example.com/v1/workspaces/123/*", "*.example.org", "*.com"], fullAccess: undefined, allowAnyHost: undefined },
        { allowedHosts: [], allowAnyHost: false },
      ],
      [{ allowedHosts: ["values.example.net"] }, { allowedHosts: [] }],
    );
    expect(hosts).toEqual(["*.example.org", "acme.atlassian.net", "api.example.com/v1/workspaces/123", "api.github.com", "values.example.net"]);
  });

  it("carries hosts only: no names and no values", async () => {
    const { store } = await unlockedStore();
    await store.add(secretInput({ name: "VERY_SECRET_NAME", value: "very-secret-token-value" }));
    await withValues(store);
    const hosts = hooksHosts(store.list(), store.listValues());
    const sent = JSON.stringify({ hosts });
    expect(sent).toContain("acme.atlassian.net");
    for (const leaked of ["VERY_SECRET_NAME", "very-secret-token-value", "PROJECT_KEY", PROJECT_KEY]) expect(sent).not.toContain(leaked);
  });

  it("derives the tool note folders from where the notes are, or uses the one in the settings", () => {
    expect(toolNoteFolders("", ["MCP/Jira/a.md", "MCP/Jira/b.md", "MCP/Confluence/c.md", "Other/Tools/d.md", "root.md"])).toEqual(["MCP", "Other/Tools"]);
    expect(toolNoteFolders("MCP/Jira", ["x/y.md"])).toEqual(["MCP/Jira"]);
    expect(toolNoteFolders("/MCP/Jira/", [])).toEqual(["MCP/Jira"]);
    expect(toolNoteFolders("../outside", ["MCP/a.md"])).toEqual(["MCP"]); // an unusable folder is ignored
    expect(toolNoteFolders("", [])).toEqual([]);
  });

  it("skips a repeated push, survives a missing service and a failing one", () => {
    const calls: unknown[] = [];
    const service = { setRuleData: (_id: string, data: unknown) => void calls.push(data) };
    const pusher = new HooksDataPusher();
    pusher.push(undefined, "environment-variables", { hosts: ["a.com"] }); // no service (older core): no error
    pusher.push(service, "environment-variables", { hosts: ["a.com"] });
    pusher.push(service, "environment-variables", { hosts: ["a.com"] });
    pusher.push(service, "environment-variables", { hosts: ["a.com", "b.com"] });
    expect(calls).toHaveLength(2);
    pusher.reset();
    pusher.push(service, "environment-variables", { hosts: ["a.com", "b.com"] });
    expect(calls).toHaveLength(3);
    const failing = { setRuleData: () => { throw new Error("boom"); } };
    expect(() => pusher.push(failing, "environment-variables", { hosts: ["c.com"] })).not.toThrow();
  });
});

describe("set-up handler", () => {
  function deps(overrides: Partial<SetupDeps> = {}): SetupDeps & { saved: { folder?: string; services?: string[] } } {
    const saved: { folder?: string; services?: string[] } = {};
    return {
      saved,
      isUnlocked: () => true,
      counts: () => ({ secrets: 2, values: 1 }),
      indexedCounts: () => ({ secrets: 5, values: 4 }),
      toolNotesFolder: () => "MCP",
      folderExists: (p) => p === "MCP" || p === "Tools",
      setToolNotesFolder: async (p) => void (saved.folder = p),
      knownHosts: () => ["acme.atlassian.net"],
      setServiceHosts: async (h) => void (saved.services = h),
      ...overrides,
    };
  }

  it("detects the state without names or values", async () => {
    const handler = createSetupHandler(deps());
    expect(await handler.detect!()).toEqual({ vaultUnlocked: true, secretCount: 2, valueCount: 1, toolNotesFolder: "MCP", knownHosts: ["acme.atlassian.net"] });
    const locked = createSetupHandler(deps({ isUnlocked: () => false, counts: () => null }));
    expect(await locked.detect!()).toMatchObject({ vaultUnlocked: false, secretCount: 5, valueCount: 4 });
  });

  it("saves the tool notes folder only when it exists in the vault", async () => {
    const d = deps();
    const handler = createSetupHandler(d);
    expect(await handler.save!("pasta_notas_tools", "/Tools/")).toBeUndefined();
    expect(d.saved.folder).toBe("Tools");
    expect(await handler.save!("pasta_notas_tools", "Missing")).toMatch(/does not exist/);
    expect(await handler.save!("pasta_notas_tools", "../etc")).toMatch(/folder path/);
    expect(await handler.save!("pasta_notas_tools", 42)).toMatch(/folder path/);
    expect(d.saved.folder).toBe("Tools");
  });

  it("turns service names into host suggestions", async () => {
    const d = deps();
    const handler = createSetupHandler(d);
    expect(await handler.save!("servicos", ["Jira", "bitbucket", "confluence", "github", "api.example.com"])).toBeUndefined();
    expect(d.saved.services).toEqual(["*.atlassian.net", "api.bitbucket.org", "api.example.com", "api.github.com"]);
    expect(await handler.save!("servicos", ["jira", "nope"])).toMatch(/Unknown service: nope/);
    expect(await handler.save!("servicos", "jira")).toMatch(/list of service names/);
    expect(await handler.save!("other", 1)).toMatch(/Unknown key/);
  });

  it("validates ok only with the vault unlocked", async () => {
    expect(await createSetupHandler(deps()).validate!()).toEqual({ ok: true });
    const locked = await createSetupHandler(deps({ isUnlocked: () => false })).validate!();
    expect(locked.ok).toBe(false);
    expect(locked.missing?.[0]).toMatch(/unlock/i);
  });
});
