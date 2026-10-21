import * as http from "http";
import { AddressInfo } from "net";
import type { App } from "obsidian";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AuditLog } from "../src/audit/auditLog";
import {
  AIEcosystemAPI,
  EcosystemConnector,
  MODULE_ID,
  ModuleRegistration,
  ServiceChangeListener,
} from "../src/ecosystem/moduleConnector";
import { Broker } from "../src/secrets/broker";
import { PolicyError } from "../src/secrets/prepare";
import { SecretAdoptionCoordinator, SecretHolderService } from "../src/secrets/secretAdoption";
import { createSecretVaultService } from "../src/secrets/secretVaultService";
import { nodeTransport, Transport } from "../src/secrets/transport";
import { createClient } from "../src/server/clients";
import { LocalServer } from "../src/server/localServer";
import { VaultLockedError } from "../src/store/secretStore";
import { PASSWORD, secretInput, unlockedStore } from "./helpers";

(globalThis as unknown as { window?: unknown }).window ??= globalThis;

class FakeWorkspace {
  private listeners = new Map<string, Set<(...args: unknown[]) => void>>();

  on(name: string, fn: (...args: unknown[]) => void): { name: string; fn: (...args: unknown[]) => void } {
    let set = this.listeners.get(name);
    if (!set) {
      set = new Set();
      this.listeners.set(name, set);
    }
    set.add(fn);
    return { name, fn };
  }

  offref(ref: { name: string; fn: (...args: unknown[]) => void }): void {
    this.listeners.get(ref.name)?.delete(ref.fn);
  }

  trigger(name: string, ...args: unknown[]): void {
    for (const fn of this.listeners.get(name) ?? []) fn(...args);
  }

  onLayoutReady(cb: () => void): void {
    cb();
  }
}

