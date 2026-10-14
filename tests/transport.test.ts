import * as http from "http";
import { AddressInfo } from "net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ActivityLog } from "../src/activity/activityLog";
import { AuditLog } from "../src/audit/auditLog";
import { Broker } from "../src/engine/broker";
import { nodeTransport, Transport } from "../src/engine/transport";
import { ClientContext } from "../src/server/clients";
import { secretInput, unlockedStore } from "./helpers";

// The upstream answers with the content type asked for in the query string.
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff]);
let upstream: http.Server;
let port = 0;

beforeAll(async () => {
  upstream = http.createServer((req, res) => {
    const type = new URL(req.url ?? "/", "http://x").searchParams.get("type") ?? "";
    res.writeHead(200, type ? { "Content-Type": type } : {});
    res.end(type.startsWith("image/png") ? PNG : "<svg/>");
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", () => r()));
  port = (upstream.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((r) => upstream.close(() => r()));
});

const fetchAs = (type: string) =>
  nodeTransport({
    method: "GET",
    url: new URL(`http://127.0.0.1:${port}/?type=${encodeURIComponent(type)}`),
    headers: {},
    redirectDecision: () => "stop",
    timeoutMs: 2000,
    maxResponseBytes: 10_000,
    maxRedirects: 0,
  });

describe("response bodies", () => {
  it.each([
    "",
    "text/plain",
    "application/json; charset=utf-8",
    "application/problem+json",
    "application/vnd.api+json",
    "application/atom+xml",
    "image/svg+xml",
    "image/svg+xml;charset=UTF-8",
  ])("returns %j as text", async (type) => {
    const res = await fetchAs(type);
    expect(res.bodyEncoding).toBe("text");
    expect(res.body).toBe("<svg/>");
  });

  it("returns an image in base64", async () => {
    const res = await fetchAs("image/png;charset=UTF-8");
    expect(res.bodyEncoding).toBe("base64");
    expect(Buffer.from(res.body, "base64").equals(PNG)).toBe(true);
    expect(res.bodyBytes).toBe(PNG.length);
  });

  it.each(["application/octet-stream", "application/pdf", "font/woff2"])("omits the body of %j", async (type) => {
    const res = await fetchAs(type);
    expect(res.bodyEncoding).toBe("omitted");
    expect(res.body).toBe("");
    expect(res.bodyBytes).toBe(6);
  });
});

describe("image bodies in the broker", () => {
  const client: ClientContext = { id: "c1", name: "Claude Code", access: { mode: "all" } };
  const SECRET = secretInput().value;

  async function brokerReturning(bytes: Buffer) {
    const { store } = await unlockedStore();
    await store.add(secretInput());
    const send: Transport = async (req) => ({
      status: 200,
      statusText: "OK",
      headers: { "content-type": "image/png" },
      body: bytes.toString("base64"),
      bodyEncoding: "base64",
      bodyBytes: bytes.length,
      truncated: false,
      finalUrl: req.url.toString(),
      redirects: 0,
    });
    const activity = new ActivityLog();
    const broker = new Broker(store, send, async () => true, new AuditLog(), () => ({ timeoutMs: 5000, maxResponseBytes: 1_000_000, maxRedirects: 5 }), undefined, activity);
    return { broker, activity };
  }

  const request = { url: "https://acme.atlassian.net/avatar/1", headers: { Authorization: "{{basic:JIRA_ACME}}" } };

  it("returns the image as it came, without logging its bytes", async () => {
    const { broker, activity } = await brokerReturning(PNG);
    const res = await broker.execute(request, client);
    expect(res.ok && res.bodyEncoding).toBe("base64");
    expect(res.ok && Buffer.from(res.body, "base64").equals(PNG)).toBe(true);
    const keys = activity.list()[0].lines.map((l) => l.key);
    expect(keys).toContain("act.line.bodyBase64");
    expect(keys).not.toContain("act.line.responseBody");
  });

  it("drops an image whose bytes hold a secret", async () => {
    const { broker, activity } = await brokerReturning(Buffer.concat([PNG, Buffer.from(SECRET, "latin1"), PNG]));
    const res = await broker.execute(request, client);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.bodyEncoding).toBe("omitted");
    expect(res.body).toBe("");
    expect(res.redactions).toBeGreaterThan(0);
    expect(activity.list()[0].lines.map((l) => l.key)).toContain("act.line.bodySecretInBytes");
  });
});
