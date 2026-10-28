import { describe, expect, it, vi } from "vitest";
import { AuditLog } from "../src/audit/auditLog";
import { Approver, Broker } from "../src/secrets/broker";
import { nodeTransport, Transport } from "../src/secrets/transport";
import { ClientContext } from "../src/server/clients";
import { executeMcpToolCall } from "../src/server/mcp";
import { secretInput, unlockedStore } from "./helpers";

// Mock minimal Obsidian environment required by main.ts
vi.mock("obsidian", () => {
  class Plugin {
    app: unknown;
    manifest: unknown;
    constructor(app: unknown, manifest: unknown) {
      this.app = app;
      this.manifest = manifest;
    }
  }
  class EditorSuggest {
    app: unknown;
    constructor(app: unknown) {
      this.app = app;
    }
  }
  class AbstractInputSuggest {
    app: unknown;
    textInputEl: unknown;
    constructor(app: unknown, textInputEl: unknown) {
      this.app = app;
      this.textInputEl = textInputEl;
    }
  }
  return {
    Plugin,
    EditorSuggest,
    AbstractInputSuggest,
    Modal: class {},
    Notice: class {},
    Setting: class {},
    SuggestModal: class {},
    ButtonComponent: class {},
    TextComponent: class {},
    ToggleComponent: class {},
    PluginSettingTab: class {},
    ItemView: class {},
    WorkspaceLeaf: class {},
    Events: class {},
    setIcon: () => undefined,
    setTooltip: () => undefined,
    normalizePath: (p: string) => p,
    requestUrl: async () => ({ status: 200, json: {} }),
    editorLivePreviewField: {},
    FileSystemAdapter: class {},
    TFile: class {},
    TFolder: class {},
    Editor: class {},
  };
});

const { default: EnvironmentVariablesPlugin } = await import("../src/main");

const noopApprover: Approver = async () => true;
const testLimits = () => ({ timeoutMs: 5000, maxResponseBytes: 1_000_000, maxRedirects: 3 });