describe("SecretVaultService (Service Bus 'secrets' provider)", () => {
  it("enforces the golden security rule: never exposes getSecret or plaintext getters", async () => {
    const { store } = await unlockedStore();
    const service = createSecretVaultService({
      store,
      transport: nodeTransport,
      audit: new AuditLog(),
      limits: () => ({ timeoutMs: 5000, maxResponseBytes: 1_000_000, maxRedirects: 3 }),
    });

    expect(Object.isFrozen(service)).toBe(true);
    expect("getSecret" in service).toBe(false);
    expect(Object.keys(service).sort()).toEqual([
      "adoptPlaintextSecret",
      "createValue",
      "isLocked",
      "nameExists",
      "redact",
      "request",
      "resolveTemplateData",
      "spawnWithSecrets",
      "spawnWithSecretsAndArgs",
    ]);
  });

  it("reports lock status accurately and blocks request/spawn/adopt while locked", async () => {
    const { store } = await unlockedStore();
    await store.add(secretInput());
    const audit = new AuditLog();
    const service = createSecretVaultService({
      store,
      transport: nodeTransport,
      audit,
      limits: () => ({ timeoutMs: 5000, maxResponseBytes: 1_000_000, maxRedirects: 3 }),
    });

    expect(service.isLocked()).toBe(false);
    store.lock();
    expect(service.isLocked()).toBe(true);

    await expect(
      service.request({ method: "GET", url: "https://acme.atlassian.net/rest/api/3/myself" }, "telegram-ai-gateway"),
    ).rejects.toBeInstanceOf(VaultLockedError);

    await expect(
      service.spawnWithSecrets({ TOKEN: "{{secret:JIRA_ACME}}" }, async () => undefined, "ai-bridge"),
    ).rejects.toBeInstanceOf(VaultLockedError);

    await expect(
      service.adoptPlaintextSecret({
        ownerModuleId: "telegram-ai-gateway",
        field: "botToken",
        suggestedName: "TELEGRAM_BOT_TOKEN",
        allowedHosts: ["api.telegram.org"],
        value: "123456:ABCDEF-secret-bot-token",
      }),
    ).rejects.toBeInstanceOf(VaultLockedError);
  });

  it("resolves {{secret:NAME}} in URL path, query string, headers, and body, and redacts response with [REDACTED]", async () => {
    const { store } = await unlockedStore();
    const botToken = "99887766:AAH_super_secret_telegram_bot_token_value";
    await store.add({
      name: "TELEGRAM_BOT_TOKEN",
      type: "token",
      value: botToken,
      description: "Telegram Bot token",
      allowedHosts: ["api.telegram.org"],
      allowAnyHost: false,
      allowHttpLocalhost: false,
      placement: { headers: true, url: false, body: false }, // Even with url:false, service.request allows module URL/body placement
      approval: "never",
    });

    let capturedUrl = "";
    let capturedHeader = "";
    let capturedBody = "";
    const fakeTransport: Transport = async (req) => {
      capturedUrl = req.url.toString();
      capturedHeader = req.headers["X-Bot-Token"] ?? "";
      capturedBody = req.body ?? "";
      return {
        status: 200,
        statusText: "OK",
        headers: { "x-echo-token": botToken },
        body: JSON.stringify({ ok: true, echoed: botToken }),
        bodyEncoding: "text",
        bodyBytes: 64,
        truncated: false,
        finalUrl: req.url.toString(),
        redirects: 0,
      };
    };

    const audit = new AuditLog();
    const service = createSecretVaultService({
      store,
      transport: fakeTransport,
      audit,
      limits: () => ({ timeoutMs: 5000, maxResponseBytes: 1_000_000, maxRedirects: 3 }),
    });

    const response = await service.request(
      {
        method: "POST",
        url: "https://api.telegram.org/bot{{secret:TELEGRAM_BOT_TOKEN}}/sendMessage?auth={{secret:TELEGRAM_BOT_TOKEN}}",
        headers: { "X-Bot-Token": "{{secret:TELEGRAM_BOT_TOKEN}}" },
        body: { chat_id: 123, token_check: "{{secret:TELEGRAM_BOT_TOKEN}}" },
      },
      "telegram-ai-gateway",
    );

    expect(capturedUrl).toBe(`https://api.telegram.org/bot${botToken}/sendMessage?auth=${botToken}`);
    expect(capturedHeader).toBe(botToken);
    expect(capturedBody).toContain(botToken);

    expect(response.status).toBe(200);
    expect(response.headers["x-echo-token"]).toBe("[REDACTED]");
    expect(response.body).not.toContain(botToken);
    expect(response.body).toContain("[REDACTED]");
    expect(audit.list()[0].client).toBe("telegram-ai-gateway");
    expect(audit.list()[0].outcome).toBe("ok");
  });

  it("blocks requests when the destination host is not in allowedHosts", async () => {
    const { store } = await unlockedStore();
    await store.add({
      name: "TELEGRAM_BOT_TOKEN",
      type: "token",
      value: "99887766:AAH_super_secret_telegram_bot_token_value",
      description: "Telegram Bot token",
      allowedHosts: ["api.telegram.org"],
      allowAnyHost: false,
      allowHttpLocalhost: false,
      placement: { headers: true, url: true, body: false },
      approval: "never",
    });

    const service = createSecretVaultService({
      store,
      transport: nodeTransport,
      audit: new AuditLog(),
      limits: () => ({ timeoutMs: 5000, maxResponseBytes: 1_000_000, maxRedirects: 3 }),
    });

    await expect(
      service.request(
        {
          method: "GET",
          url: "https://evil.example.com/bot{{secret:TELEGRAM_BOT_TOKEN}}/getMe",
        },
        "telegram-ai-gateway",
      ),
    ).rejects.toThrowError(PolicyError);
  });

  it("injects resolved secrets into spawnWithSecrets without returning values", async () => {
    const { store } = await unlockedStore();
    const secretVal = "sk-ant-api03-very-secret-key-value-123456";
    await store.add({
      name: "ANTHROPIC_API_KEY",
      type: "env",
      value: secretVal,
      description: "",
      allowedHosts: ["api.anthropic.com"],
      allowAnyHost: false,
      allowHttpLocalhost: false,
      placement: { headers: true, url: false, body: false },
      approval: "never",
    });

    const service = createSecretVaultService({
      store,
      transport: nodeTransport,
      audit: new AuditLog(),
      limits: () => ({ timeoutMs: 5000, maxResponseBytes: 1_000_000, maxRedirects: 3 }),
    });

    let receivedEnv: Record<string, string> = {};
    const ret = await service.spawnWithSecrets(
      { ANTHROPIC_API_KEY: "{{secret:ANTHROPIC_API_KEY}}", PLAIN: "hello" },
      async (resolvedEnv) => {
        receivedEnv = resolvedEnv;
      },
      "ai-bridge",
    );

    expect(ret).toBeUndefined();
    expect(receivedEnv).toEqual({
      ANTHROPIC_API_KEY: secretVal,
      PLAIN: "hello",
    });
  });

  it("redacts known secrets and their encodings with [REDACTED]", async () => {
    const { store } = await unlockedStore();
    const secretVal = "super-secret-value-for-inspector-redaction";
    await store.add({
      name: "MY_SECRET",
      type: "token",
      value: secretVal,
      description: "",
      allowedHosts: ["api.example.com"],
      allowAnyHost: false,
      allowHttpLocalhost: false,
      placement: { headers: true, url: false, body: false },
      approval: "never",
    });

    const service = createSecretVaultService({
      store,
      transport: nodeTransport,
      audit: new AuditLog(),
      limits: () => ({ timeoutMs: 5000, maxResponseBytes: 1_000_000, maxRedirects: 3 }),
    });

    expect(service.redact(`Bearer ${secretVal}`)).toBe("Bearer [REDACTED]");
  });

  it("adopts plaintext secrets without overwriting existing secrets (appending _2, _3)", async () => {
    const { store } = await unlockedStore();
    const service = createSecretVaultService({
      store,
      transport: nodeTransport,
      audit: new AuditLog(),
      limits: () => ({ timeoutMs: 5000, maxResponseBytes: 1_000_000, maxRedirects: 3 }),
    });

    const first = await service.adoptPlaintextSecret({
      ownerModuleId: "telegram-ai-gateway",
      field: "botToken",
      suggestedName: "TELEGRAM_BOT_TOKEN",
      allowedHosts: ["api.telegram.org"],
      value: "token-one-value-111111111111",
    });
    expect(first.placeholder).toBe("{{secret:TELEGRAM_BOT_TOKEN}}");

    // Re-adopting the exact same value returns the existing placeholder
    const same = await service.adoptPlaintextSecret({
      ownerModuleId: "telegram-ai-gateway",
      field: "botToken",
      suggestedName: "TELEGRAM_BOT_TOKEN",
      allowedHosts: ["api.telegram.org"],
      value: "token-one-value-111111111111",
    });
    expect(same.placeholder).toBe("{{secret:TELEGRAM_BOT_TOKEN}}");

    // Adopting a different value under the same suggestedName creates _2 instead of overwriting
    const second = await service.adoptPlaintextSecret({
      ownerModuleId: "telegram-ai-gateway",
      field: "secondaryToken",
      suggestedName: "TELEGRAM_BOT_TOKEN",
      allowedHosts: ["api.telegram.org"],
      value: "token-two-value-222222222222",
    });
    expect(second.placeholder).toBe("{{secret:TELEGRAM_BOT_TOKEN_2}}");
    expect(store.get("TELEGRAM_BOT_TOKEN")?.value).toBe("token-one-value-111111111111");
    expect(store.get("TELEGRAM_BOT_TOKEN_2")?.value).toBe("token-two-value-222222222222");
  });
});

