import { describe, expect, it } from "vitest";
import {
  decryptVault,
  deriveKey,
  encryptPayload,
  fromBase64,
  randomBytes,
  toBase64,
  UnsupportedKdfError,
  WrongPasswordError,
} from "../src/crypto/vaultFile";
import { isValidPattern, parsePattern, urlMatchesPattern, wildcardRisk } from "../src/engine/hosts";
import { utf8ToBase64 } from "../src/engine/placeholders";
import { PolicyError, prepareRequest } from "../src/engine/prepare";
import { createRedactor, REDACTED } from "../src/engine/redact";
import { SecretStore } from "../src/store/secretStore";
import { SecretRecord } from "../src/store/types";
import { MemoryIO, PASSWORD, secretInput, unlockedStore } from "./helpers";

function record(overrides: Partial<SecretRecord> = {}): SecretRecord {
  return { ...secretInput(), id: "id1", createdAt: "", updatedAt: "", ...overrides } as SecretRecord;
}
const lookupOf = (...secrets: SecretRecord[]) => (name: string) => secrets.find((s) => s.name === name);
const H = { Authorization: "{{basic:JIRA_ACME}}" };

function code(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    if (e instanceof PolicyError) return e.code;
    throw e;
  }
  return undefined;
}

// ---------- 1. redirects ----------

describe("redirect revalidation", () => {
  it("follows only to destinations allowed for the secret", () => {
    const s = record({ allowedHosts: ["*.example.com"] });
    const p = prepareRequest({ url: "https://api.example.com/x", headers: H }, lookupOf(s));
    expect(p.redirectDecision(new URL("https://files.example.com/y"), 302)).toBe("follow");
    expect(p.redirectDecision(new URL("https://evil.com/y"), 302)).toBe("stop");
    expect(p.redirectDecision(new URL("http://api.example.com/y"), 302)).toBe("stop");
  });

  it("stops a same-origin redirect that leaves the allowed path prefix", () => {
    const s = record({ allowedHosts: ["api.example.com/v1/workspaces/123/*"] });
    const p = prepareRequest({ url: "https://api.example.com/v1/workspaces/123/items", headers: H }, lookupOf(s));
    expect(p.redirectDecision(new URL("https://api.example.com/v1/workspaces/123/items/2"), 301)).toBe("follow");
    expect(p.redirectDecision(new URL("https://api.example.com/v1/workspaces/999/items"), 301)).toBe("stop");
  });

  it("never changes origin when a secret is in the URL, or in a body a 307/308 would re-send", () => {
    const inUrl = record({ allowedHosts: ["*.example.com"], placement: { headers: true, url: true, body: false } });
    const p1 = prepareRequest({ url: "https://a.example.com/x?t={{secret:JIRA_ACME}}" }, lookupOf(inUrl));
    expect(p1.redirectDecision(new URL("https://b.example.com/x"), 302)).toBe("stop");
    expect(p1.redirectDecision(new URL("https://a.example.com/other"), 302)).toBe("follow");

    const inBody = record({ allowedHosts: ["*.example.com"], placement: { headers: true, url: false, body: true } });
    const p2 = prepareRequest({ method: "POST", url: "https://a.example.com/x", body: "{{secret:JIRA_ACME}}" }, lookupOf(inBody));
    expect(p2.redirectDecision(new URL("https://b.example.com/x"), 307)).toBe("stop");
    expect(p2.redirectDecision(new URL("https://b.example.com/x"), 303)).toBe("follow"); // 303 drops the body
  });

  it("follows freely when no secret is used", () => {
    const p = prepareRequest({ url: "https://example.com/" }, lookupOf());
    expect(p.redirectDecision(new URL("https://anywhere.org/"), 302)).toBe("follow");
  });
});

// ---------- 2. host policy ----------

