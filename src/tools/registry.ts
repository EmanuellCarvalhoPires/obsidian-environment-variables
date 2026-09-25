// The tool registry: finds every tool note by tag, parses it and keeps the list up to date.
// This is the "script that lists all tools": MCP tools/list and the Tools panel read from here.

import { parseToolNote } from "./definition";
import { hasTag, NoteSource, ServiceChoice, ToolEntry, ToolStatus, VaultNote } from "./types";

/**
 * The value the AI passes for each instance note. The part of the names that every note shares
 * is dropped when it ends at a separator: "Jira - Acme", "Jira - Globex" → "Acme", "Globex".
 */
export function serviceChoices(notes: VaultNote[]): ServiceChoice[] {
  const sorted = [...notes].sort((a, b) => a.name.localeCompare(b.name));
  const names = sorted.map((n) => n.name);
  let prefix = "";
  if (names.length >= 2) {
    prefix = names.reduce((p, n) => {
      let i = 0;
      while (i < p.length && i < n.length && p[i] === n[i]) i++;
      return p.slice(0, i);
    });
    // Cut after the last separator, so "Jira - A" (from Acme and Assets) becomes "Jira - ".
    const cut = Math.max(prefix.lastIndexOf(" "), prefix.lastIndexOf("-"), prefix.lastIndexOf("_"));
    prefix = cut >= 0 ? prefix.slice(0, cut + 1) : "";
  }
  const ids = names.map((n) => n.slice(prefix.length).trim() || n);
  const unique = new Set(ids).size === ids.length;
  return sorted.map((n, i) => ({ id: unique ? ids[i] : n.name, notePath: n.path, noteName: n.name }));
}

export interface RegistryOptions {
  enabled: boolean;
  toolTag: string;
  scriptsEnabled: boolean;
}

export class ToolRegistry {
  private entries: ToolEntry[] = [];
  private listeners = new Set<() => void>();
  private running: Promise<void> | null = null;
  private pending = false;
  private signature = "";

  constructor(
    private readonly source: NoteSource,
    private readonly options: () => RegistryOptions,
  ) {}

  /** Rescans the vault. Calls made while a scan runs are merged into one more scan. */
  refresh(): Promise<void> {
    if (this.running) {
      this.pending = true;
      return this.running;
    }
    this.running = (async () => {
      try {
        do {
          this.pending = false;
          await this.scan();
        } while (this.pending);
      } finally {
        this.running = null;
      }
    })();
    return this.running;
  }

  /** Recomputes statuses after a settings change, without reading the notes again. */
  updateStatuses(): void {
    for (const e of this.entries) e.status = this.statusOf(e);
    this.emitIfChanged();
  }

  list(): ToolEntry[] {
    return this.entries;
  }

  /** The usable entry with this name (duplicates are invalid, so there is at most one). */
  get(name: string): ToolEntry | undefined {
    return this.entries.find((e) => e.name === name && e.status !== "invalid") ?? this.entries.find((e) => e.name === name);
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private async scan(): Promise<void> {
    const opts = this.options();
    if (!opts.enabled || !opts.toolTag.trim()) {
      this.entries = [];
      this.emitIfChanged();
      return;
    }
    const notes = this.source.byTag(opts.toolTag).sort((a, b) => a.path.localeCompare(b.path));
    const next: ToolEntry[] = [];
    for (const note of notes) {
      let body = "";
      try {
        body = await this.source.read(note);
      } catch {
        // A note deleted during the scan: skip it, the next event triggers another scan.
        continue;
      }
      const parsed = parseToolNote({ ...note, body });
      const entry: ToolEntry = { ...parsed, status: "invalid" };
      if (entry.serviceTag && entry.serviceParam) this.addServiceChoices(entry, entry.serviceTag, entry.serviceParam);
      next.push(entry);
    }

    // Two notes with the same tool name: both are invalid until one is renamed.
    const byName = new Map<string, ToolEntry[]>();
    for (const e of next) {
      if (e.problems.some((p) => p.startsWith("Missing \"tool\"") || p.startsWith("Invalid tool name"))) continue;
      byName.set(e.name, [...(byName.get(e.name) ?? []), e]);
    }
    for (const group of byName.values()) {
      if (group.length < 2) continue;
      for (const e of group) {
        const others = group.filter((o) => o !== e).map((o) => o.notePath);
        e.problems.push(`Duplicate tool name "${e.name}", also used in: ${others.join(", ")}.`);
      }
    }

    for (const e of next) e.status = this.statusOf(e);
    this.entries = next;
    this.emitIfChanged();
  }

  /** Generic tools: one argument picks the service note, among the notes with the tag. */
  private addServiceChoices(entry: ToolEntry, tag: string, param: string): void {
    const exclude = entry.serviceExcludeTag;
    const notes = this.source.byTag(tag).filter((n) => !exclude || !hasTag(n.tags, exclude));
    const choices = serviceChoices(notes);
    entry.serviceChoices = choices;
    if (choices.length === 0) {
      entry.problems.push(`No service notes found with the tag #${tag}${exclude ? ` (without #${exclude})` : ""}. Create one note per instance with that tag.`);
      return;
    }
    const ids = choices.map((c) => c.id);
    entry.params = {
      [param]: {
        type: "string",
        required: true,
        enum: ids,
        description: `Which instance to use: ${ids.join(", ")}. Each value is a note tagged #${tag}.`,
      },
      ...entry.params,
    };
  }

  private statusOf(e: ToolEntry): ToolStatus {
    if (e.problems.length) return "invalid";
    // Permission to run a tool is asked by the AI client (e.g. Claude Code), not by the plugin.
    if (e.kind === "script" && !this.options().scriptsEnabled) return "scripts-disabled";
    return "ready";
  }

  private emitIfChanged(): void {
    const sig = JSON.stringify(this.entries);
    if (sig === this.signature) return;
    this.signature = sig;
    for (const l of this.listeners) l();
  }
}
