import { describe, expect, it } from "vitest";
import { detectToken } from "../src/engine/tokenPatterns";

// Fake values with the right shape. None of them is a real credential.
const fake = (prefix: string, n: number, alphabet = "aB3") => prefix + alphabet.repeat(Math.ceil(n / alphabet.length)).slice(0, n);

describe("detectToken", () => {
  it("recognizes common token formats", () => {
    expect(detectToken(fake("ATATT3x", 180))).toBe("Atlassian API token");
    expect(detectToken(fake("ghp_", 36))).toBe("GitHub token");
    expect(detectToken(fake("github_pat_", 60))).toBe("GitHub token");
    expect(detectToken(fake("glpat-", 20))).toBe("GitLab token");
    expect(detectToken(fake("sk-ant-api03-", 40))).toBe("Anthropic API key");
    expect(detectToken(fake("sk-proj-", 40))).toBe("OpenAI API key");
    expect(detectToken(fake("AKIA", 16, "Q7"))).toBe("AWS access key");
    expect(detectToken(fake("AIza", 35))).toBe("Google API key");
    expect(detectToken(fake("xoxb-", 30, "1a-"))).toBe("Slack token");
    expect(detectToken(fake("sk_live_", 24))).toBe("Stripe key");
    expect(detectToken(`${fake("eyJ", 20)}.${fake("eyJ", 20)}.${fake("", 20)}`)).toBe("JWT");
  });

  it("ignores surrounding whitespace", () => {
    expect(detectToken(`  ${fake("ghp_", 36)}\n`)).toBe("GitHub token");
  });

  it("does not flag ordinary text, placeholders or tokens inside sentences", () => {
    expect(detectToken("hello world")).toBeNull();
    expect(detectToken("{{basic:JIRA_ACME}}")).toBeNull();
    expect(detectToken(`my token is ${fake("ghp_", 36)}`)).toBeNull();
    expect(detectToken("sk-short")).toBeNull();
    expect(detectToken("AKIA123")).toBeNull();
    expect(detectToken("")).toBeNull();
  });
});
