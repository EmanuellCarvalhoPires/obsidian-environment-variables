import { describe, expect, it } from "vitest";
import { AuditLog } from "../src/audit/auditLog";
import { createSecretVaultService } from "../src/secrets/secretVaultService";
import { Transport } from "../src/secrets/transport";
import { VaultLockedError } from "../src/store/secretStore";
import { secretInput, unlockedStore } from "./helpers";

// Fictitious values: never real credentials.
const BASIC_VALUE = "fake-basic-token-value-0001";
const BEARER_VALUE = "fake-bearer-token-value-0002";
const USERNAME = "bot-user@example.test";

const noTransport: Transport = () => Promise.reject(new Error("no request expected"));

async function serviceWithSecrets() {
  const { store } = await unlockedStore();
  await store.add(secretInput({ name: "JIRA_ACME", type: "basic", username: USERNAME, value: BASIC_VALUE }));
  await store.add(
    secretInput({
      name: "GITHUB_TOKEN",
      type: "bearer",
      username: undefined,
      value: BEARER_VALUE,
      allowedHosts: ["api.github.com"],
      approval: "writes",
    }),
  );
  await store.add(
    secretInput({ name: "ANY_HOST", type: "token", username: undefined, value: "fake-any-host-value-0003", allowedHosts: [], allowAnyHost: true }),
  );
  await store.addValue({ name: "SOME_VALUE", kind: "texto", value: "fake-config-value-0004", description: "", allowedHosts: [] });
  const audit = new AuditLog();
  const service = createSecretVaultService({
    store,
    transport: noTransport,
    audit,
    limits: () => ({ timeoutMs: 5000, maxResponseBytes: 1_000_000, maxRedirects: 3 }),
  });
  return { store, audit, service };
}

describe("secrets service: listSecretMetadata", () => {
  it("lists names, types and hosts of the secrets, sorted by name, without values, ids or usernames", async () => {
    const { store, service } = await serviceWithSecrets();
    const list = await service.listSecretMetadata!("ai-git-tools");

    expect(list).toEqual([
      { name: "ANY_HOST", type: "token", hasUsername: false, allowedHosts: [], allowAnyHost: true, approval: "never" },
      { name: "GITHUB_TOKEN", type: "bearer", hasUsername: false, allowedHosts: ["api.github.com"], allowAnyHost: false, approval: "writes" },
      { name: "JIRA_ACME", type: "basic", hasUsername: true, allowedHosts: ["acme.atlassian.net"], allowAnyHost: false, approval: "never" },
    ]);

    const text = JSON.stringify(list);
    for (const record of store.list()) {
      expect(text).not.toContain(record.value);
      expect(text).not.toContain(record.id);
    }
    expect(text).not.toContain(USERNAME);
    expect(text).not.toContain("SOME_VALUE");
    expect(text).not.toContain("fake-config-value-0004");
    for (const item of list) expect(Object.keys(item).sort()).toEqual(["allowAnyHost", "allowedHosts", "approval", "hasUsername", "name", "type"]);
  });

  it("reports full access as any host", async () => {
    const { store, service } = await serviceWithSecrets();
    await store.add(secretInput({ name: "FULL", type: "token", username: undefined, value: "fake-full-access-0005", fullAccess: true }));
    const full = (await service.listSecretMetadata!("ai-git-tools")).find((s) => s.name === "FULL");
    expect(full?.allowAnyHost).toBe(true);
  });

  it("returns a copy of the hosts: changing it does not touch the store", async () => {
    const { store, service } = await serviceWithSecrets();
    const list = await service.listSecretMetadata!("ai-git-tools");
    list.find((s) => s.name === "JIRA_ACME")!.allowedHosts.push("evil.example.test");
    expect(store.get("JIRA_ACME")?.allowedHosts).toEqual(["acme.atlassian.net"]);
  });

  it("logs the caller in the audit log", async () => {
    const { audit, service } = await serviceWithSecrets();
    await service.listSecretMetadata!("ai-git-tools");
    const last = audit.list().find((e) => e.action === "list");
    expect(last).toMatchObject({ client: "ai-git-tools", action: "list", secrets: [], outcome: "ok" });
  });

  it("rejects with VaultLockedError while locked, and logs it", async () => {
    const { store, audit, service } = await serviceWithSecrets();
    store.lock();
    await expect(service.listSecretMetadata!("ai-git-tools")).rejects.toBeInstanceOf(VaultLockedError);
    expect(audit.list().find((e) => e.action === "list")).toMatchObject({ client: "ai-git-tools", outcome: "locked" });
  });
});
