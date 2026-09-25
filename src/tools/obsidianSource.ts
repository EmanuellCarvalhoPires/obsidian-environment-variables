// NoteSource backed by Obsidian's metadata cache: tags and frontmatter come from the cache,
// links resolve like [[wikilinks]] do, and folders never matter.

import { App, getAllTags, TFile } from "obsidian";
import { hasTag, linkTarget, normalizeTag, NoteSource, VaultNote } from "./types";

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
    const tags = [...new Set((cache ? (getAllTags(cache) ?? []) : []).map(normalizeTag))];
    const frontmatter = { ...((cache?.frontmatter ?? {}) as Record<string, unknown>) };
    delete frontmatter.position;
    return { path: file.path, name: file.basename, frontmatter, tags };
  }
}
