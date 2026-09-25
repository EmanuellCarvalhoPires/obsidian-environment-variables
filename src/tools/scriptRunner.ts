// Runs the ```js block of a script tool inside QuickJS, a JavaScript engine compiled to WebAssembly.
//
// Why not a Web Worker: Obsidian turns on nodeIntegrationInWorker, so every worker can require()
// Node.js modules (network, files, processes). A worker is not a sandbox there.
//
// Security model:
// - The script runs in its own QuickJS runtime. It has no fetch, no require, no timers, no DOM and no
//   access to Obsidian or Node.js: the only way out is the ctx API below, implemented by the host.
// - Secrets never enter the sandbox. ctx.http / ctx.requests.run go through the broker with the
//   calling client's context, so hosts, placement, approval and masking still apply, and responses
//   arrive already masked.
// - CPU time is limited (time waiting for the host, e.g. a request or an approval, does not count),
//   and so are memory and stack size.

import variant from "@jitl/quickjs-singlefile-cjs-release-sync";
import { newQuickJSWASMModuleFromVariant, QuickJSContext, QuickJSDeferredPromise, QuickJSHandle, QuickJSWASMModule } from "quickjs-emscripten-core";
import { setTimeout } from "timers";
import { ToolError } from "./types";

const MEMORY_LIMIT_BYTES = 64 * 1024 * 1024;
const STACK_LIMIT_BYTES = 1024 * 1024;

/** Runs first in every sandbox: builds ctx on top of two host functions, then removes them. */
const PRELUDE = String.raw`
"use strict";
(function () {
  const host = globalThis.__ev_host;
  const hostLog = globalThis.__ev_log;
  delete globalThis.__ev_host;
  delete globalThis.__ev_log;
  const call = (method, params) =>
    host(method, JSON.stringify(params === undefined ? null : params)).then((text) => JSON.parse(text));
  const text = (v) => {
    if (typeof v === "string") return v;
    try { return JSON.stringify(v); } catch (e) { return String(v); }
  };
  const log = (...args) => hostLog(args.map(text).join(" "));
  globalThis.console = Object.freeze({ log, info: log, warn: log, error: log, debug: log });
  Object.defineProperty(globalThis, "__ev_ctx", {
    value: (args, tool, service) => Object.freeze({
      args: Object.freeze(args),
      tool,
      service,
      notes: Object.freeze({
        get: (ref) => call("notes.get", { ref }),
        query: (q) => call("notes.query", q || {}),
      }),
      requests: Object.freeze({
        run: (note, params, options) => call("requests.run", { note, params: params || {}, options: options || {} }),
      }),
      http: (req) => call("http", req),
      log,
    }),
  });
})();
`;

let quickjs: Promise<QuickJSWASMModule> | null = null;
function loadQuickJS(): Promise<QuickJSWASMModule> {
  quickjs ??= newQuickJSWASMModuleFromVariant(variant);
  return quickjs;
}

export type Bridge = (method: string, params: unknown) => Promise<unknown>;

export interface ScriptRun {
  code: string;
  args: Record<string, unknown>;
  tool: string;
  /** Service note of the call (name, path, frontmatter, tags), exposed as ctx.service. */
  service?: unknown;
  timeoutMs: number;
  maxOutputBytes: number;
  bridge: Bridge;
  onLog?: (line: string) => void;
}

