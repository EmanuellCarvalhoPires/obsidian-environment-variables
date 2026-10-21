import { describe, expect, it, vi } from "vitest";
import { AuditLog } from "../src/audit/auditLog";
import { HubCallContext } from "../src/ecosystem/moduleConnector";
import {
  CREATE_SECRET_TOOL,
  createSecretHubTool,
  CreateSecretDeps,
  CreateSecretPrefill,
  CreateSecretScreen,
  runCreateSecretTool,
} from "../src/tools/createSecretTool";
import { SecretStore } from "../src/store/secretStore";
import { secretInput, unlockedStore } from "./helpers";

(globalThis as unknown as { window?: unknown }).window ??= globalThis;

/** What the user types in the real form. It must never show up in a result, a log or an audit entry. */
const TYPED_VALUE = "the-user-typed-THIS-9d41c7e2";

interface FakeScreen extends CreateSecretScreen {
  prefill: CreateSecretPrefill;
  closed: boolean;
  /** The user saves the form. */
  save(name: string): void;
  /** The user closes the form without saving. */
  dismiss(): void;
}

/** A form that is not a window: the test plays the user. */
function fakeUi(store?: SecretStore) {
  const screens: FakeScreen[] = [];
  const openScreen = (prefill: CreateSecretPrefill): FakeScreen => {
    let resolve!: (name: string | null) => void;
    const result = new Promise<string | null>((r) => (resolve = r));
    const screen: FakeScreen = {
      prefill,
      closed: false,
      result,
      close() {
        screen.closed = true;
        resolve(null); // like the real form: closing it without saving answers null
      },
      save(name) {
        // What the real form does: the user's text goes straight into the store.
        void store?.add(secretInput({ name, value: TYPED_VALUE, type: "token", username: undefined }));
        resolve(name);
      },
      dismiss: () => screen.close(),
    };
    screens.push(screen);
    return screen;
  };
  return { screens, openScreen };
}

function deps(over: Partial<CreateSecretDeps> = {}, ui = fakeUi()): CreateSecretDeps & { ui: ReturnType<typeof fakeUi>; audit: AuditLog } {
  const audit = new AuditLog();
  return { isUnlocked: () => true, openScreen: ui.openScreen, audit, ui, ...over } as CreateSecretDeps & { ui: ReturnType<typeof fakeUi>; audit: AuditLog };
}

const call = (signal?: AbortSignal) => ({ client: "claude", signal });
const textOf = (r: { content: Array<{ text: string }> }) => r.content.map((c) => c.text).join("\n");