describe("host policy", () => {
  const u = (s: string) => new URL(s);

  it("flags wildcards on shared platforms and rejects wildcards on public suffixes", () => {
    expect(wildcardRisk("*.atlassian.net")).toBe("multitenant");
    expect(wildcardRisk("*.s3.amazonaws.com")).toBe("multitenant");
    expect(wildcardRisk("*.example.com")).toBeNull();
    expect(wildcardRisk("acme.atlassian.net")).toBeNull();
    expect(wildcardRisk("*.com")).toBe("public-suffix");
    expect(wildcardRisk("*.com.br")).toBe("public-suffix");
    expect(isValidPattern("*.com")).toBe(false);
    expect(urlMatchesPattern(u("https://anything.com/"), "*.com")).toBe(false);
    expect(isValidPattern("*.atlassian.net")).toBe(true); // allowed, but the UI asks for confirmation
  });

  it("supports path prefixes", () => {
    const pattern = "api.example.com/v1/workspaces/123/*";
    expect(parsePattern(pattern)?.pathPrefix).toBe("/v1/workspaces/123");
    expect(urlMatchesPattern(u("https://api.example.com/v1/workspaces/123"), pattern)).toBe(true);
    expect(urlMatchesPattern(u("https://api.example.com/v1/workspaces/123/items?x=1"), pattern)).toBe(true);
    expect(urlMatchesPattern(u("https://api.example.com/v1/workspaces/1234"), pattern)).toBe(false);
    expect(urlMatchesPattern(u("https://api.example.com/v1/workspaces/999/items"), pattern)).toBe(false);
    expect(urlMatchesPattern(u("https://api.example.com/v1/workspaces/123/../../admin"), pattern)).toBe(false);
    expect(urlMatchesPattern(u("https://api.example.com/v1/workspaces/123%2F..%2Fadmin"), pattern)).toBe(false);
    expect(urlMatchesPattern(u("https://api.example.com/v1/workspaces/123/%2e%2e/%2e%2e/admin"), pattern)).toBe(false);
    expect(isValidPattern("api.example.com/v1/*/items")).toBe(false);
  });

  it("checks path prefixes against the final URL when the secret is in the path", () => {
    const s = record({ allowedHosts: ["api.example.com/v1/*"], placement: { headers: true, url: true, body: false }, value: "../admin/secret-value-xyz" });
    expect(code(() => prepareRequest({ url: "https://api.example.com/v1/{{secret:JIRA_ACME}}" }, lookupOf(s)))).toBe("host_not_allowed");
  });

  it("never puts a value in policy messages or display targets", () => {
    const s = record({ allowedHosts: ["api.example.com/v1/*"], placement: { headers: true, url: true, body: false }, value: "../admin/secret-value-xyz" });
    try {
      prepareRequest({ url: "https://api.example.com/v1/{{secret:JIRA_ACME}}" }, lookupOf(s));
    } catch (e) {
      expect((e as Error).message).not.toContain("secret-value-xyz");
    }
    const ok = record({ allowedHosts: ["api.example.com"], placement: { headers: true, url: true, body: false } });
    const p = prepareRequest({ url: "https://api.example.com/items/{{secret:JIRA_ACME}}" }, lookupOf(ok));
    expect(p.url.pathname).toContain("super-secret");
    expect(p.displayTarget).toBe("https://api.example.com/items/{{secret:JIRA_ACME}}");
  });
});

// ---------- 3. redaction ----------

