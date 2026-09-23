import { describe, expect, it } from "vitest";
import { urlMatchesPattern, isValidPattern } from "../src/engine/hosts";
import { findPlaceholders, utf8ToBase64 } from "../src/engine/placeholders";
import { PolicyError, prepareRequest } from "../src/engine/prepare";
import { redactionVariants, redactText } from "../src/engine/redact";
import { SecretRecord } from "../src/store/types";
import { secretInput } from "./helpers";

function record(overrides: Partial<SecretRecord> = {}): SecretRecord {
  return { ...secretInput(), id: "x", createdAt: "", updatedAt: "", ...overrides } as SecretRecord;
}

const lookupOf = (...secrets: SecretRecord[]) => (name: string) => secrets.find((s) => s.name === name);

function policyCode(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    if (e instanceof PolicyError) return e.code;
    throw e;
  }
  return undefined;
}

describe("host patterns", () => {
  const u = (s: string) => new URL(s);
  it("matches exact hosts on the default port only", () => {
    expect(urlMatchesPattern(u("https://acme.atlassian.net/rest"), "acme.atlassian.net")).toBe(true);
    expect(urlMatchesPattern(u("https://ACME.atlassian.net./x"), "acme.atlassian.net")).toBe(true);
    expect(urlMatchesPattern(u("https://acme.atlassian.net:8443/"), "acme.atlassian.net")).toBe(false);
    expect(urlMatchesPattern(u("https://acme.atlassian.net:8443/"), "acme.atlassian.net:8443")).toBe(true);
  });
  it("rejects look-alike hosts", () => {
    expect(urlMatchesPattern(u("https://acme.atlassian.net.evil.com/"), "acme.atlassian.net")).toBe(false);
    expect(urlMatchesPattern(u("https://evilacme.atlassian.net/"), "acme.atlassian.net")).toBe(false);
    expect(urlMatchesPattern(u("https://evil.com/acme.atlassian.net"), "acme.atlassian.net")).toBe(false);
    expect(urlMatchesPattern(u("https://acme.atlassian.net@evil.com/"), "acme.atlassian.net")).toBe(false);
  });
  it("wildcards match subdomains only", () => {
    expect(urlMatchesPattern(u("https://a.atlassian.net/"), "*.atlassian.net")).toBe(true);
    expect(urlMatchesPattern(u("https://atlassian.net/"), "*.atlassian.net")).toBe(false);
    expect(urlMatchesPattern(u("https://xatlassian.net/"), "*.atlassian.net")).toBe(false);
  });
  it("validates patterns", () => {
    expect(isValidPattern("acme.atlassian.net")).toBe(true);
    expect(isValidPattern("https://acme.atlassian.net/")).toBe(true);
    expect(isValidPattern("a*b.com")).toBe(false);
    expect(isValidPattern("")).toBe(false);
  });
});

describe("placeholders", () => {
  it("finds all kinds", () => {
    const found = findPlaceholders("{{secret:A}} {{ basic : B }} {{bearer:C}} {{secret:D.user}}");
    expect(found.map((f) => `${f.kind}:${f.name}:${f.field ?? ""}`)).toEqual(["secret:A:", "basic:B:", "bearer:C:", "secret:D:user"]);
  });
});