describe("env_criar_secret", () => {
  it("answers only 'Secret NAME criada' and never carries the value", async () => {
    const { store } = await unlockedStore();
    const d = deps({}, fakeUi(store));
    const pending = runCreateSecretTool({ nome_sugerido: "jira acme", tipo_sugerido: "basic", dominios_sugeridos: ["acme.atlassian.net"], descricao: "Jira da ACME" }, call(), d);
    expect(d.ui.screens).toHaveLength(1);
    d.ui.screens[0].save("JIRA_ACME");
    const result = await pending;

    expect(result).toEqual({ content: [{ type: "text", text: "Secret JIRA_ACME criada" }] });
    // The value went to the store, and nowhere else.
    await vi.waitFor(() => expect(store.get("JIRA_ACME")?.value).toBe(TYPED_VALUE));
    expect(JSON.stringify(result)).not.toContain(TYPED_VALUE);
    expect(JSON.stringify(d.audit.list())).not.toContain(TYPED_VALUE);
    expect(d.audit.list()[0]).toMatchObject({ action: "create", tool: "env_criar_secret", secrets: ["JIRA_ACME"], outcome: "ok" });
  });

  it("opens the form with the suggestions, cleaned, and without full access or any host", async () => {
    const d = deps();
    const pending = runCreateSecretTool(
      {
        nome_sugerido: "  my jira-token! ",
        tipo_sugerido: "bearer",
        dominios_sugeridos: ["acme.atlassian.net", "acme.atlassian.net", "*.com", "not a host", " api.github.com ", "*.com.br"],
        descricao: "x".repeat(500),
      },
      call(),
      d,
    );
    const screen = d.ui.screens[0];
    expect(screen.prefill).toEqual({
      name: "MY_JIRA_TOKEN",
      type: "bearer",
      description: "x".repeat(300),
      allowedHosts: ["acme.atlassian.net", "api.github.com"], // duplicates and wildcards on public suffixes are dropped
    });
    // The suggestions have no way to turn those on: the form's own defaults stay off.
    expect(Object.keys(screen.prefill).sort()).toEqual(["allowedHosts", "description", "name", "type"]);
    screen.dismiss();
    await pending;
  });

  it("defaults the type to token, leaves the name empty when nothing usable is suggested, and uses the hosts saved by the set-up", async () => {
    const d = deps({ suggestedHosts: () => ["api.bitbucket.org", "bad host"] });
    const pending = runCreateSecretTool({ nome_sugerido: "!!!" }, call(), d);
    expect(d.ui.screens[0].prefill).toEqual({ name: "", type: "token", description: "", allowedHosts: ["api.bitbucket.org"] });
    d.ui.screens[0].dismiss();
    await pending;
    // Hosts the agent suggests win over the saved ones.
    const withHosts = runCreateSecretTool({ dominios_sugeridos: ["api.github.com"] }, call(), d);
    expect(d.ui.screens[1].prefill.allowedHosts).toEqual(["api.github.com"]);
    d.ui.screens[1].dismiss();
    await withHosts;
  });

  it("rejects a value in the arguments, explicitly, and never opens the form", async () => {
    const d = deps();
    for (const key of ["valor", "value", "token", "senha"]) {
      const result = await runCreateSecretTool({ nome_sugerido: "X", [key]: TYPED_VALUE }, call(), d);
      expect(result.isError).toBe(true);
      expect(textOf(result)).toMatch(/never receives the value/);
      expect(textOf(result)).not.toContain(TYPED_VALUE);
    }
    expect(d.ui.screens).toHaveLength(0);
    expect(JSON.stringify(d.audit.list())).not.toContain(TYPED_VALUE);
  });

  it("rejects other unknown arguments and wrong types", async () => {
    const d = deps();
    expect(textOf(await runCreateSecretTool({ foo: 1 }, call(), d))).toMatch(/Unknown argument: foo/);
    expect((await runCreateSecretTool({ tipo_sugerido: "root" }, call(), d)).isError).toBe(true);
    expect((await runCreateSecretTool({ dominios_sugeridos: "acme.atlassian.net" }, call(), d)).isError).toBe(true);
    expect((await runCreateSecretTool({ dominios_sugeridos: [1] }, call(), d)).isError).toBe(true);
    expect((await runCreateSecretTool({ nome_sugerido: 5 }, call(), d)).isError).toBe(true);
    expect((await runCreateSecretTool({ descricao: {} }, call(), d)).isError).toBe(true);
    expect(d.ui.screens).toHaveLength(0);
  });

  it("is declared with no `valor`, no extra properties, and stays available during the set-up", () => {
    expect(CREATE_SECRET_TOOL.inputSchema.additionalProperties).toBe(false);
    expect(Object.keys(CREATE_SECRET_TOOL.inputSchema.properties).sort()).toEqual(["descricao", "dominios_sugeridos", "nome_sugerido", "tipo_sugerido"]);
    const tool = createSecretHubTool({ ...deps(), clientName: (ctx) => ctx.client.name });
    expect(tool.name).toBe("env_criar_secret");
    expect(tool.availableDuringSetup).toBe(true);
    expect(tool.inputSchema).toBe(CREATE_SECRET_TOOL.inputSchema);
  });

  it("answers 'cancelado' when the user closes the form", async () => {
    const d = deps();
    const pending = runCreateSecretTool({ nome_sugerido: "X" }, call(), d);
    d.ui.screens[0].dismiss();
    expect(await pending).toEqual({ content: [{ type: "text", text: "cancelado" }] });
    expect(d.audit.list()[0]).toMatchObject({ outcome: "denied", detail: "cancelado" });
  });

  it("answers 'expirado' and closes the form when the time runs out", async () => {
    const d = deps({ timeoutMs: 20 });
    const result = await runCreateSecretTool({ nome_sugerido: "X" }, call(), d);
    expect(result).toEqual({ content: [{ type: "text", text: "expirado" }] });
    expect(d.ui.screens[0].closed).toBe(true);
  });

  it("waits up to 5 minutes by default", async () => {
    vi.useFakeTimers();
    try {
      const d = deps();
      const pending = runCreateSecretTool({}, call(), d);
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000 - 1);
      expect(d.ui.screens[0].closed).toBe(false);
      await vi.advanceTimersByTimeAsync(2);
      expect(await pending).toEqual({ content: [{ type: "text", text: "expirado" }] });
      expect(d.ui.screens[0].closed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("answers 'cancelado' and closes the form when the call is aborted", async () => {
    const d = deps();
    const abort = new AbortController();
    const pending = runCreateSecretTool({ nome_sugerido: "X" }, call(abort.signal), d);
    expect(d.ui.screens[0].closed).toBe(false);
    abort.abort();
    expect(await pending).toEqual({ content: [{ type: "text", text: "cancelado" }] });
    expect(d.ui.screens[0].closed).toBe(true);
  });

  it("does not open the form for a call that is already aborted", async () => {
    const d = deps();
    const abort = new AbortController();
    abort.abort();
    expect(await runCreateSecretTool({}, call(abort.signal), d)).toEqual({ content: [{ type: "text", text: "cancelado" }] });
    expect(d.ui.screens).toHaveLength(0);
  });

  it("passes the abort signal of the hub call to the tool", async () => {
    const d = deps();
    const tool = createSecretHubTool({ ...d, clientName: (ctx) => ctx.client.name });
    const abort = new AbortController();
    const ctx: HubCallContext = { client: { id: "c", name: "claude" }, moduleId: "environment-variables", signal: abort.signal };
    const pending = tool.handler({}, ctx);
    abort.abort();
    expect(await pending).toEqual({ content: [{ type: "text", text: "cancelado" }] });
    expect(d.audit.list()[0].client).toBe("claude");
  });

  it("returns an error telling the user to unlock the vault, and opens nothing", async () => {
    const d = deps({ isUnlocked: () => false });
    const result = await runCreateSecretTool({ nome_sugerido: "X" }, call(), d);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/locked/);
    expect(textOf(result)).toMatch(/unlock it in Obsidian/);
    expect(d.ui.screens).toHaveLength(0);
    expect(d.audit.list()[0]).toMatchObject({ outcome: "locked" });
  });

  it("works without an audit log", async () => {
    const d = deps({ audit: undefined });
    const pending = runCreateSecretTool({}, call(), d);
    d.ui.screens[0].save("ANY_NAME");
    expect(textOf(await pending)).toBe("Secret ANY_NAME criada");
  });
});