describe("Client Fallback & Least Privilege (Items 13 and 17)", () => {
  describe("resolveHubClient fallback in main.ts", () => {
    it("assigns access { mode: 'some', secretIds: [] } to unknown clients", () => {
      const plugin = Object.create(EnvironmentVariablesPlugin.prototype) as any;
      plugin.data = {
        clients: [
          {
            id: "known-1",
            name: "Known Agent",
            tokenHash: "hash1",
            hint: "evc_know",
            createdAt: new Date().toISOString(),
            access: { mode: "all" },
          },
        ],
      };
      plugin.scheduleSave = vi.fn();

      // Unknown client by ID and name
      const resolvedUnknown = plugin.resolveHubClient({ id: "unknown-id", name: "Unknown Agent" });
      expect(resolvedUnknown).toEqual({
        id: "unknown-id",
        name: "Unknown Agent",
        access: { mode: "some", secretIds: [] },
      });
      expect(resolvedUnknown.access.mode).not.toBe("all");

      // Default values when id or name are omitted
      const resolvedEmpty = plugin.resolveHubClient({ id: "", name: "" });
      expect(resolvedEmpty).toEqual({
        id: "ecosystem-client",
        name: "AI Ecosystem Client",
        access: { mode: "some", secretIds: [] },
      });
      expect(resolvedEmpty.access.mode).not.toBe("all");
    });

    it("preserves access mode 'all' for registered clients", () => {
      const plugin = Object.create(EnvironmentVariablesPlugin.prototype) as any;
      plugin.data = {
        clients: [
          {
            id: "known-1",
            name: "Known Agent",
            tokenHash: "hash1",
            hint: "evc_know",
            createdAt: new Date().toISOString(),
            access: { mode: "all" },
          },
        ],
      };
      plugin.scheduleSave = vi.fn();

      const resolvedKnown = plugin.resolveHubClient({ id: "known-1", name: "Known Agent" });
      expect(resolvedKnown.id).toBe("known-1");
      expect(resolvedKnown.access).toEqual({ mode: "all" });
      expect(plugin.scheduleSave).toHaveBeenCalled();
    });

    it("keeps localClient with access mode 'all' for the Obsidian panel", () => {
      const plugin = new (EnvironmentVariablesPlugin as any)({}, {});
      expect(plugin.localClient).toEqual({
        id: "obsidian",
        name: "Obsidian",
        access: { mode: "all" },
      });
    });
  });

  describe("Broker least-privilege enforcement", () => {
    it("returns empty list for unregistered client and blocks {{secret:NAME}} before inserting value", async () => {
      const { store } = await unlockedStore();
      await store.add(
        secretInput({
          name: "API_KEY",
          type: "token",
          value: "super-secret-api-key-9999",
          allowedHosts: ["api.example.com"],
          allowAnyHost: false,
          fullAccess: false,
        }),
      );

      const transportMock = vi.fn<Transport>(() => Promise.reject(new Error("transport should not be called")));
      const audit = new AuditLog();
      const broker = new Broker(store, transportMock, noopApprover, audit, testLimits);

      const unregisteredClient: ClientContext = {
        id: "unknown-client",
        name: "Unknown Client",
        access: { mode: "some", secretIds: [] },
      };

      // When calling listSecrets
      const listResult = broker.listSecrets(unregisteredClient);
      expect(listResult.ok).toBe(true);
      if (listResult.ok) {
        expect(listResult.secrets).toEqual([]);
      }

      // When attempting to use {{secret:NAME}} in execute
      const execResult = await broker.execute(
        {
          method: "GET",
          url: "https://api.example.com/data",
          headers: { Authorization: "Bearer {{secret:API_KEY}}" },
        },
        unregisteredClient,
      );

      expect(execResult.ok).toBe(false);
      if (!execResult.ok) {
        expect(execResult.error.code).toBe("secret_not_permitted");
      }
      // Transport was never called (rejected before value lookup/insertion)
      expect(transportMock).not.toHaveBeenCalled();
    });

    it("allows registered client with mode 'all' to list and use secrets", async () => {
      const { store } = await unlockedStore();
      await store.add(
        secretInput({
          name: "API_KEY",
          type: "token",
          value: "super-secret-api-key-9999",
          allowedHosts: ["api.example.com"],
          allowAnyHost: false,
          fullAccess: false,
        }),
      );

      let capturedAuth: string | undefined;
      const mockTransport: Transport = async (req) => {
        capturedAuth = req.headers.authorization ?? req.headers.Authorization;
        return {
          status: 200,
          statusText: "OK",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ok: true }),
          bodyEncoding: "text",
          bodyBytes: 11,
          truncated: false,
          finalUrl: req.url.toString(),
          redirects: 0,
        };
      };

      const audit = new AuditLog();
      const broker = new Broker(store, mockTransport, noopApprover, audit, testLimits);

      const registeredClient: ClientContext = {
        id: "registered-client",
        name: "Registered Client",
        access: { mode: "all" },
      };

      const listResult = broker.listSecrets(registeredClient);
      expect(listResult.ok).toBe(true);
      if (listResult.ok) {
        expect(listResult.secrets.length).toBe(1);
        expect(listResult.secrets[0].name).toBe("API_KEY");
      }

      const execResult = await broker.execute(
        {
          method: "GET",
          url: "https://api.example.com/data",
          headers: { Authorization: "Bearer {{secret:API_KEY}}" },
        },
        registeredClient,
      );

      expect(execResult.ok).toBe(true);
      expect(capturedAuth).toBe("Bearer super-secret-api-key-9999");
    });
  });

  describe("list_secrets shape: compact vs detailed (Item 13)", () => {
    it("returns only name, type, hosts, fullAccess when detail is false or omitted", async () => {
      const { store } = await unlockedStore();
      await store.add(
        secretInput({
          name: "REGULAR_SECRET",
          type: "bearer",
          username: "should-not-leak@test.com",
          value: "secret-value-12345",
          allowedHosts: ["api.example.com"],
          fullAccess: false,
        }),
      );
      await store.add(
        secretInput({
          name: "FULL_ACCESS_SECRET",
          type: "token",
          username: "should-not-leak-either@test.com",
          value: "secret-value-67890",
          allowedHosts: ["full.example.com"],
          fullAccess: true,
        }),
      );

      const audit = new AuditLog();
      const broker = new Broker(store, nodeTransport, noopApprover, audit, testLimits);
      const client: ClientContext = { id: "c1", name: "Client", access: { mode: "all" } };

      // Omitted detail (defaults to false)
      const resDefault = broker.listSecrets(client);
      expect(resDefault.ok).toBe(true);
      if (resDefault.ok) {
        expect(resDefault.secrets.length).toBe(2);
        for (const item of resDefault.secrets) {
          const keys = Object.keys(item).sort();
          expect(keys).toEqual(["fullAccess", "hosts", "name", "type"]);
          expect(item).not.toHaveProperty("value");
          expect(item).not.toHaveProperty("username");
          expect(item).not.toHaveProperty("id");
          expect(item).not.toHaveProperty("description");
          expect(item).not.toHaveProperty("placement");
          expect(item).not.toHaveProperty("approval");
        }

        const regular = resDefault.secrets.find((s) => s.name === "REGULAR_SECRET");
        expect(regular).toEqual({
          name: "REGULAR_SECRET",
          type: "bearer",
          hosts: ["api.example.com"],
          fullAccess: false,
        });

        const full = resDefault.secrets.find((s) => s.name === "FULL_ACCESS_SECRET");
        expect(full).toEqual({
          name: "FULL_ACCESS_SECRET",
          type: "token",
          hosts: ["full.example.com"],
          fullAccess: true,
        });

        const serialized = JSON.stringify(resDefault.secrets);
        expect(serialized).not.toContain("secret-value");
        expect(serialized).not.toContain("should-not-leak");
      }

      // Explicit detail: false
      const resFalse = broker.listSecrets(client, false);
      expect(resFalse.ok).toBe(true);
      if (resFalse.ok) {
        expect(resFalse.secrets).toEqual(resDefault.ok ? resDefault.secrets : []);
      }
    });

    it("returns complete SecretMetadata fields when detail is true, never value, username or id", async () => {
      const { store } = await unlockedStore();
      await store.add(
        secretInput({
          name: "DETAILED_SECRET",
          type: "basic",
          username: "user-to-omit@test.com",
          value: "sensitive-token-9999",
          description: "A detailed test secret",
          allowedHosts: ["detailed.example.com"],
          approval: "writes",
          fullAccess: false,
        }),
      );

      const audit = new AuditLog();
      const broker = new Broker(store, nodeTransport, noopApprover, audit, testLimits);
      const client: ClientContext = { id: "c1", name: "Client", access: { mode: "all" } };

      const res = broker.listSecrets(client, true);
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.secrets.length).toBe(1);
        const item = res.secrets[0];
        expect(item.name).toBe("DETAILED_SECRET");
        expect(item.type).toBe("basic");
        expect(item.description).toBe("A detailed test secret");
        expect(item.allowedHosts).toEqual(["detailed.example.com"]);
        expect(item.approval).toBe("writes");
        expect(item.placement).toEqual({ headers: true, url: false, body: false });
        expect(item).toHaveProperty("createdAt");
        expect(item).toHaveProperty("updatedAt");

        // Never value, username, or id
        expect(item).not.toHaveProperty("value");
        expect(item).not.toHaveProperty("username");
        expect(item).not.toHaveProperty("id");

        const serialized = JSON.stringify(res.secrets);
        expect(serialized).not.toContain("sensitive-token-9999");
        expect(serialized).not.toContain("user-to-omit@test.com");
      }
    });
  });

  describe("Audit log on list (Item 13)", () => {
    it("does not create an audit entry on successful listing", async () => {
      const { store } = await unlockedStore();
      await store.add(secretInput({ name: "TEST_SECRET" }));
      const audit = new AuditLog();
      const broker = new Broker(store, nodeTransport, noopApprover, audit, testLimits);
      const client: ClientContext = { id: "c1", name: "ClientAuditTest", access: { mode: "all" } };

      // Success without detail
      broker.listSecrets(client, false);
      expect(audit.list().some((e) => e.action === "list")).toBe(false);

      // Success with detail: true
      broker.listSecrets(client, true);
      expect(audit.list().some((e) => e.action === "list")).toBe(false);
    });

    it("still creates an audit entry when vault is locked", async () => {
      const { store } = await unlockedStore();
      await store.add(secretInput({ name: "TEST_SECRET" }));
      const audit = new AuditLog();
      const broker = new Broker(store, nodeTransport, noopApprover, audit, testLimits);
      const client: ClientContext = { id: "c1", name: "ClientLockedAuditTest", access: { mode: "all" } };

      store.lock();

      const result = broker.listSecrets(client);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("locked");
      }

      const listAudits = audit.list().filter((e) => e.action === "list");
      expect(listAudits.length).toBe(1);
      expect(listAudits[0]).toMatchObject({
        client: "ClientLockedAuditTest",
        action: "list",
        outcome: "locked",
      });
    });
  });

  describe("MCP tool: list_secrets with detail parameter", () => {
    it("accepts detail boolean and returns compact or full metadata accordingly", async () => {
      const { store } = await unlockedStore();
      await store.add(
        secretInput({
          name: "MCP_SECRET",
          type: "bearer",
          username: "mcp-user@test.com",
          value: "mcp-secret-value-4321",
          description: "Description of MCP secret",
          allowedHosts: ["mcp.example.com"],
        }),
      );

      const audit = new AuditLog();
      const broker = new Broker(store, nodeTransport, noopApprover, audit, testLimits);
      const client: ClientContext = { id: "mcp-client", name: "MCP Client", access: { mode: "all" } };

      // Default (no detail specified)
      const resDefault = await executeMcpToolCall("list_secrets", {}, { broker, client });
      expect(resDefault.isError).toBe(false);
      const defaultContent = JSON.parse(resDefault.content[0].text);
      expect(defaultContent.ok).toBe(true);
      expect(defaultContent.secrets[0]).toEqual({
        name: "MCP_SECRET",
        type: "bearer",
        hosts: ["mcp.example.com"],
        fullAccess: false,
      });

      // detail: true
      const resDetail = await executeMcpToolCall("list_secrets", { detail: true }, { broker, client });
      expect(resDetail.isError).toBe(false);
      const detailContent = JSON.parse(resDetail.content[0].text);
      expect(detailContent.ok).toBe(true);
      expect(detailContent.secrets[0].description).toBe("Description of MCP secret");
      expect(detailContent.secrets[0]).not.toHaveProperty("value");
      expect(detailContent.secrets[0]).not.toHaveProperty("username");

      // Invalid detail argument
      const resInvalid = await executeMcpToolCall("list_secrets", { detail: "yes" }, { broker, client });
      expect(resInvalid.isError).toBe(true);
      expect(JSON.parse(resInvalid.content[0].text).error.code).toBe("invalid_argument");
    });
  });

  describe("AI Ecosystem Hub routes with unregistered client fallback", () => {
    it("returns empty secrets and refuses {{secret:NAME}} requests for unregistered client", async () => {
      const { store } = await unlockedStore();
      await store.add(
        secretInput({
          name: "HUB_SECRET",
          type: "token",
          value: "hub-secret-value-8888",
          allowedHosts: ["hub.example.com"],
        }),
      );

      const transportMock = vi.fn<Transport>(() => Promise.reject(new Error("unexpected transport call")));
      const audit = new AuditLog();
      const broker = new Broker(store, transportMock, noopApprover, audit, testLimits);

      const plugin = Object.create(EnvironmentVariablesPlugin.prototype) as any;
      plugin.manifest = { version: "2.3.1" };
      plugin.data = {
        clients: [], // No registered clients
      };
      plugin.broker = broker;
      plugin.tools = { enabled: () => false };
      plugin.scheduleSave = vi.fn();

      const registration = plugin.buildModuleRegistration();
      const secretsRoute = registration.routes.find((r: any) => r.path === "/secrets" && r.method === "GET");
      const requestRoute = registration.routes.find((r: any) => r.path === "/request" && r.method === "POST");

      expect(secretsRoute).toBeDefined();
      expect(requestRoute).toBeDefined();

      const unregisteredHubRequest = {
        method: "GET" as const,
        path: "/secrets",
        fullPath: "/secrets",
        params: {},
        query: {},
        headers: {},
        body: {},
        rawBody: "",
        client: { id: "unknown-ai-module", name: "Unknown AI Module" },
      };

      // Calling /secrets route returns empty list
      const secretsResponse = secretsRoute.handler(unregisteredHubRequest);
      expect(secretsResponse.status).toBe(200);
      expect(secretsResponse.body).toEqual({ ok: true, secrets: [] });

      // Calling /request route with secret placeholder is rejected
      const requestResponse = await requestRoute.handler({
        ...unregisteredHubRequest,
        method: "POST" as const,
        path: "/request",
        fullPath: "/request",
        body: {
          method: "GET",
          url: "https://hub.example.com/api",
          headers: { Authorization: "Bearer {{secret:HUB_SECRET}}" },
        },
      });

      expect(requestResponse.status).toBe(403);
      expect(requestResponse.body.ok).toBe(false);
      expect(requestResponse.body.error.code).toBe("secret_not_permitted");
      expect(transportMock).not.toHaveBeenCalled();
    });
  });
});