describe("prepareRequest", () => {
  const jira = record();

  it("substitutes Basic auth in headers", () => {
    const p = prepareRequest(
      { url: "https://acme.atlassian.net/rest/api/3/myself", headers: { Authorization: "{{basic:JIRA_ACME}}" } },
      lookupOf(jira),
    );
    expect(p.headers.Authorization).toBe("Basic " + utf8ToBase64(`${jira.username}:${jira.value}`));
    expect(p.placements).toEqual({ headers: true, url: false, body: false });
    expect(p.usedSecrets.map((s) => s.name)).toEqual(["JIRA_ACME"]);
  });

  it("blocks other hosts (exfiltration attempt)", () => {
    expect(policyCode(() => prepareRequest({ url: "https://evil.com/", headers: { Authorization: "{{basic:JIRA_ACME}}" } }, lookupOf(jira)))).toBe(
      "host_not_allowed",
    );
  });

  it("blocks placeholders in the host", () => {
    expect(policyCode(() => prepareRequest({ url: "https://{{secret:JIRA_ACME}}.evil.com/" }, lookupOf(jira)))).toBe("placement_not_allowed");
  });

  it("blocks body and url placement by default", () => {
    expect(
      policyCode(() => prepareRequest({ method: "POST", url: "https://acme.atlassian.net/comment", body: '{"text":"{{secret:JIRA_ACME}}"}' }, lookupOf(jira))),
    ).toBe("placement_not_allowed");
    expect(policyCode(() => prepareRequest({ url: "https://acme.atlassian.net/x?t={{secret:JIRA_ACME}}" }, lookupOf(jira)))).toBe("placement_not_allowed");
  });

  it("allows url placement when enabled", () => {
    const s = record({ placement: { headers: true, url: true, body: false } });
    const p = prepareRequest({ url: "https://acme.atlassian.net/x?t={{secret:JIRA_ACME}}" }, lookupOf(s));
    expect(p.url.searchParams.get("t")).toBe(s.value);
  });

  it("requires https unless localhost is allowed", () => {
    expect(policyCode(() => prepareRequest({ url: "http://acme.atlassian.net/", headers: { A: "{{secret:JIRA_ACME}}" } }, lookupOf(jira)))).toBe(
      "insecure_scheme",
    );
    const local = record({ allowHttpLocalhost: true, allowedHosts: ["127.0.0.1:8080"] });
    expect(prepareRequest({ url: "http://127.0.0.1:8080/", headers: { A: "{{secret:JIRA_ACME}}" } }, lookupOf(local)).headers.A).toBe(local.value);
  });

  it("rejects unknown keys, malformed placeholders and placeholders in header names", () => {
    expect(policyCode(() => prepareRequest({ url: "https://acme.atlassian.net/", headers: { A: "{{secret:NOPE}}" } }, lookupOf(jira)))).toBe("unknown_secret");
    expect(policyCode(() => prepareRequest({ url: "https://acme.atlassian.net/", headers: { A: "{{secret:bad-name}}" } }, lookupOf(jira)))).toBe(
      "invalid_placeholder",
    );
    expect(policyCode(() => prepareRequest({ url: "https://acme.atlassian.net/", headers: { "{{secret:JIRA_ACME}}": "x" } }, lookupOf(jira)))).toBe(
      "placement_not_allowed",
    );
  });

  it("flags approval for writes", () => {
    const s = record({ approval: "writes" });
    const h = { Authorization: "{{basic:JIRA_ACME}}" };
    expect(prepareRequest({ url: "https://acme.atlassian.net/", headers: h }, lookupOf(s)).needsApproval).toBe(false);
    expect(prepareRequest({ method: "DELETE", url: "https://acme.atlassian.net/", headers: h }, lookupOf(s)).needsApproval).toBe(true);
  });

  it("passes requests without placeholders untouched", () => {
    const p = prepareRequest({ url: "https://example.com/", headers: { Accept: "application/json" } }, lookupOf());
    expect(p.usedSecrets).toEqual([]);
    expect(p.needsApproval).toBe(false);
  });
});

describe("redaction", () => {
  it("masks raw, base64, basic and url-encoded forms", () => {
    const s = record({ value: "tok/en+value=1" });
    const variants = redactionVariants([s]);
    const text = [s.value, utf8ToBase64(s.value), utf8ToBase64(`${s.username}:${s.value}`), encodeURIComponent(s.value)].join(" | ");
    const r = redactText(text, variants);
    expect(r.text).toBe("*** | *** | *** | ***");
    expect(r.count).toBe(4);
  });
});
