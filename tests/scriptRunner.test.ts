import { describe, expect, it } from "vitest";
import { ScriptRunner, ScriptRun } from "../src/tools/scriptRunner";

const runner = new ScriptRunner();
const job = (code: string, overrides: Partial<ScriptRun> = {}): ScriptRun => ({
  code,
  args: {},
  tool: "t",
  timeoutMs: 2000,
  maxOutputBytes: 100_000,
  bridge: async () => null,
  ...overrides,
});

describe("script runner", () => {
  it("runs the exported function with ctx.args", async () => {
    await expect(runner.run(job("export default async function (ctx) { return { twice: ctx.args.n * 2, tool: ctx.tool }; }", { args: { n: 21 } }))).resolves.toEqual({ twice: 42, tool: "t" });
  });

  it("reaches the host only through ctx", async () => {
    const calls: Array<[string, unknown]> = [];
    const result = await runner.run(
      job('export default async (ctx) => { const n = await ctx.notes.get("[[Svc]]"); const r = await ctx.requests.run("Req", { id: 1 }); return { n, r }; }', {
        bridge: async (method, params) => {
          calls.push([method, params]);
          return method === "notes.get" ? { name: "Svc" } : { status: 200 };
        },
      }),
    );
    expect(result).toEqual({ n: { name: "Svc" }, r: { status: 200 } });
    expect(calls.map((c) => c[0])).toEqual(["notes.get", "requests.run"]);
    expect(calls[1][1]).toEqual({ note: "Req", params: { id: 1 }, options: {} });
  });

  it("has no network, Node.js, timers or host internals", async () => {
    const code =
      "export default async () => [typeof fetch, typeof XMLHttpRequest, typeof WebSocket, typeof require, typeof process, typeof setTimeout, typeof window, typeof globalThis.__ev_host, typeof globalThis.__ev_log]";
    await expect(runner.run(job(code))).resolves.toEqual(Array(9).fill("undefined"));
  });

  it("cannot reach the host through the Function constructor", async () => {
    const code = "export default async () => { const g = Function('return this')(); return [typeof g.require, typeof g.process, typeof g.fetch]; }";
    await expect(runner.run(job(code))).resolves.toEqual(["undefined", "undefined", "undefined"]);
  });

  it("limits memory", async () => {
    const code = "export default () => { const a = []; while (true) a.push(new Array(100000).fill(1)); }";
    await expect(runner.run(job(code, { timeoutMs: 10_000 }))).rejects.toThrow(/memory/i);
  });

  it("reports a script stuck on a promise that never settles", async () => {
    await expect(runner.run(job("export default () => new Promise(() => {})"))).rejects.toThrow(/never settles/);
  });

  it("supports console.log through the host", async () => {
    const lines: string[] = [];
    await runner.run(job("export default (ctx) => { console.log('a', { b: 1 }); ctx.log('c'); return 1; }", { onLog: (l) => lines.push(l) }));
    expect(lines).toEqual([`a {"b":1}`, "c"]);
  });

  it("stops a runaway script", async () => {
    await expect(runner.run(job("export default () => { while (true) {} }", { timeoutMs: 300 }))).rejects.toMatchObject({ code: "timeout" });
  });

  it("does not count time spent waiting for the host", async () => {
    const bridge = () => new Promise((r) => setTimeout(() => r("late"), 600));
    await expect(runner.run(job("export default async (ctx) => ctx.http({ url: 'x' })", { timeoutMs: 300, bridge }))).resolves.toBe("late");
  });

  it("reports script errors and host errors", async () => {
    await expect(runner.run(job("export default () => { throw new Error('boom'); }"))).rejects.toThrow(/boom/);
    await expect(runner.run(job("const x = 1;"))).rejects.toThrow(/must export a function/);
    const bridge = async () => {
      throw new Error("host_not_allowed: nope");
    };
    await expect(runner.run(job("export default (ctx) => ctx.http({ url: 'x' })", { bridge }))).rejects.toThrow(/host_not_allowed/);
  });

  it("limits the output size", async () => {
    await expect(runner.run(job("export default () => 'x'.repeat(5000)", { maxOutputBytes: 100 }))).rejects.toThrow(/more than the limit/);
  });
});
