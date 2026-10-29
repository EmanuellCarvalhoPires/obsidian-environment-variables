import { describe, expect, it } from "vitest";
import esbuild from "esbuild";
import { builtinModules } from "node:module";
import { ScriptRunner } from "../src/tools/scriptRunner";
import { defaultLogoFor, DEFAULT_MCP_LOGOS } from "../src/ui/defaultLogos";

describe("lazy bundle and on-demand assets (item 21)", () => {
  it("bundles main.js with QuickJS inside and keeps logos out", async () => {
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
    expect(bundleText).toContain("quickjs");
  });

  it("runs scripts with the QuickJS bundled in main.js and executes correctly", async () => {
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
