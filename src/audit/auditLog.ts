export type AuditOutcome = "ok" | "denied" | "blocked" | "locked" | "error";

export interface AuditEntry {
  time: string;
  client: string;
  action: "request" | "list";
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

  constructor(
    initial: AuditEntry[] = [],
    private readonly persist: (entries: AuditEntry[]) => void | Promise<void> = () => undefined,
  ) {
    this.entries = initial.slice(-MAX_AUDIT_ENTRIES);
  }

  add(entry: Omit<AuditEntry, "time">): void {
    this.entries.push({ time: new Date().toISOString(), ...entry });
    if (this.entries.length > MAX_AUDIT_ENTRIES) this.entries.splice(0, this.entries.length - MAX_AUDIT_ENTRIES);
    void this.persist(this.entries);
    for (const l of this.listeners) l();
  }

  list(): AuditEntry[] {
    return [...this.entries].reverse();
  }

  clear(): void {
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
