import { describe, expect, it, vi } from "vitest";
import { Broker } from "../src/secrets/broker";
import { ClientContext } from "../src/server/clients";
import { executeMcpToolCall } from "../src/server/mcp";
import { parseFieldList, projectFields } from "../src/tools/responseShape";
import { ToolError } from "../src/tools/types";

describe("responseShape unit tests", () => {
  describe("parseFieldList", () => {
    it("returns undefined when text is undefined", () => {
      expect(parseFieldList(undefined)).toBeUndefined();
    });

    it("parses comma-separated string, trims whitespace and discards empty entries", () => {
      expect(parseFieldList("key, fields.summary ,  , status")).toEqual(["key", "fields.summary", "status"]);
    });

    it("returns empty array when given an empty or whitespace-only string", () => {
      expect(parseFieldList("")).toEqual([]);
      expect(parseFieldList("   ,  , ")).toEqual([]);
    });

    it("throws ToolError invalid_argument for non-string types", () => {
      expect(() => parseFieldList(123)).toThrow(ToolError);
      expect(() => parseFieldList({})).toThrow(ToolError);
      expect(() => parseFieldList(true)).toThrow(ToolError);
      expect(() => parseFieldList(null)).toThrow(ToolError);

      try {
        parseFieldList(123);
      } catch (err) {
        expect(err).toBeInstanceOf(ToolError);
        expect((err as ToolError).code).toBe("invalid_argument");
      }
    });
  });

  describe("projectFields", () => {
    it("projects existing flat and nested fields", () => {
      const obj = {
        key: "ACME-1",
        fields: {
          summary: "x",
          status: "y",
          nested: {
            deep: "value",
          },
        },
      };

      const res = projectFields(obj, ["key", "fields.summary", "fields.nested.deep"]);
      expect(res).toEqual({
        key: "ACME-1",
        fields: {
          summary: "x",
          nested: {
            deep: "value",
          },
        },
      });
    });

    it("sets nonexistent paths to null without throwing", () => {
      const obj = { key: "ACME-1", fields: { summary: "x" } };
      const res = projectFields(obj, ["missing", "fields.notThere", "a.b.c"]);
      expect(res).toEqual({
        missing: null,
        fields: {
          notThere: null,
        },
        a: {
          b: {
            c: null,
          },
        },
      });
    });

    it("returns the entire array when a path passes through an array", () => {
      const obj = {
        items: [
          { id: 1, name: "one" },
          { id: 2, name: "two" },
        ],
        total: 2,
      };

      const res = projectFields(obj, ["total", "items.name"]);
      expect(res).toEqual({
        total: 2,
        items: [
          { id: 1, name: "one" },
          { id: 2, name: "two" },
        ],
      });
    });

    it("returns empty object when fields is empty", () => {
      const obj = { key: "ACME-1" };
      expect(projectFields(obj, [])).toEqual({});
      expect(projectFields(obj, ["", "   "])).toEqual({});
    });
  });
});

