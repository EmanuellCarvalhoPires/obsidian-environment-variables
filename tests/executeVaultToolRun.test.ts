import { describe, expect, it, vi } from "vitest";
import { executeVaultToolRun } from "../src/server/mcp";
import type { ToolsService } from "../src/tools/service";

const client = { id: "c", name: "test" } as never;

function toolsStub(enabled: boolean, callMcp = vi.fn()) {
  return { enabled: () => enabled, callMcp } as unknown as ToolsService;
}

describe("executeVaultToolRun", () => {
  it("runs the tool by name through run_vault_tool, without needing it in the tool list", async () => {
    const callMcp = vi.fn().mockResolvedValue({ value: { ok: true, status: 200 }, isError: false });
    const res = await executeVaultToolRun("jira_get_all_statuses", { expand: "x" }, { client, tools: toolsStub(true, callMcp) });

    expect(callMcp).toHaveBeenCalledWith("run_vault_tool", { name: "jira_get_all_statuses", arguments: { expand: "x" } }, client);
    expect(res.isError).toBe(false);
    expect(res.structuredContent).toEqual({ ok: true, status: 200 });
  });

  it("passes the error of the tool along", async () => {
    const callMcp = vi.fn().mockResolvedValue({ value: { ok: false, error: { code: "unknown_tool", message: "x" } }, isError: true });
    const res = await executeVaultToolRun("nope", {}, { client, tools: toolsStub(true, callMcp) });

    expect(res.isError).toBe(true);
    expect(res.content[0].text).not.toContain("Unknown tool: run_vault_tool");
  });

  it("answers tools_disabled when the vault tools are off", async () => {
    const callMcp = vi.fn();
    const res = await executeVaultToolRun("jira_get_all_statuses", {}, { client, tools: toolsStub(false, callMcp) });

    expect(callMcp).not.toHaveBeenCalled();
    expect(res.isError).toBe(true);
    expect(res.structuredContent).toMatchObject({ error: { code: "tools_disabled" } });
  });
});
