// NoteSource backed by Obsidian's metadata cache: tags and frontmatter come from the cache,
// links resolve like [[wikilinks]] do, and folders never matter.

import { App, TFile } from "obsidian";
import { hasTag, linkTarget, normalizeTag, NoteSource, VaultNote } from "./types";

function extractFrontmatterTags(fm: Record<string, unknown> | undefined): string[] {
  if (!fm) return [];
  const raw: string[] = [];
  for (const key of ["tags", "tag"]) {
    const val = fm[key];
    if (Array.isArray(val)) {
      for (const item of val) {
        if (typeof item === "string") raw.push(item);
        else if (item !== null && item !== undefined) raw.push(String(item));
      }
    } else if (typeof val === "string") {
      for (const part of val.split(/[\s,]+/)) {
        if (part) raw.push(part);
      }
    }
  }
  return [...new Set(raw.map((t) => normalizeTag(t)).filter(Boolean))];
}

export class ObsidianNoteSource implements NoteSource {
  constructor(private readonly app: App) {}

  byTag(tag: string): VaultNote[] {
    const out: VaultNote[] = [];
    for (const file of this.app.vault.getMarkdownFiles()) {
      const note = this.toNote(file);
      if (hasTag(note.tags, tag)) out.push(note);
    }
    return out;
  }

  get(path: string): VaultNote | undefined {
    const file = this.app.vault.getAbstractFileByPath(path);
    return file instanceof TFile && file.extension === "md" ? this.toNote(file) : undefined;
  }

  resolve(ref: string, fromPath = ""): VaultNote | undefined {
    const target = linkTarget(ref);
    if (!target) return undefined;
    let file: TFile | null = this.app.metadataCache.getFirstLinkpathDest(target, fromPath);
    if (!file) {
      const byPath = this.app.vault.getAbstractFileByPath(target) ?? this.app.vault.getAbstractFileByPath(`${target}.md`);
      if (byPath instanceof TFile) file = byPath;
    }
    return file && file.extension === "md" ? this.toNote(file) : undefined;
  }

  async read(note: VaultNote): Promise<string> {
    const file = this.app.vault.getAbstractFileByPath(note.path);
    if (!(file instanceof TFile)) throw new Error(`Note ${note.path} no longer exists.`);
    const text = await this.app.vault.cachedRead(file);
    const end = this.app.metadataCache.getFileCache(file)?.frontmatterPosition?.end.offset;
    return end !== undefined ? text.slice(end).replace(/^\r?\n/, "") : text;
  }

  private toNote(file: TFile): VaultNote {
    const cache = this.app.metadataCache.getFileCache(file);
    const frontmatter = { ...((cache?.frontmatter ?? {}) as Record<string, unknown>) };
    delete frontmatter.position;
    const tags = extractFrontmatterTags(frontmatter);
    return { path: file.path, name: file.basename, frontmatter, tags };
  }
}
