// Recognizes well-known API token formats, so a pasted token can be moved into the vault.
// Only whole-string matches count: a token inside a sentence is not flagged.

const PATTERNS: Array<{ kind: string; regex: RegExp }> = [
  { kind: "Atlassian API token", regex: /^AT[AC]TT[A-Za-z0-9_\-=]{20,}$/ },
  { kind: "GitHub token", regex: /^(gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})$/ },
  { kind: "GitLab token", regex: /^glpat-[A-Za-z0-9_-]{20,}$/ },
  { kind: "Anthropic API key", regex: /^sk-ant-[A-Za-z0-9_-]{20,}$/ },
  { kind: "OpenAI API key", regex: /^sk-(proj-)?[A-Za-z0-9_-]{20,}$/ },
  { kind: "AWS access key", regex: /^(AKIA|ASIA)[0-9A-Z]{16}$/ },
  { kind: "Google API key", regex: /^AIza[0-9A-Za-z_-]{35}$/ },
  { kind: "Slack token", regex: /^xox[abposr]-[A-Za-z0-9-]{10,}$/ },
  { kind: "Stripe key", regex: /^(sk|rk)_live_[A-Za-z0-9]{20,}$/ },
  { kind: "JWT", regex: /^eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}$/ },
];

/** Returns the kind of token when the whole text is a known token format, otherwise null. */
export function detectToken(text: string): string | null {
  const candidate = text.trim();
  if (candidate.length > 4096 || /\s/.test(candidate)) return null;
  return PATTERNS.find((p) => p.regex.test(candidate))?.kind ?? null;
}
