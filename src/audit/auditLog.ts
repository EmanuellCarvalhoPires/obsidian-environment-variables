export type AuditOutcome = "ok" | "denied" | "blocked" | "locked" | "error";

export interface AuditEntry {
  time: string;
  client: string;
  action: "request" | "list" | "tool" | "spawn" | "adopt" | "create" | "template";
  /** Vault tool name, for action "tool". Its requests are logged as separate "request" entries. */
  tool?: string;
  secrets: string[];
  method?: string;
  /** Origin + path only. The query string is dropped because it may hold values. */
  target?: string;
  status?: number;
  outcome: AuditOutcome;
  detail?: string;
  redactions?: number;
}

export const MAX_AUDIT_ENTRIES = 500;

export class AuditLog {
  private entries: AuditEntry[];
  private listeners = new Set<() => void>();
  public version: number = 0;

  constructor(
    initial: AuditEntry[] = [],
    private readonly persist: (entries: AuditEntry[]) => void | Promise<void> = () => undefined,
  ) {
    this.entries = initial.slice(-MAX_AUDIT_ENTRIES);
  }

  add(entry: Omit<AuditEntry, "time">): void {
    this.version++;
    this.entries.push({ time: new Date().toISOString(), ...entry });
    if (this.entries.length > MAX_AUDIT_ENTRIES) this.entries.splice(0, this.entries.length - MAX_AUDIT_ENTRIES);
    void this.persist(this.entries);
    for (const l of this.listeners) l();
  }

  list(): AuditEntry[] {
    return [...this.entries].reverse();
  }

  /** Returns at most 'limit' entries in reverse chronological order without cloning the whole array. */
  listRecent(limit: number): AuditEntry[] {
    const res: AuditEntry[] = [];
    const len = this.entries.length;
    const count = Math.min(len, Math.max(0, limit));
    for (let i = len - 1; i >= len - count; i--) {
      res.push(this.entries[i]);
    }
    return res;
  }

  clear(): void {
    this.version++;
    this.entries = [];
    void this.persist(this.entries);
    for (const l of this.listeners) l();
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

export function safeTarget(url: URL): string {
  return url.origin + url.pathname;
}
