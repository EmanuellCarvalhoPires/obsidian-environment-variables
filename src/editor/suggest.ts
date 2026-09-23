import { Editor, EditorPosition, EditorSuggest, EditorSuggestContext, EditorSuggestTriggerInfo, TFile } from "obsidian";
import type EnvironmentVariablesPlugin from "../main";

const TRIGGER = /\{\{\s*(secret|basic|bearer)\s*:\s*([A-Za-z0-9_]*)$/;

/** Autocompletes variable names after "{{secret:", "{{basic:" or "{{bearer:". Names only, never values. */
export class SecretNameSuggest extends EditorSuggest<string> {
  constructor(private readonly plugin: EnvironmentVariablesPlugin) {
    super(plugin.app);
  }

  onTrigger(cursor: EditorPosition, editor: Editor, _file: TFile | null): EditorSuggestTriggerInfo | null {
    if (!this.plugin.store.isUnlocked) return null;
    const before = editor.getLine(cursor.line).slice(0, cursor.ch);
    const match = TRIGGER.exec(before);
    if (!match) return null;
    return { start: { line: cursor.line, ch: cursor.ch - match[2].length }, end: cursor, query: match[2] };
  }

  getSuggestions(context: EditorSuggestContext): string[] {
    const q = context.query.toLowerCase();
    return this.plugin.store.names().filter((n) => n.toLowerCase().startsWith(q) || n.toLowerCase().includes(q));
  }

  renderSuggestion(name: string, el: HTMLElement): void {
    el.createSpan({ text: "🔒 " });
    el.createSpan({ text: name });
  }

  selectSuggestion(name: string): void {
    const ctx = this.context;
    if (!ctx) return;
    const line = ctx.editor.getLine(ctx.end.line);
    const closes = line.slice(ctx.end.ch).startsWith("}}");
    ctx.editor.replaceRange(closes ? name : `${name}}}`, ctx.start, ctx.end);
    const ch = ctx.start.ch + name.length + 2;
    ctx.editor.setCursor({ line: ctx.start.line, ch });
  }
}
