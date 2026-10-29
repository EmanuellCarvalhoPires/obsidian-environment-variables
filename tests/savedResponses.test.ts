import { describe, expect, it, vi } from "vitest";
import { Broker } from "../src/secrets/broker";
import { ClientContext } from "../src/server/clients";
import { executeMcpToolCall } from "../src/server/mcp";
import { ResponseWriter, SAVED_RESPONSES_DIR, saveResponse } from "../src/tools/savedResponses";

class MemoryResponseWriter implements ResponseWriter {
  readonly dirs = new Set<string>();
  readonly files = new Map<string, string>();

  async exists(path: string): Promise<boolean> {
    return this.dirs.has(path) || this.files.has(path);
  }

  async mkdir(path: string): Promise<void> {
    this.dirs.add(path);
  }

  async write(path: string, content: string): Promise<void> {
    this.files.set(path, content);
  }
}

describe("saveResponse unit tests", () => {
  it("saves JSON object: top_keys ['a','b'] and correct path", async () => {
    const writer = new MemoryResponseWriter();
    const body = '{"a":1,"b":2}';
    const id = "test-uuid-1";

    const res = await saveResponse(writer, body, id);

    expect(res.top_keys).toEqual(["a", "b"]);
    expect(res.saved_to.startsWith("plugins/environment-variables/respostas/")).toBe(true);
    expect(res.saved_to.endsWith(".json")).toBe(true);
    expect(res.saved_to).toBe(`${SAVED_RESPONSES_DIR}/test-uuid-1.json`);
    expect(res.bytes).toBe(new TextEncoder().encode(body).length);

    expect(writer.dirs.has(SAVED_RESPONSES_DIR)).toBe(true);
    expect(writer.files.get(res.saved_to)).toBe(body);
  });

  it("handles non-JSON body: top_keys null", async () => {
    const writer = new MemoryResponseWriter();
    const body = "hello world plain text";
    const id = "test-uuid-2";

    const res = await saveResponse(writer, body, id);

    expect(res.top_keys).toBeNull();
    expect(res.saved_to).toBe(`${SAVED_RESPONSES_DIR}/test-uuid-2.json`);
    expect(res.bytes).toBe(new TextEncoder().encode(body).length);
    expect(writer.files.get(res.saved_to)).toBe(body);
  });

  it("handles JSON array: top_keys null", async () => {
    const writer = new MemoryResponseWriter();
    const body = "[1, 2, 3]";
    const id = "test-uuid-3";

    const res = await saveResponse(writer, body, id);

    expect(res.top_keys).toBeNull();
    expect(res.saved_to).toBe(`${SAVED_RESPONSES_DIR}/test-uuid-3.json`);
    expect(res.bytes).toBe(new TextEncoder().encode(body).length);
    expect(writer.files.get(res.saved_to)).toBe(body);
  });

  it("preserves older files without deleting them", async () => {
    const writer = new MemoryResponseWriter();
    writer.files.set(`${SAVED_RESPONSES_DIR}/old-file.json`, "existing content");

    const res = await saveResponse(writer, '{"key": "val"}', "new-file");

    expect(writer.files.has(`${SAVED_RESPONSES_DIR}/old-file.json`)).toBe(true);
    expect(writer.files.get(`${SAVED_RESPONSES_DIR}/old-file.json`)).toBe("existing content");
    expect(writer.files.has(res.saved_to)).toBe(true);
  });
});

describe("http_request save_to BDD criteria", () => {
  const client: ClientContext = {
    id: "test-client-id",
    name: "test-client",
    access: { mode: "all" },
  };

  const createBroker = (body = '{"a":1,"b":2}') =>
    ({
      execute: vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: "OK",
        headers: { "content-type": "application/json", "x-custom": "masked-header" },
        body,
        bodyEncoding: "text" as const,
        bodyBytes: new TextEncoder().encode(body).length,
        truncated: false,
        finalUrl: "https://example.com/api",
        redactions: 0,
      }),
      listSecrets: vi.fn(),
    }) as unknown as Broker;

  it("Given save_to true and masked JSON body {'a':1,'b':2}, When http_request runs, Then response has saved_to, top_keys, status, headers", async () => {
    const writer = new MemoryResponseWriter();
    const broker = createBroker('{"a":1,"b":2}');

    const res = await executeMcpToolCall(
      "http_request",
      { url: "https://example.com/api", save_to: true },
      { broker, client, responseWriter: writer },
    );

    expect(res.isError).toBe(false);
    const structured = res.structuredContent as Record<string, unknown>;
    expect(structured.ok).toBe(true);
    expect(typeof structured.saved_to).toBe("string");
    expect((structured.saved_to as string).startsWith("plugins/environment-variables/respostas/")).toBe(true);
    expect((structured.saved_to as string).endsWith(".json")).toBe(true);
    expect(structured.top_keys).toEqual(["a", "b"]);
    expect(structured.status).toBe(200);
    expect(structured.headers).toEqual({ "content-type": "application/json", "x-custom": "masked-header" });
    expect(structured.body).toBeUndefined();

    // Verify file content in writer
    expect(writer.files.get(structured.saved_to as string)).toBe('{"a":1,"b":2}');
  });

  it("Given absent save_to, Then response is unchanged and body is returned directly", async () => {
    const writer = new MemoryResponseWriter();
    const broker = createBroker('{"a":1,"b":2}');

    const res = await executeMcpToolCall(
      "http_request",
      { url: "https://example.com/api" },
      { broker, client, responseWriter: writer },
    );

    expect(res.isError).toBe(false);
    const structured = res.structuredContent as Record<string, unknown>;
    expect(structured.ok).toBe(true);
    expect(structured.body).toEqual({ a: 1, b: 2 });
    expect(structured.saved_to).toBeUndefined();
    expect(writer.files.size).toBe(0);
  });

  it("Given path argument, Then returns invalid_argument error and writes nothing", async () => {
    const writer = new MemoryResponseWriter();
    const broker = createBroker();

    const res = await executeMcpToolCall(
      "http_request",
      { url: "https://example.com/api", path: "custom/path.json", save_to: true },
      { broker, client, responseWriter: writer },
    );

    expect(res.isError).toBe(true);
    const structured = res.structuredContent as Record<string, unknown>;
    expect(structured.ok).toBe(false);
    expect((structured.error as Record<string, unknown>).code).toBe("invalid_argument");
    expect(broker.execute).not.toHaveBeenCalled();
    expect(writer.files.size).toBe(0);
  });

  it("Given save_to as text 'sim', Then returns invalid_argument error", async () => {
    const writer = new MemoryResponseWriter();
    const broker = createBroker();

    const res = await executeMcpToolCall(
      "http_request",
      { url: "https://example.com/api", save_to: "sim" },
      { broker, client, responseWriter: writer },
    );

    expect(res.isError).toBe(true);
    const structured = res.structuredContent as Record<string, unknown>;
    expect(structured.ok).toBe(false);
    expect((structured.error as Record<string, unknown>).code).toBe("invalid_argument");
    expect(broker.execute).not.toHaveBeenCalled();
    expect(writer.files.size).toBe(0);
  });
});