describe("http_request response shaping BDD criteria", () => {
  const client: ClientContext = {
    id: "test-client-id",
    name: "test-client",
    access: { mode: "all" },
  };

  const createBroker = (body: string, overrides: Partial<Record<string, unknown>> = {}) =>
    ({
      execute: vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: "OK",
        headers: { "content-type": "application/json", "x-request-id": "123" },
        body,
        bodyEncoding: "text" as const,
        bodyBytes: new TextEncoder().encode(body).length,
        truncated: false,
        finalUrl: "https://example.com/api",
        redactions: 0,
        ...overrides,
      }),
      listSecrets: vi.fn(),
    }) as unknown as Broker;

  it("Given body {'key':'ACME-1','fields':{'summary':'x','status':'y'}} and fields 'key,fields.summary', Then response brings {'key':'ACME-1','fields':{'summary':'x'}}", async () => {
    const rawBody = JSON.stringify({
      key: "ACME-1",
      fields: { summary: "x", status: "y" },
    });
    const broker = createBroker(rawBody);

    const res = await executeMcpToolCall(
      "http_request",
      { url: "https://example.com/api", fields: "key,fields.summary" },
      { broker, client },
    );

    expect(res.isError).toBe(false);
    const structured = res.structuredContent as Record<string, unknown>;
    expect(structured.ok).toBe(true);
    expect(structured.body).toEqual({
      key: "ACME-1",
      fields: { summary: "x" },
    });
  });

  it("Given a nonexistent path in fields, Then the field comes as null and there is no error", async () => {
    const rawBody = JSON.stringify({ key: "ACME-1" });
    const broker = createBroker(rawBody);

    const res = await executeMcpToolCall(
      "http_request",
      { url: "https://example.com/api", fields: "nonexistent,nested.missing" },
      { broker, client },
    );

    expect(res.isError).toBe(false);
    const structured = res.structuredContent as Record<string, unknown>;
    expect(structured.ok).toBe(true);
    expect(structured.body).toEqual({
      nonexistent: null,
      nested: { missing: null },
    });
  });

  it("Given a path passing through an array, Then it returns the entire array", async () => {
    const rawBody = JSON.stringify({
      total: 1,
      issues: [{ id: "101", fields: { summary: "item" } }],
    });
    const broker = createBroker(rawBody);

    const res = await executeMcpToolCall(
      "http_request",
      { url: "https://example.com/api", fields: "total,issues.fields.summary" },
      { broker, client },
    );

    expect(res.isError).toBe(false);
    const structured = res.structuredContent as Record<string, unknown>;
    expect(structured.ok).toBe(true);
    expect(structured.body).toEqual({
      total: 1,
      issues: [{ id: "101", fields: { summary: "item" } }],
    });
  });

  it("Given max_chars 10 and body of 50 characters, Then body has 10 characters, truncated true, total_chars 50", async () => {
    // 50-character body
    const fiftyCharBody = "12345678901234567890123456789012345678901234567890";
    expect(fiftyCharBody.length).toBe(50);
    const broker = createBroker(fiftyCharBody);

    const res = await executeMcpToolCall(
      "http_request",
      { url: "https://example.com/api", max_chars: 10 },
      { broker, client },
    );

    expect(res.isError).toBe(false);
    const structured = res.structuredContent as Record<string, unknown>;
    expect(structured.ok).toBe(true);
    expect(structured.body).toBe("1234567890");
    expect(structured.truncated).toBe(true);
    expect(structured.total_chars).toBe(50);
  });

  it("Given max_chars not exceeded, Then body is not truncated", async () => {
    const rawBody = JSON.stringify({ message: "short" });
    const broker = createBroker(rawBody);

    const res = await executeMcpToolCall(
      "http_request",
      { url: "https://example.com/api", max_chars: 1000 },
      { broker, client },
    );

    expect(res.isError).toBe(false);
    const structured = res.structuredContent as Record<string, unknown>;
    expect(structured.ok).toBe(true);
    expect(structured.body).toEqual({ message: "short" });
    expect(structured.truncated).toBe(false);
    expect(structured.total_chars).toBeUndefined();
  });

  it("Given headers omitted, Then there is no headers key; with true, there is", async () => {
    const rawBody = JSON.stringify({ a: 1 });
    const broker = createBroker(rawBody);

    // Omitted headers
    const resOmitted = await executeMcpToolCall(
      "http_request",
      { url: "https://example.com/api" },
      { broker, client },
    );
    expect(resOmitted.isError).toBe(false);
    const structuredOmitted = resOmitted.structuredContent as Record<string, unknown>;
    expect("headers" in structuredOmitted).toBe(false);
    expect(structuredOmitted.headers).toBeUndefined();

    // headers: false
    const resFalse = await executeMcpToolCall(
      "http_request",
      { url: "https://example.com/api", headers: false },
      { broker, client },
    );
    expect(resFalse.isError).toBe(false);
    const structuredFalse = resFalse.structuredContent as Record<string, unknown>;
    expect("headers" in structuredFalse).toBe(false);

    // headers: true
    const resTrue = await executeMcpToolCall(
      "http_request",
      { url: "https://example.com/api", headers: true },
      { broker, client },
    );
    expect(resTrue.isError).toBe(false);
    const structuredTrue = resTrue.structuredContent as Record<string, unknown>;
    expect("headers" in structuredTrue).toBe(true);
    expect(structuredTrue.headers).toEqual({ "content-type": "application/json", "x-request-id": "123" });
  });

  it("Given API key present in body and included in fields, Then appears as *** (masked)", async () => {
    // Redaction happens at broker level before projection
    const rawBody = JSON.stringify({ key: "ACME-1", api_token: "***" });
    const broker = createBroker(rawBody, { redactions: 1 });

    const res = await executeMcpToolCall(
      "http_request",
      { url: "https://example.com/api", fields: "key,api_token" },
      { broker, client },
    );

    expect(res.isError).toBe(false);
    const structured = res.structuredContent as Record<string, unknown>;
    expect(structured.ok).toBe(true);
    expect(structured.body).toEqual({ key: "ACME-1", api_token: "***" });
    expect(JSON.stringify(structured.body)).not.toContain("super-secret");
    expect(res.content[0].text).toContain("***");
  });

  it("Given non-JSON body with fields, Then returns as text without error", async () => {
    const rawBody = "plain text response not json";
    const broker = createBroker(rawBody);

    const res = await executeMcpToolCall(
      "http_request",
      { url: "https://example.com/api", fields: "key,fields.summary" },
      { broker, client },
    );

    expect(res.isError).toBe(false);
    const structured = res.structuredContent as Record<string, unknown>;
    expect(structured.ok).toBe(true);
    expect(structured.body).toBe(rawBody);
  });

  it("Given empty fields, Then it is ignored and full parsed JSON is returned", async () => {
    const rawBody = JSON.stringify({ a: 1, b: 2 });
    const broker = createBroker(rawBody);

    const resEmpty = await executeMcpToolCall(
      "http_request",
      { url: "https://example.com/api", fields: "" },
      { broker, client },
    );
    expect(resEmpty.isError).toBe(false);
    expect((resEmpty.structuredContent as Record<string, unknown>).body).toEqual({ a: 1, b: 2 });

    const resWhitespace = await executeMcpToolCall(
      "http_request",
      { url: "https://example.com/api", fields: "  ,   " },
      { broker, client },
    );
    expect(resWhitespace.isError).toBe(false);
    expect((resWhitespace.structuredContent as Record<string, unknown>).body).toEqual({ a: 1, b: 2 });
  });

  it("validates fields, max_chars and headers arguments", async () => {
    const broker = createBroker('{"ok":true}');

    // Invalid fields type
    const resFields = await executeMcpToolCall(
      "http_request",
      { url: "https://example.com/api", fields: 123 },
      { broker, client },
    );
    expect(resFields.isError).toBe(true);
    expect((resFields.structuredContent as any).error.code).toBe("invalid_argument");

    // Invalid max_chars
    for (const invalidMax of [0, -1, 1.5, 1000001, "100"]) {
      const res = await executeMcpToolCall(
        "http_request",
        { url: "https://example.com/api", max_chars: invalidMax },
        { broker, client },
      );
      expect(res.isError).toBe(true);
      expect((res.structuredContent as any).error.code).toBe("invalid_argument");
    }

    // Invalid headers
    for (const invalidHeaders of ["true", 1, [1, 2]]) {
      const res = await executeMcpToolCall(
        "http_request",
        { url: "https://example.com/api", headers: invalidHeaders },
        { broker, client },
      );
      expect(res.isError).toBe(true);
      expect((res.structuredContent as any).error.code).toBe("invalid_argument");
    }
  });

  it("toolResult serializes JSON without indentation", async () => {
    const broker = createBroker(JSON.stringify({ a: 1, b: "two" }));

    const res = await executeMcpToolCall(
      "http_request",
      { url: "https://example.com/api" },
      { broker, client },
    );

    expect(res.content[0].text).not.toContain("\n");
    expect(res.content[0].text).toBe(JSON.stringify(res.structuredContent));
  });
});
