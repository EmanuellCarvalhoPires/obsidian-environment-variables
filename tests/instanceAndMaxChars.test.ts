import { describe, expect, it } from "vitest";
import { resolveServiceChoice } from "../src/tools/registry";
import { limitResponse, takeMaxChars } from "../src/tools/responseShape";

const choices = [
  { id: "Jira Access - CSP Tech", notePath: "a.md", noteName: "Jira Access - CSP Tech" },
  { id: "Jira Access - CSP Tech - Sandbox", notePath: "b.md", noteName: "Jira Access - CSP Tech - Sandbox" },
  { id: "Jira Access - Telecall", notePath: "c.md", noteName: "Jira Access - Telecall" },
  { id: "Atlassian - CSP", notePath: "d.md", noteName: "Atlassian - CSP" },
  { id: "Jira Access - A5X", notePath: "e.md", noteName: "Jira Access - A5X" },
  { id: "Atlassian - A5X", notePath: "f.md", noteName: "Atlassian - A5X" },
];

describe("resolveServiceChoice", () => {
  it("keeps the exact id", () => {
    expect(resolveServiceChoice(choices, "Jira Access - CSP Tech - Sandbox")).toBe("Jira Access - CSP Tech - Sandbox");
  });

  it("accepts the end of the name, ignoring case", () => {
    expect(resolveServiceChoice(choices, "CSP Tech")).toBe("Jira Access - CSP Tech");
    expect(resolveServiceChoice(choices, "telecall")).toBe("Jira Access - Telecall");
  });

  it("refuses an end that fits more than one instance", () => {
    expect(() => resolveServiceChoice(choices, "A5X")).toThrow(/more than one instance/);
  });

  it("returns undefined when nothing fits, so the enum check lists the valid ids", () => {
    expect(resolveServiceChoice(choices, "Nope")).toBeUndefined();
  });
});

describe("max_chars", () => {
  it("is taken off the arguments", () => {
    expect(takeMaxChars({ instance: "x", max_chars: 300 })).toEqual({ args: { instance: "x" }, maxChars: 300 });
    expect(takeMaxChars({ instance: "x" })).toEqual({ args: { instance: "x" } });
  });

  it("must be an integer from 1 to 1000000", () => {
    expect(() => takeMaxChars({ max_chars: 0 })).toThrow(/max_chars/);
    expect(() => takeMaxChars({ max_chars: "10" })).toThrow(/max_chars/);
  });

  it("cuts a long JSON response and says how long it was", () => {
    const res: { json?: unknown; body?: string; truncated: boolean; total_chars?: number } = limitResponse(
      { json: [{ a: "x".repeat(100) }] as unknown, body: undefined as string | undefined, truncated: false },
      20,
    );
    expect(res.json).toBeUndefined();
    expect(res.body).toHaveLength(20);
    expect(res.truncated).toBe(true);
    expect(res.total_chars).toBeGreaterThan(100);
  });

  it("leaves a short response alone", () => {
    const res = { status: 200, json: { a: 1 }, truncated: false };
    expect(limitResponse(res, 1000)).toBe(res);
  });
});