describe("redaction", () => {
  const s = record({ value: "tok/en+value=1 with space" });
  const r = createRedactor([s]);
  const hex = Array.from(new TextEncoder().encode(s.value), (b) => b.toString(16).padStart(2, "0")).join("");

  it.each([
    ["raw", s.value],
    ["base64", utf8ToBase64(s.value)],
    ["base64url", utf8ToBase64(s.value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")],
    ["percent upper", encodeURIComponent(s.value)],
    ["percent lower", encodeURIComponent(s.value).replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase())],
    ["form", encodeURIComponent(s.value).replace(/%20/g, "+")],
    ["hex lower", hex],
    ["hex upper", hex.toUpperCase()],
    ["basic", utf8ToBase64(`${s.username}:${s.value}`)],
  ])("masks the %s form", (_label, form) => {
    const out = r.redact(`before ${form} after`);
    expect(out.text).toBe(`before ${REDACTED} after`);
    expect(out.count).toBeGreaterThan(0);
  });

  it("masks partial fragments of long secrets", () => {
    const long = record({ value: "ATATT3xFfGF0abcdefghijklmnopqrstuvwxyz0123456789" });
    const red = createRedactor([long]);
    const leaked = long.value.slice(5, 25);
    const out = red.redact(`{"error":"invalid token ...${leaked}..."}`);
    expect(out.text).not.toContain(leaked.slice(0, 12));
    expect(out.text).toContain(REDACTED);
    // Short, unrelated text is left alone.
    expect(red.redact("hello world, nothing to see").text).toBe("hello world, nothing to see");
  });

  it("does not partially mask short secrets", () => {
    const short = record({ value: "abc123def" });
    expect(createRedactor([short]).redact("abc123 is a common prefix").text).toBe("abc123 is a common prefix");
  });
});

// ---------- 4. per-client access ----------

describe("per-client access", () => {
  it("refuses secrets the client may not use", () => {
    const s = record();
    expect(code(() => prepareRequest({ url: "https://acme.atlassian.net/", headers: H }, lookupOf(s), () => false))).toBe("secret_not_permitted");
    expect(prepareRequest({ url: "https://acme.atlassian.net/", headers: H }, lookupOf(s), (x) => x.id === "id1").usedSecrets).toHaveLength(1);
  });
});

// ---------- 5. memory hygiene ----------

describe("lock()", () => {
  it("blanks records other code may still hold and drops them from the store", async () => {
    const { store } = await unlockedStore();
    await store.add(secretInput());
    const held = store.list()[0];
    expect(held.value).toBe(secretInput().value);
    store.lock();
    expect(held.value).toBe("");
    expect(held.username).toBeUndefined();
    expect(held.allowedHosts).toEqual([]);
    expect(store.names()).toEqual([]);
  });
});

// ---------- 6. crypto versioning ----------

/** Builds a vault file exactly as version 0.1.0 wrote it (format v1, no associated data). */
async function legacyV1File(password: string, payload: unknown): Promise<string> {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"]);
  const key = await crypto.subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt, iterations: 1000 }, base, { name: "AES-GCM", length: 256 }, false, [
    "encrypt",
  ]);
  const data = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(JSON.stringify(payload))));
  return JSON.stringify({
    format: "environment-variables-vault",
    version: 1,
    kdf: { name: "PBKDF2", hash: "SHA-256", iterations: 1000, salt: toBase64(salt) },
    cipher: { name: "AES-GCM", iv: toBase64(iv) },
    data: toBase64(data),
  });
}

describe("vault file versions", () => {
  it("opens a v1 file from 0.1.0 and upgrades it to v2 on unlock", async () => {
    const io = new MemoryIO();
    const rec = { ...secretInput(), id: "abc", createdAt: "", updatedAt: "" };
    io.content = await legacyV1File(PASSWORD, { secrets: [rec] });
    const store = new SecretStore(io, { iterations: 1000 });
    await store.unlock(PASSWORD);
    expect(store.get("JIRA_ACME")?.value).toBe(secretInput().value);
    const upgraded = JSON.parse(io.content!);
    expect(upgraded.version).toBe(2);
    expect(upgraded.kdf).toMatchObject({ name: "PBKDF2-SHA256", params: { iterations: 1000 } });
    store.lock();
    await store.unlock(PASSWORD); // still opens after the upgrade
    expect(store.list()).toHaveLength(1);
  });

  it("detects any change to the v2 header (bound as associated data)", async () => {
    const derived = await deriveKey(PASSWORD, { params: { iterations: 1000 } });
    const file = JSON.parse(await encryptPayload({ secrets: [] }, derived));
    const tampered = { ...file, kdf: { ...file.kdf, salt: toBase64(fromBase64(file.kdf.salt).map((b, i) => (i === 0 ? b ^ 1 : b))) } };
    await expect(decryptVault(JSON.stringify(tampered), PASSWORD)).rejects.toBeInstanceOf(WrongPasswordError);
    const retagged = { ...file, cipher: { ...file.cipher, iv: toBase64(randomBytes(12)) } };
    await expect(decryptVault(JSON.stringify(retagged), PASSWORD)).rejects.toBeInstanceOf(WrongPasswordError);
    await expect(decryptVault(JSON.stringify(file), PASSWORD)).resolves.toBeTruthy();
  });

  it("reports an unknown KDF (e.g. Argon2id before its module is registered)", async () => {
    const derived = await deriveKey(PASSWORD, { params: { iterations: 1000 } });
    const file = JSON.parse(await encryptPayload({ secrets: [] }, derived));
    file.kdf = { name: "Argon2id", salt: file.kdf.salt, params: { memoryKiB: 65536, iterations: 3, parallelism: 1 } };
    await expect(decryptVault(JSON.stringify(file), PASSWORD)).rejects.toBeInstanceOf(UnsupportedKdfError);
  });
});
