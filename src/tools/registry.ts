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

function choiceKey(e: ToolEntry): string {
  return `${e.serviceTag ?? ""}|${e.serviceExcludeTag ?? ""}`;
}

export interface RegistryOptions {
  enabled: boolean;
  toolTag: string;
  scriptsEnabled: boolean;
}

/**
 * Keeps the tool list up to date by reading only the notes that matter to it:
 * tool notes (toolTag) and the instance notes of generic tools (serviceTag).
 * Other notes are ignored, so editing them costs nothing.
 */
export class ToolRegistry {
  private entries: ToolEntry[] = [];
  private listeners = new Set<() => void>();
  private running: Promise<void> | null = null;
  private pending = false;
  private signature = "";

  /** Parsed tool notes by path, before duplicates, instances and statuses are applied. */
  private parsed = new Map<string, ToolEntry>();
  /** Instance choices by "tag|excludeTag", rebuilt when an instance note changes. */
  private choices = new Map<string, ServiceChoice[]>();
  /** Paths of the notes currently used as instances. */
  private servicePaths = new Set<string>();
  /** Everything must be read again (first scan, settings change, refresh()). */
  private needsFull = true;
  /** Tool notes to read again. */
  private dirtyTools = new Set<string>();
  /** An instance note changed: the choices must be rebuilt. */
  private servicesDirty = false;

  constructor(
    private readonly source: NoteSource,
    private readonly options: () => RegistryOptions,
  ) {}

  /** Rescans every tool note. Calls made while a scan runs are merged into one more scan. */
  refresh(): Promise<void> {
    this.needsFull = true;
    return this.ensureFresh();
  }

  /** Applies the pending note changes, if any. Call before answering the AI. */
  ensureFresh(): Promise<void> {
    if (this.running) {
      if (this.isDirty()) this.pending = true;
      return this.running;
    }
    if (!this.isDirty()) return Promise.resolve();
    this.running = (async () => {
      try {
        do {
          this.pending = false;
          await this.update();
        } while (this.pending || this.isDirty());
      } finally {
        this.running = null;
      }
    })();
    return this.running;
  }

  /**
   * A note was created or changed. Returns true when it matters to the tools
   * (it is or was a tool note or an instance note); the change is applied by ensureFresh().
   */
  noteChanged(path: string): boolean {
    if (this.needsFull) return true;
    const opts = this.options();
    if (!opts.enabled || !opts.toolTag.trim()) return false;
    const note = this.source.get(path);
    let relevant = false;
    if (this.parsed.has(path) || (note && hasTag(note.tags, opts.toolTag))) {
      this.dirtyTools.add(path);
      relevant = true;
    }
    if (this.servicePaths.has(path) || (note && this.isServiceNote(note.tags))) {
      this.servicesDirty = true;
      relevant = true;
    }
    return relevant;
  }

  /** A note was deleted. Returns true when it matters to the tools. */
  noteDeleted(path: string): boolean {
    if (this.needsFull) return true;
    let relevant = false;
    if (this.parsed.has(path)) {
      this.dirtyTools.add(path);
      relevant = true;
    }
    if (this.servicePaths.has(path)) {
      this.servicesDirty = true;
      relevant = true;
    }
    return relevant;
  }

  /** A note was renamed or moved. Returns true when it matters to the tools. */
  noteRenamed(oldPath: string, newPath: string): boolean {
    const before = this.noteDeleted(oldPath);
    const after = this.noteChanged(newPath);
    return before || after;
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

  private isDirty(): boolean {
    return this.needsFull || this.servicesDirty || this.dirtyTools.size > 0;
  }

  /** True when the tags make the note an instance of some generic tool. */
  private isServiceNote(tags: string[]): boolean {
    for (const e of this.parsed.values()) {
      if (e.serviceTag && hasTag(tags, e.serviceTag)) return true;
    }
    return false;
  }

  /** Reads the changed notes (or all of them) and rebuilds the list. */
  private async update(): Promise<void> {
    const opts = this.options();
    if (!opts.enabled || !opts.toolTag.trim()) {
      this.needsFull = false;
      this.dirtyTools.clear();
      this.servicesDirty = false;
      this.parsed.clear();
      this.clearChoices();
      this.entries = [];
      this.emitIfChanged();
      return;
    }

    if (this.needsFull) {
      this.needsFull = false;
      this.dirtyTools.clear();
      this.servicesDirty = false;
      this.parsed.clear();
      this.clearChoices();
      for (const note of this.source.byTag(opts.toolTag)) await this.readTool(note.path, note);
    } else {
      const paths = [...this.dirtyTools];
      this.dirtyTools.clear();
      const tagsBefore = this.serviceKeys();
      for (const path of paths) {
        const note = this.source.get(path);
        if (note && hasTag(note.tags, opts.toolTag)) await this.readTool(path, note);
        else this.parsed.delete(path);
      }
      // A tool that starts using another instance tag needs choices that were never built.
      if ([...this.serviceKeys()].some((k) => !tagsBefore.has(k))) this.servicesDirty = true;
      if (this.servicesDirty) {
        this.servicesDirty = false;
        this.clearChoices();
      }
    }
    this.build();
  }

  private async readTool(path: string, note: VaultNote): Promise<void> {
    let body = "";
    try {
      body = await this.source.read(note);
    } catch {
      // A note deleted while reading: drop it, the delete event does the rest.
      this.parsed.delete(path);
      return;
    }
    this.parsed.set(path, { ...parseToolNote({ ...note, body }), status: "invalid" });
  }

  private serviceKeys(): Set<string> {
    const keys = new Set<string>();
    for (const e of this.parsed.values()) if (e.serviceTag && e.serviceParam) keys.add(choiceKey(e));
    return keys;
  }

  private clearChoices(): void {
    this.choices.clear();
    this.servicePaths.clear();
  }

  /** Builds the final entries from the parsed notes. Reads nothing. */
  private build(): void {
    const next: ToolEntry[] = [];
    for (const path of [...this.parsed.keys()].sort((a, b) => a.localeCompare(b))) {
      const base = this.parsed.get(path)!;
      // Copies: duplicates and instances add problems and params that must not stick to the cache.
      const entry: ToolEntry = { ...base, params: { ...base.params }, problems: [...base.problems], warnings: [...base.warnings] };
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
    const key = choiceKey(entry);
    let choices = this.choices.get(key);
    if (!choices) {
      const tagged = this.source.byTag(tag);
      choices = serviceChoices(tagged.filter((n) => !exclude || !hasTag(n.tags, exclude)));
      this.choices.set(key, choices);
      // Every note with the tag counts, excluded ones too: removing the exclude tag changes the choices.
      for (const n of tagged) this.servicePaths.add(n.path);
    }
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
