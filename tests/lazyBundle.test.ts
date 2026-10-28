import { describe, expect, it } from "vitest";
import esbuild from "esbuild";
import { builtinModules } from "node:module";
import { ScriptRunner } from "../src/tools/scriptRunner";
import { defaultLogoFor, DEFAULT_MCP_LOGOS } from "../src/ui/defaultLogos";

describe("lazy bundle and on-demand assets (item 21)", () => {
  it("produces a main bundle under 600 KB without the QuickJS WASM binary in memory build", async () => {
    const nodeBuiltins = [
      ...builtinModules,
      ...builtinModules.map((m) => `node:${m}`),
      "node:sqlite",
    ];

    const result = await esbuild.build({
      entryPoints: ["src/main.ts"],
      bundle: true,
      external: [
        "obsidian",
        "electron",
        "@codemirror/autocomplete",
        "@codemirror/collab",
        "@codemirror/commands",
        "@codemirror/language",
        "@codemirror/lint",
        "@codemirror/search",
        "@codemirror/state",
        "@codemirror/view",
        "@lezer/common",
        "@lezer/highlight",
        "@lezer/lr",
        ...nodeBuiltins,
      ],
      loader: { ".md": "text" },
      format: "cjs",
      target: "es2022",
      treeShaking: true,
      write: false,
      minify: true,
    });

    const bundleText = result.outputFiles[0].text;
    const bundleSizeBytes = bundleText.length;

    // Rule 6: main bundle size must be less than 600 KB (614,400 bytes)
    expect(bundleSizeBytes).toBeLessThan(600 * 1024);

    // Rule 6: initial base64 / WASM binary header (\0asm) must not appear in the main bundle
    expect(bundleText).not.toContain("\0asm");
    expect(bundleText).not.toContain("@jitl/quickjs-singlefile-cjs-release-sync");

    // Default logos JSON data must also be separated out
    expect(bundleText).not.toContain("DEFAULT_MCP_LOGOS = {");
    expect(bundleText).not.toContain("iVBORw0KGgoAAAANSUhEUgAAAgAAAAIACAYAAAD0eNT6");
  });

  it("loads quickjs.js on first script run and executes correctly", async () => {
    const runner = new ScriptRunner();
    const result = await runner.run({
      code: "export default async function (ctx) { return { answer: ctx.args.n * 3, tool: ctx.tool }; }",
      args: { n: 14 },
      tool: "my_tool",
      timeoutMs: 2000,
      maxOutputBytes: 10_000,
      bridge: async () => null,
    });

    expect(result).toEqual({ answer: 42, tool: "my_tool" });
  });

  it("throws the expected error message when quickjs.js is missing", async () => {
    const runnerMissingFile = new ScriptRunner({ quickjsPath: "/path/to/missing/quickjs.js" });
    await expect(
      runnerMissingFile.run({
        code: "export default async function () { return 1; }",
        args: {},
        tool: "t",
        timeoutMs: 2000,
        maxOutputBytes: 10_000,
        bridge: async () => null,
      }),
    ).rejects.toThrow("Environment Keys: quickjs.js is missing. Reinstall the plugin.");

    const runnerMissingAdapter = new ScriptRunner({
      adapter: {
        exists: async () => false,
        read: async () => "",
      },
    });
    await expect(
      runnerMissingAdapter.run({
        code: "export default async function () { return 1; }",
        args: {},
        tool: "t",
        timeoutMs: 2000,
        maxOutputBytes: 10_000,
        bridge: async () => null,
      }),
    ).rejects.toThrow("Environment Keys: quickjs.js is missing. Reinstall the plugin.");
  });

  it("serves default logos on demand while preserving the public API", () => {
    expect(defaultLogoFor("atlassian")).toMatch(/^data:image\/png;base64,/);
    expect(defaultLogoFor("jira")).toMatch(/^data:image\/png;base64,/);
    expect(defaultLogoFor("confluence")).toMatch(/^data:image\/png;base64,/);
    expect(defaultLogoFor("automation")).toMatch(/^data:image\/png;base64,/);
    expect(defaultLogoFor("unknown_logo_id")).toBe("");

    expect(DEFAULT_MCP_LOGOS["atlassian"]).toMatch(/^data:image\/png;base64,/);
    expect(DEFAULT_MCP_LOGOS["assets"]).toMatch(/^data:image\/png;base64,/);
    expect("atlassian" in DEFAULT_MCP_LOGOS).toBe(true);
    expect(Object.keys(DEFAULT_MCP_LOGOS)).toContain("atlassian");
    expect(Object.keys(DEFAULT_MCP_LOGOS)).toContain("jira");
  });
});
