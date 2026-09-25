import { hasTag, linkTarget, normalizeTag, NoteSource, VaultNote } from "../src/tools/types";

/** An in-memory vault: notes found by tag and by name, like the Obsidian source. */
export class MemorySource implements NoteSource {
  private notes = new Map<string, { note: VaultNote; body: string }>();

  add(path: string, frontmatter: Record<string, unknown>, body = ""): VaultNote {
    const name = path.split("/").pop()!.replace(/\.md$/, "");
    const fmTags = frontmatter.tags;
    const tags = (Array.isArray(fmTags) ? fmTags : fmTags ? [fmTags] : []).map((t) => normalizeTag(String(t)));
    const note: VaultNote = { path, name, frontmatter, tags };
    this.notes.set(path, { note, body });
    return note;
  }

  remove(path: string): void {
    this.notes.delete(path);
  }

  byTag(tag: string): VaultNote[] {
    return [...this.notes.values()].map((n) => n.note).filter((n) => hasTag(n.tags, tag));
  }

  resolve(ref: string): VaultNote | undefined {
    const target = linkTarget(ref);
    for (const { note } of this.notes.values()) {
      if (note.name === target || note.path === target || note.path === `${target}.md`) return note;
    }
    return undefined;
  }

  async read(note: VaultNote): Promise<string> {
    const found = this.notes.get(note.path);
    if (!found) throw new Error("gone");
    return found.body;
  }
}

export const fence = "```";
