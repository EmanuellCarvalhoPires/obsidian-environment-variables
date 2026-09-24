import { AbstractInputSuggest, Editor, EditorPosition, EditorSuggest, EditorSuggestContext, EditorSuggestTriggerInfo, TFile } from "obsidian";
import type EnvironmentVariablesPlugin from "../main";
import { fillChip } from "./chip";

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
    el.addClass("ev-suggestion");
    fillChip(el, name);
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

type PropertyField = HTMLInputElement | HTMLDivElement;

/** The same autocomplete for property values (the Properties panel is not a CodeMirror editor). */
class PropertySecretSuggest extends AbstractInputSuggest<string> {
  constructor(
    private readonly plugin: EnvironmentVariablesPlugin,
    private readonly field: PropertyField,
  ) {
    super(plugin.app, field);
  }

  protected getSuggestions(query: string): string[] {
    if (!propertySuggestActive || !this.plugin.store.isUnlocked) return [];
    const match = TRIGGER.exec(query);
    if (!match) return [];
    const q = match[2].toLowerCase();
    return this.plugin.store.names().filter((n) => n.toLowerCase().includes(q));
  }

  renderSuggestion(name: string, el: HTMLElement): void {
    el.addClass("ev-suggestion");
    fillChip(el, name);
  }

  selectSuggestion(name: string): void {
    const value = this.getValue();
    const match = TRIGGER.exec(value);
    if (!match) return;
    const next = `${value.slice(0, match.index)}{{${match[1]}:${name}}}`;
    this.setValue(next);
    // Let Obsidian save the property, then put the caret after the reference.
    this.field.dispatchEvent(new Event("input", { bubbles: true }));
    placeCaretAtEnd(this.field);
    this.close();
  }
}

const attached = new WeakSet<PropertyField>();
let propertySuggestActive = false;

/** Fields keep their listeners after the plugin unloads; this makes them stay silent. */
export function setPropertySuggestActive(active: boolean): void {
  propertySuggestActive = active;
}

/** Called on focus: adds the autocomplete to a property value field, once per field. */
export function attachPropertySuggest(plugin: EnvironmentVariablesPlugin, target: EventTarget | null): void {
  // instanceOf (not instanceof) also works for fields in popout windows.
  const node = target as Node | null;
  if (!node?.instanceOf?.(HTMLElement)) return;
  const el = node;
  if (!el.closest(".metadata-property-value")) return;
  const field = el.instanceOf(HTMLInputElement) ? el : el.instanceOf(HTMLDivElement) && el.isContentEditable ? el : null;
  if (!field || attached.has(field)) return;
  attached.add(field);
  new PropertySecretSuggest(plugin, field);
}

function placeCaretAtEnd(el: PropertyField): void {
  if (el instanceof HTMLInputElement) {
    el.setSelectionRange(el.value.length, el.value.length);
    return;
  }
  const selection = el.ownerDocument.getSelection();
  if (!selection) return;
  const range = el.ownerDocument.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  selection.removeAllRanges();
  selection.addRange(range);
}
