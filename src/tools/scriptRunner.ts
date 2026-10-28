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

import type variant from "@jitl/quickjs-singlefile-cjs-release-sync";
import { newQuickJSWASMModuleFromVariant, QuickJSContext, QuickJSDeferredPromise, QuickJSHandle, QuickJSWASMModule } from "quickjs-emscripten-core";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vmModule from "node:vm";
import { createRequire } from "node:module";
import { setTimeout } from "timers";
import { ToolError } from "./types";

type QuickJSSyncVariant = typeof variant;

const MEMORY_LIMIT_BYTES = 64 * 1024 * 1024;
const STACK_LIMIT_BYTES = 1024 * 1024;
const MISSING_QUICKJS_ERROR = "Environment Keys: quickjs.js is missing. Reinstall the plugin.";

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

export interface ScriptRunnerOptions {
  adapter?: {
    exists(path: string): Promise<boolean>;
    read(path: string): Promise<string>;
  };
  pluginDir?: string;
  quickjsPath?: string;
}

interface AppWithAdapter {
  vault?: {
    adapter?: {
      exists(path: string): Promise<boolean>;
      read(path: string): Promise<string>;
    };
    configDir?: string;
  };
  plugins?: {
    plugins?: Record<string, { manifest?: { dir?: string } }>;
  };
}

let defaultQuickJS: Promise<QuickJSWASMModule> | null = null;

async function loadQuickJS(options?: ScriptRunnerOptions): Promise<QuickJSWASMModule> {
  if (!options && defaultQuickJS) {
    return defaultQuickJS;
  }

  const loadPromise = (async () => {
    let code: string | null = null;

    // 1. Explicit adapter in options
    if (options?.adapter) {
      const pluginDir = options.pluginDir ?? ".obsidian/plugins/environment-variables";
      const filePath = options.quickjsPath ?? `${pluginDir}/quickjs.js`;
      try {
        if (await options.adapter.exists(filePath)) {
          code = await options.adapter.read(filePath);
        }
      } catch {
        // Handled below
      }
      if (!code) {
        throw new ToolError("script_error", MISSING_QUICKJS_ERROR);
      }
    }

    // 2. Obsidian vault adapter if running inside Obsidian
    if (!code && !options?.quickjsPath) {
      const app = (globalThis as unknown as { app?: AppWithAdapter }).app;
      const adapter = app?.vault?.adapter;
      if (adapter) {
        const pluginDir =
          app.plugins?.plugins?.["environment-variables"]?.manifest?.dir ??
          `${app.vault?.configDir ?? ".obsidian"}/plugins/environment-variables`;
        const filePath = `${pluginDir}/quickjs.js`;
        try {
          if (await adapter.exists(filePath)) {
            code = await adapter.read(filePath);
          }
        } catch {
          // Fall through to filesystem search
        }
      }
    }

    // 3. Local filesystem fallback (Node.js test environment / workspace root)
    if (!code) {
      if (options?.quickjsPath) {
        try {
          if (fs.existsSync(options.quickjsPath)) {
            code = await fs.promises.readFile(options.quickjsPath, "utf8");
          }
        } catch {
          // Handled below
        }
        if (!code) {
          throw new ToolError("script_error", MISSING_QUICKJS_ERROR);
        }
      } else {
        const candidates = [
          path.join(process.cwd(), "quickjs.js"),
          path.join(__dirname, "quickjs.js"),
          path.join(__dirname, "../quickjs.js"),
          path.join(__dirname, "../../quickjs.js"),
        ];

        for (const candidate of candidates) {
          try {
            if (fs.existsSync(candidate)) {
              code = await fs.promises.readFile(candidate, "utf8");
              break;
            }
          } catch {
            // Continue searching candidates
          }
        }
      }
    }

    if (!code) {
      throw new ToolError("script_error", MISSING_QUICKJS_ERROR);
    }

    const mod: { exports: { default?: QuickJSSyncVariant } | QuickJSSyncVariant } = { exports: {} };
    const req = typeof require !== "undefined" ? require : createRequire(typeof __filename !== "undefined" ? __filename : process.cwd());
    const wrapper = vmModule.runInThisContext(
      `((module, exports, require) => {\n${code}\n})`,
      { filename: "quickjs.js" },
    ) as (module: unknown, exports: unknown, require: unknown) => void;
    wrapper(mod, mod.exports, req);
    const resolvedVariant = ((mod.exports as { default?: QuickJSSyncVariant }).default ?? mod.exports) as QuickJSSyncVariant;

    return await newQuickJSWASMModuleFromVariant(resolvedVariant);
  })();

  if (!options) {
    defaultQuickJS = loadPromise;
    defaultQuickJS.catch(() => {
      defaultQuickJS = null;
    });
  }

  return loadPromise;
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
  constructor(private readonly options?: ScriptRunnerOptions) {}

  async run(job: ScriptRun): Promise<unknown> {
    const QuickJS = await loadQuickJS(this.options);
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
