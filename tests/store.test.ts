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

  it("requires a 12-character master password", async () => {
    const store = new SecretStore(new MemoryIO(), { iterations: 1000 });
    await expect(store.create("short")).rejects.toThrow(/12/);
    expect(passwordStrength("short")).toBe(0);
    expect(passwordStrength("Longer-Password-123!")).toBeGreaterThanOrEqual(3);
  });
});