export class ScriptRunner {
  async run(job: ScriptRun): Promise<unknown> {
    const QuickJS = await loadQuickJS();
    const runtime = QuickJS.newRuntime();
    runtime.setMemoryLimit(MEMORY_LIMIT_BYTES);
    runtime.setMaxStackSize(STACK_LIMIT_BYTES);

    // CPU time is counted only while QuickJS runs (eval or pending jobs), never while waiting for the host.
    let busyMs = 0;
    let sliceStart = 0;
    let inSlice = false;
    runtime.setInterruptHandler(() => inSlice && busyMs + (Date.now() - sliceStart) > job.timeoutMs);
    const slice = <T>(fn: () => T): T => {
      sliceStart = Date.now();
      inSlice = true;
      try {
        return fn();
      } finally {
        busyMs += Date.now() - sliceStart;
        inSlice = false;
      }
    };
    const timedOut = () => busyMs > job.timeoutMs;
    const timeoutError = () => new ToolError("timeout", `The script ran for more than ${Math.round(job.timeoutMs / 1000)} s and was stopped.`);
    const fail = (message: string) => (timedOut() ? timeoutError() : new ToolError("script_error", message));

    const vm = runtime.newContext();
    const deferreds = new Set<QuickJSDeferredPromise>();
    let pendingCalls = 0;
    let disposed = false;
    let failPump: (err: Error) => void = () => undefined;
    const pumpFailed = new Promise<never>((_, reject) => (failPump = reject));

    const pump = () => {
      if (disposed) return;
      const res = slice(() => runtime.executePendingJobs());
      if (res.error) {
        const message = describe(vm, res.error);
        res.error.dispose();
        failPump(fail(message));
      }
    };

    try {
      const host = vm.newFunction("__ev_host", (methodHandle, paramsHandle) => {
        const method = vm.getString(methodHandle);
        const params: unknown = JSON.parse(vm.getString(paramsHandle));
        const deferred = vm.newPromise();
        deferreds.add(deferred);
        pendingCalls++;
        job
          .bridge(method, params)
          .then(
            (value) => {
              if (disposed) return;
              const h = vm.newString(JSON.stringify(value === undefined ? null : value));
              deferred.resolve(h);
              h.dispose();
            },
            (err: unknown) => {
              if (disposed) return;
              const h = vm.newError(err instanceof Error ? err.message : String(err));
              deferred.reject(h);
              h.dispose();
            },
          )
          .finally(() => {
            pendingCalls--;
            deferreds.delete(deferred);
            if (!disposed) deferred.dispose();
            pump();
          });
        return deferred.handle;
      });
      vm.setProp(vm.global, "__ev_host", host);
      host.dispose();
      const log = vm.newFunction("__ev_log", (line) => {
        job.onLog?.(vm.getString(line));
      });
      vm.setProp(vm.global, "__ev_log", log);
      log.dispose();

      evalOrThrow(vm, slice, PRELUDE, "prelude.js", fail).dispose();
      const source = job.code.replace(/\bexport\s+default\b/, "globalThis.__ev_main =");
      evalOrThrow(vm, slice, source, `${job.tool}.js`, fail).dispose();

      const invoke = `(async () => {
        if (typeof globalThis.__ev_main !== "function") throw new Error("The script must export a function: export default async function (ctx) { ... }");
        const out = await globalThis.__ev_main(globalThis.__ev_ctx(${JSON.stringify(job.args)}, ${JSON.stringify(job.tool)}, ${JSON.stringify(job.service ?? null)}));
        return JSON.stringify(out === undefined ? null : out);
      })()`;
      const promise = evalOrThrow(vm, slice, invoke, "invoke.js", fail);
      const settled = vm.resolvePromise(promise);
      promise.dispose();
      pump();

      // A script that awaits something that can never finish (no host call, no pending job) is stuck.
      const stuck = new Promise<never>((_, reject) => {
        const check = () => {
          if (disposed) return;
          if (pendingCalls === 0 && !runtime.hasPendingJob()) {
            reject(new ToolError("script_error", "The script is waiting for a promise that never settles."));
            return;
          }
          later(check, 100);
        };
        later(check, 100);
      });

      const result = await Promise.race([settled, pumpFailed, stuck]);
      if (result.error) {
        const message = describe(vm, result.error);
        result.error.dispose();
        throw fail(message);
      }
      const json = vm.getString(result.value);
      result.value.dispose();
      const size = new TextEncoder().encode(json).length;
      if (size > job.maxOutputBytes) {
        throw new ToolError("script_error", `The script returned ${size} bytes, more than the limit of ${job.maxOutputBytes}.`);
      }
      return JSON.parse(json) as unknown;
    } finally {
      disposed = true;
      for (const d of deferreds) d.dispose();
      deferreds.clear();
      try {
        vm.dispose();
        runtime.dispose();
      } catch {
        // A leaked handle must not take the plugin down; the runtime is discarded either way.
      }
    }
  }
}

function evalOrThrow(vm: QuickJSContext, slice: <T>(fn: () => T) => T, code: string, filename: string, fail: (m: string) => ToolError): QuickJSHandle {
  const res = slice(() => vm.evalCode(code, filename));
  if (res.error) {
    const message = describe(vm, res.error);
    res.error.dispose();
    throw fail(message);
  }
  return res.value;
}

/** Error message with the first stack lines, so the AI can find the failing line. */
function describe(vm: QuickJSContext, handle: QuickJSHandle): string {
  const err: unknown = vm.dump(handle);
  if (err && typeof err === "object") {
    const e = err as { name?: string; message?: string; stack?: string };
    const head = `${e.name ?? "Error"}: ${e.message ?? ""}`;
    const stack = typeof e.stack === "string" ? e.stack.split("\n").slice(0, 3).join("\n").trim() : "";
    return stack ? `${head}\n${stack}` : head;
  }
  return typeof err === "string" ? err : JSON.stringify(err);
}

/** Node timers: the same in Obsidian (desktop) and in tests. */
function later(fn: () => void, ms: number): void {
  setTimeout(fn, ms);
}
