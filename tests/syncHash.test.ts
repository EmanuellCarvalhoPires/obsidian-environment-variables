import { describe, expect, it } from "vitest";
import { computeSyncHash, shouldSyncTools } from "../src/tools/syncHash";
import { ToolEntry } from "../src/tools/types";

function makeTool(name: string, instances?: Array<{ id: string; notePath: string; noteName: string }>): ToolEntry {
  return {
    name,
    title: name,
    description: `Description for ${name}`,
    kind: "request",
    params: {
      issueKey: { type: "string", required: true, description: "Issue key" },
    },
    writes: false,
    expose: true,
    notePath: `Tools/${name}.md`,
    noteName: name,
    serviceChoices: instances,
    status: "ready",
    problems: [],
    warnings: [],
  };
}

describe("syncHash (Item 12: tool & instance sync hash)", () => {
  it("mesma entrada → mesmo hash", () => {
    const tools = [
      makeTool("jira_get_issue", [
        { id: "Acme", notePath: "Instances/Jira - Acme.md", noteName: "Jira - Acme" },
        { id: "Globex", notePath: "Instances/Jira - Globex.md", noteName: "Jira - Globex" },
      ]),
      makeTool("confluence_get_page"),
    ];

    const hash1 = computeSyncHash(tools);
    const hash2 = computeSyncHash(tools);

    expect(hash1).toBeTypeOf("string");
    expect(hash1).toHaveLength(64);
    expect(hash1).toBe(hash2);
  });

  it("ordem diferente → mesmo hash", () => {
    const toolA = makeTool("jira_get_issue", [
      { id: "Acme", notePath: "Instances/Jira - Acme.md", noteName: "Jira - Acme" },
      { id: "Globex", notePath: "Instances/Jira - Globex.md", noteName: "Jira - Globex" },
    ]);
    const toolB = makeTool("confluence_get_page");
    const toolC = makeTool("bitbucket_list_repos");

    // Top-level order reversed: [toolA, toolB, toolC] vs [toolC, toolA, toolB]
    const list1 = [toolA, toolB, toolC];
    const list2 = [toolC, toolA, toolB];

    expect(computeSyncHash(list1)).toBe(computeSyncHash(list2));

    // Internal instance order reversed: [Acme, Globex] vs [Globex, Acme]
    const toolA_reversedInstances = makeTool("jira_get_issue", [
      { id: "Globex", notePath: "Instances/Jira - Globex.md", noteName: "Jira - Globex" },
      { id: "Acme", notePath: "Instances/Jira - Acme.md", noteName: "Jira - Acme" },
    ]);

    const list3 = [toolA_reversedInstances, toolB, toolC];
    expect(computeSyncHash(list1)).toBe(computeSyncHash(list3));
  });

  it("tool muda → hash muda", () => {
    const baseTools = [
      makeTool("jira_get_issue", [{ id: "Acme", notePath: "Instances/Jira - Acme.md", noteName: "Jira - Acme" }]),
    ];
    const baseHash = computeSyncHash(baseTools);

    // Change tool name
    const changedName = [
      makeTool("jira_get_issue_v2", [{ id: "Acme", notePath: "Instances/Jira - Acme.md", noteName: "Jira - Acme" }]),
    ];
    expect(computeSyncHash(changedName)).not.toBe(baseHash);

    // Change instance id
    const changedInstance = [
      makeTool("jira_get_issue", [{ id: "Stark", notePath: "Instances/Jira - Stark.md", noteName: "Jira - Stark" }]),
    ];
    expect(computeSyncHash(changedInstance)).not.toBe(baseHash);

    // Add a tool
    const addedTool = [
      ...baseTools,
      makeTool("confluence_get_page"),
    ];
    expect(computeSyncHash(addedTool)).not.toBe(baseHash);
  });

  it("sincronização pulada sem mudança (BDD: registro sem mudança não sincroniza; tool nova sincroniza)", () => {
    let lastHash: string | null = null;
    let syncCallCount = 0;

    const syncHandler = (tools: ToolEntry[]) => {
      const check = shouldSyncTools(lastHash, tools);
      if (!check.shouldSync) return;
      lastHash = check.hash;
      syncCallCount++;
    };

    const initialTools = [
      makeTool("jira_get_issue", [{ id: "Acme", notePath: "Instances/Jira - Acme.md", noteName: "Jira - Acme" }]),
    ];

    // First event: synchronization runs once
    syncHandler(initialTools);
    expect(syncCallCount).toBe(1);
    expect(lastHash).not.toBeNull();

    // Trigger another event with the exact same tools: synchronization is skipped
    syncHandler(initialTools);
    expect(syncCallCount).toBe(1);

    // Trigger another event with tools in different order: synchronization is skipped
    syncHandler([...initialTools]);
    expect(syncCallCount).toBe(1);

    // New tool added: synchronization runs once more
    const updatedTools = [
      ...initialTools,
      makeTool("jira_create_issue"),
    ];
    syncHandler(updatedTools);
    expect(syncCallCount).toBe(2);

    // Trigger another event with the updated tools: synchronization is skipped
    syncHandler(updatedTools);
    expect(syncCallCount).toBe(2);
  });
});
