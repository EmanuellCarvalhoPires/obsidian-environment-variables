import { AbstractInputSuggest, Editor, EditorPosition, EditorSuggest, EditorSuggestContext, EditorSuggestTriggerInfo, TFile } from "obsidian";
import type EnvironmentVariablesPlugin from "../main";
import { fillChip } from "./chip";

const TRIGGER = /\{\{\s*(secret|basic|bearer)\s*:\s*([A-Za-z0-9_]*)$/;
/** An empty, already closed reference such as "{{secret:}}" also opens the list (properties only). */
const EMPTY_CLOSED = /\{\{\s*(secret|basic|bearer)\s*:\s*\}\}$/;

function propertyTrigger(before: string): { index: number; kind: string; query: string; closed: boolean } | null {
  const open = TRIGGER.exec(before);
  if (open) return { index: open.index, kind: open[1], query: open[2], closed: false };
  const empty = EMPTY_CLOSED.exec(before);
  return empty ? { index: empty.index, kind: empty[1], query: "", closed: true } : null;
}

/** Autocompletes variable names after "{{secret:", "{{basic:" or "{{bearer:". Names only, never values; works while locked. */
export class SecretNameSuggest extends EditorSuggest<string> {
  constructor(private readonly plugin: EnvironmentVariablesPlugin) {
    super(plugin.app);
  }

  onTrigger(cursor: EditorPosition, editor: Editor, _file: TFile | null): EditorSuggestTriggerInfo | null {
    const before = editor.getLine(cursor.line).slice(0, cursor.ch);
    const match = TRIGGER.exec(before);
    if (!match) return null;
    return { start: { line: cursor.line, ch: cursor.ch - match[2].length }, end: cursor, query: match[2] };
  }

  getSuggestions(context: EditorSuggestContext): string[] {
    const q = context.query.toLowerCase();
    return this.plugin.variableNames().map((e) => e.name).filter((n) => n.toLowerCase().includes(q));
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

  protected getSuggestions(_query: string): string[] {
    if (!propertySuggestActive) return [];
    // Read up to the caret: contenteditable text often ends with an invisible line break.
    const match = propertyTrigger(textBeforeCaret(this.field));
    if (!match) return [];
    const q = match.query.toLowerCase();
    return this.plugin.variableNames().map((e) => e.name).filter((n) => n.toLowerCase().includes(q));
  }

  renderSuggestion(name: string, el: HTMLElement): void {
    el.addClass("ev-suggestion");
    fillChip(el, name);
  }

  selectSuggestion(name: string): void {
    const before = textBeforeCaret(this.field);
    const match = propertyTrigger(before);
    if (!match) return;
    const full = fieldText(this.field);
    let after = full.slice(before.length).replace(/\s+$/, "");
    if (!match.closed && after.startsWith("}}")) after = after.slice(2);
    const head = `${before.slice(0, match.index)}{{${match.kind}:${name}}}`;
    this.setValue(head + after);
    // Let Obsidian save the property, then put the caret after the reference.
    this.field.dispatchEvent(new Event("input", { bubbles: true }));
    placeCaret(this.field, head.length);
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

function fieldText(el: PropertyField): string {
  return el.instanceOf(HTMLInputElement) ? el.value : (el.textContent ?? "");
}

/** The field's text from the start to the caret (the whole text when the caret is elsewhere). */
function textBeforeCaret(el: PropertyField): string {
  if (el.instanceOf(HTMLInputElement)) return el.value.slice(0, el.selectionStart ?? el.value.length);
  const text = el.textContent ?? "";
  const selection = el.ownerDocument.getSelection();
  if (!selection || selection.rangeCount === 0 || !selection.anchorNode || !el.contains(selection.anchorNode)) return text.replace(/\s+$/, "");
  const range = el.ownerDocument.createRange();
  range.selectNodeContents(el);
  range.setEnd(selection.anchorNode, selection.anchorOffset);
  return range.toString();
}

/** Puts the caret `offset` characters into the field. */
function placeCaret(el: PropertyField, offset: number): void {
  if (el.instanceOf(HTMLInputElement)) {
    el.setSelectionRange(offset, offset);
    return;
  }
  const selection = el.ownerDocument.getSelection();
  if (!selection) return;
  const range = el.ownerDocument.createRange();
  const walker = el.ownerDocument.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let left = offset;
  let node = walker.nextNode();
  while (node) {
    const length = node.textContent?.length ?? 0;
    if (left <= length) {
      range.setStart(node, left);
      break;
    }
    left -= length;
    node = walker.nextNode();
  }
  if (!node) {
    range.selectNodeContents(el);
    range.collapse(false);
  }
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
}