describe("SecretAdoptionCoordinator (secret-holder:* migration)", () => {
  it("waits while the vault is locked and adopts plaintext tokens as soon as unlocked", async () => {
    const { store } = await unlockedStore();
    const audit = new AuditLog();
    const service = createSecretVaultService({
      store,
      transport: nodeTransport,
      audit,
      limits: () => ({ timeoutMs: 5000, maxResponseBytes: 1_000_000, maxRedirects: 3 }),
    });

    const adoptedEvents: Array<{ ownerModuleId: string; field: string; placeholder: string }> = [];
    const coordinator = new SecretAdoptionCoordinator({
      service,
      audit,
      isUnlocked: () => store.isUnlocked,
      onAdopted: (evt) => adoptedEvents.push(evt),
    });

    let holderSettings: Record<string, string> = {
      botToken: "887766:AAH-plaintext-telegram-token",
      alreadyAdopted: "{{secret:EXISTING_KEY}}",
    };

    const holder: SecretHolderService = {
      inspectPlaintextSecrets: () =>
        Object.entries(holderSettings).map(([field, value]) => ({
          field,
          suggestedName: field === "botToken" ? "TELEGRAM_BOT_TOKEN" : "OTHER_TOKEN",
          allowedHosts: ["api.telegram.org"],
          value,
        })),
      replaceWithPlaceholder: async (field, placeholder) => {
        holderSettings = { ...holderSettings, [field]: placeholder };
      },
    };

    const fakeApi = {
      getService: <T>(name: string): T | undefined =>
        (name === "secret-holder:telegram-ai-gateway" ? (holder as unknown as T) : undefined),
    } as unknown as AIEcosystemAPI;

    // 1. Lock the vault and trigger inspection: nothing should be replaced yet
    store.lock();
    const lockedCount = await coordinator.inspectService(fakeApi, "secret-holder:telegram-ai-gateway");
    expect(lockedCount).toBe(0);
    expect(holderSettings.botToken).toBe("887766:AAH-plaintext-telegram-token");

    // 2. Unlock the vault and scan: plaintext token is migrated to encrypted store and replaced with placeholder
    await store.unlock(PASSWORD);
    const unlockedCount = await coordinator.scanAll(fakeApi, ["secret-holder:telegram-ai-gateway"]);
    expect(unlockedCount).toBe(1);
    expect(holderSettings.botToken).toBe("{{secret:TELEGRAM_BOT_TOKEN}}");
    expect(holderSettings.alreadyAdopted).toBe("{{secret:EXISTING_KEY}}");
    expect(store.get("TELEGRAM_BOT_TOKEN")?.value).toBe("887766:AAH-plaintext-telegram-token");
    expect(adoptedEvents).toEqual([
      {
        ownerModuleId: "telegram-ai-gateway",
        field: "botToken",
        placeholder: "{{secret:TELEGRAM_BOT_TOKEN}}",
      },
    ]);
  });
});

