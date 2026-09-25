import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as net from "net";
import { AuditLog } from "../src/audit/auditLog";
import { Broker } from "../src/engine/broker";
import { nodeTransport } from "../src/engine/transport";
import { contextOf, createClient, findClient } from "../src/server/clients";
import { LocalServer, PortInUseError, probePort } from "../src/server/localServer";
import { unlockedStore } from "./helpers";

// Two vaults open at the same time: each server has its own port, its own identity and its own clients.
const PORT = 27190;

async function vaultServer(port: number, vault: { id: string; name: string }) {
  const { store } = await unlockedStore();
  const broker = new Broker(store, nodeTransport, async () => true, new AuditLog(), () => ({ timeoutMs: 2000, maxResponseBytes: 100_000, maxRedirects: 0 }));
  const client = await createClient("Claude Code", { mode: "all" });
  const server = new LocalServer({
    port,
    broker,
    version: "test",
    vault,
    authenticate: async (tk) => {
      const c = await findClient([client.record], tk);
      return c ? contextOf(c) : null;
    },
  });
  return { server, token: client.token };
}

let cofre: Awaited<ReturnType<typeof vaultServer>>;
let teste: Awaited<ReturnType<typeof vaultServer>>;

beforeAll(async () => {
  cofre = await vaultServer(PORT, { id: "aaaa", name: "Cofre" });
  teste = await vaultServer(PORT, { id: "bbbb", name: "Teste Plugin" });
  await cofre.server.start();
});

afterAll(async () => {
  await cofre.server.stop();
  await teste.server.stop();
});

describe("one server per vault", () => {
  it("reports a taken port and who holds it", async () => {
    await expect(teste.server.start()).rejects.toBeInstanceOf(PortInUseError);
    expect(await probePort(PORT)).toEqual({ isPlugin: true, vaultId: "aaaa", vaultName: "Cofre" });
  });

  it("tells an unrelated program apart from a vault, and a free port from both", async () => {
    const sockets = new Set<net.Socket>();
    const other = net.createServer((s) => {
      sockets.add(s);
      s.on("data", () => s.end("HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 2\r\nConnection: close\r\n\r\nhi"));
    });
    await new Promise<void>((r) => other.listen(PORT + 5, "127.0.0.1", () => r()));
    try {
      expect(await probePort(PORT + 5)).toEqual({ isPlugin: false });
    } finally {
      for (const s of sockets) s.destroy();
      await new Promise<void>((r) => other.close(() => r()));
    }
    expect(await probePort(PORT + 6)).toBeNull();
  });

  it("each vault only accepts its own client token", async () => {
    // The second vault moves to the next port, as the plugin does after PortInUseError.
    const moved = await vaultServer(PORT + 1, { id: "bbbb", name: "Teste Plugin" });
    await moved.server.start();
    try {
      const ask = (port: number, token: string) => fetch(`http://127.0.0.1:${port}/v1/secrets`, { headers: { Authorization: `Bearer ${token}` } }).then((r) => r.status);
      expect(await ask(PORT, cofre.token)).toBe(200);
      expect(await ask(PORT + 1, moved.token)).toBe(200);
      expect(await ask(PORT, moved.token)).toBe(401);
      expect(await ask(PORT + 1, cofre.token)).toBe(401);
    } finally {
      await moved.server.stop();
    }
  });
});
