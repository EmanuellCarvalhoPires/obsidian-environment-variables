import { describe, expect, it } from "vitest";
import { WrongPasswordError } from "../src/crypto/vaultFile";
import { SecretStore, VaultLockedError, passwordStrength } from "../src/store/secretStore";
import { MemoryIO, PASSWORD, secretInput, unlockedStore } from "./helpers";

describe("SecretStore", () => {
  it("never writes values in plain text", async () => {
    const { store, io } = await unlockedStore();
    await store.add(secretInput());
    expect(io.content).not.toBeNull();
    expect(io.content).not.toContain("super-secret");
    expect(io.content).not.toContain("JIRA_ACME");
    expect(io.content).not.toContain("bot@acme.com");
  });

  it("round-trips after lock and unlock", async () => {
    const { store } = await unlockedStore();
    await store.add(secretInput());
    store.lock();
    expect(() => store.list()).toThrow(VaultLockedError);
    expect(store.names()).toEqual([]);
    await store.unlock(PASSWORD);
    expect(store.get("JIRA_ACME")?.value).toBe(secretInput().value);
  });

  it("rejects a wrong password", async () => {
    const { store } = await unlockedStore();
    store.lock();
    await expect(store.unlock("wrong password here")).rejects.toBeInstanceOf(WrongPasswordError);
    expect(store.isUnlocked).toBe(false);
  });

  it("uses a fresh IV on every save", async () => {
    const { store, io } = await unlockedStore();
    await store.add(secretInput());
    const first = JSON.parse(io.content!).cipher.iv;
    await store.add(secretInput({ name: "OTHER" }));
    expect(JSON.parse(io.content!).cipher.iv).not.toBe(first);
  });

  it("changes the master password", async () => {
    const { store } = await unlockedStore();
    await store.add(secretInput());
    await store.changePassword(PASSWORD, "a brand new master password");
    store.lock();
    await expect(store.unlock(PASSWORD)).rejects.toBeInstanceOf(WrongPasswordError);
    await store.unlock("a brand new master password");
    expect(store.list()).toHaveLength(1);
  });

  it("validates input", async () => {
    const { store } = await unlockedStore();
    await expect(store.add(secretInput({ name: "bad-name" }))).rejects.toThrow();
    await expect(store.add(secretInput({ value: "" }))).rejects.toThrow();
    await expect(store.add(secretInput({ username: undefined }))).rejects.toThrow();
    await store.add(secretInput());
    await expect(store.add(secretInput())).rejects.toThrow(/already exists/);
  });

  it("keeps the value when an update omits it", async () => {
    const { store } = await unlockedStore();
    const rec = await store.add(secretInput());
    await store.update(rec.id, { description: "changed", value: undefined });
    expect(store.get("JIRA_ACME")?.value).toBe(secretInput().value);
  });

  it("requires an 8-character master password", async () => {
    const store = new SecretStore(new MemoryIO(), { iterations: 1000 });
    await expect(store.create("short")).rejects.toThrow(/8/);
    expect(passwordStrength("short")).toBe(0);
    expect(passwordStrength("Longer-Password-123!")).toBeGreaterThanOrEqual(3);
  });
  it("creates a vault and returns a recovery key", async () => {
    const io = new MemoryIO();
    const store = new SecretStore(io, { iterations: 1000 });
    const recoveryKey = await store.create("correct horse battery staple");
    expect(recoveryKey).toMatch(/^[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/);
    expect(store.isUnlocked).toBe(true);
    await store.add(secretInput());

    // Recover using recovery code and change password
    const newRecovery = await store.recoverWithCode(recoveryKey, "a-new-master-password");
    expect(newRecovery).toBeDefined();
    store.lock();
    await store.unlock("a-new-master-password");
    expect(store.list()).toHaveLength(1);
    expect(store.get("JIRA_ACME")?.value).toBe(secretInput().value);
  });

  it("resets a vault", async () => {
    let deleted = false;
    const io = {
      content: "some-encrypted-stuff" as string | null,
      async read() { return this.content; },
      async write(c: string) { this.content = c; },
      async delete() { this.content = null; deleted = true; }
    };
    const store = new SecretStore(io as any, { iterations: 1000 });
    await store.resetVault();
    expect(deleted).toBe(true);
    expect(await store.exists()).toBe(false);
  });
});