describe("EcosystemConnector & Transition Mode handoff", () => {
  let server: LocalServer | null = null;
  const PORT = 27193;

  beforeAll(async () => {
    // Ensure clean state
  });

  afterAll(async () => {
    await server?.stop();
  });

  it("starts in Transition Mode when AI Ecosystem is absent, and hands off port 27150 when ai-ecosystem:ready fires", async () => {
    const { store } = await unlockedStore();
    await store.add(secretInput());
    const broker = new Broker(
      store,
      nodeTransport,
      async () => true,
      new AuditLog(),
      () => ({ timeoutMs: 2000, maxResponseBytes: 100_000, maxRedirects: 0 }),
    );
    const client = await createClient("Test", { mode: "all" });

    server = new LocalServer({
      port: PORT,
      broker,
      version: "2.0.0",
      vault: { id: "v1", name: "Cofre" },
      authenticate: async (tk) => (tk === client.token ? { id: "c1", name: "Test", access: { mode: "all" } } : null),
    });

    const workspaceEvents = new FakeWorkspace();
    const fakeApp = {
      workspace: workspaceEvents,
      plugins: {
        getPlugin: () => undefined,
      },
    } as unknown as App;

    let missingCalled = false;
    let connectedApi: AIEcosystemAPI | undefined;
    let registeredModule: ModuleRegistration | undefined;
    let serverWasStoppedBeforeRegister = false;

    const connector = new EcosystemConnector({
      app: fakeApp,
      registration: () => ({
        id: MODULE_ID,
        name: "Environment Keys",
        version: "2.0.0",
        apiVersion: 1,
      }),
      timeoutMs: 10,
      onMissing: async () => {
        missingCalled = true;
        await server!.start();
      },
      onBeforeConnect: async () => {
        if (server?.running) {
          await server.stop();
        }
      },
      onConnected: (api) => {
        connectedApi = api;
      },
    });

    connector.start();
    await new Promise((r) => setTimeout(r, 30));

    expect(missingCalled).toBe(true);
    expect(connector.status).toBe("missing");
    expect(server.running).toBe(true);

    // Check Transition Mode health endpoint on the legacy server
    const healthRes = await fetch(`http://127.0.0.1:${PORT}/health`);
    const healthJson = (await healthRes.json()) as { status: string; mode: string; version: string };
    expect(healthJson.status).toBe("ok");
    expect(healthJson.mode).toBe("transition");
    expect(healthJson.version).toBe("2.0.0");

    // Simulate AI Ecosystem becoming active and firing ai-ecosystem:ready
    const serviceListeners = new Set<ServiceChangeListener>();
    const mockApi: AIEcosystemAPI = {
      apiVersion: 1,
      version: "1.0.0",
      registerModule: (reg) => {
        serverWasStoppedBeforeRegister = !(server?.running ?? false);
        registeredModule = reg;
        return () => {
          registeredModule = undefined;
        };
      },
      unregisterModule: () => undefined,
      updateTools: () => undefined,
      updatePrompts: () => undefined,
      registerService: () => () => undefined,
      unregisterService: () => undefined,
      getService: () => undefined,
      onServiceChange: (fn) => {
        serviceListeners.add(fn);
        return () => serviceListeners.delete(fn);
      },
      getServerStatus: () => ({ running: true, port: PORT, usingAlternativePort: false }),
      importClients: async () => ({ added: 1, total: 1 }),
      logActivity: () => undefined,
    };

    workspaceEvents.trigger("ai-ecosystem:ready", mockApi);
    await new Promise((r) => setTimeout(r, 30));

    expect(serverWasStoppedBeforeRegister).toBe(true);
    expect(server.running).toBe(false);
    expect(connector.status).toBe("connected");
    expect(connectedApi).toBe(mockApi);
    expect(registeredModule?.id).toBe("environment-variables");

    // Verify the port is now free for AI Ecosystem to bind
    const probeServer = http.createServer();
    await new Promise<void>((resolve, reject) => {
      probeServer.once("error", reject);
      probeServer.listen(PORT, "127.0.0.1", () => resolve());
    });
    expect((probeServer.address() as AddressInfo).port).toBe(PORT);
    await new Promise<void>((resolve) => probeServer.close(() => resolve()));

    connector.stop();
  });
});
