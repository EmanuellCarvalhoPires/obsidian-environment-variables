import { syntaxTree } from "@codemirror/language";
import { RangeSetBuilder } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate, WidgetType } from "@codemirror/view";
import { editorLivePreviewField, MarkdownPostProcessorContext } from "obsidian";
import { placeholderRegex } from "../engine/placeholders";
import { buildChip, ChipSource } from "./chip";
import { KnownNames } from "./properties";

/** Reading view: shows {{secret:NAME}} as a chip with a lock icon and the name. */
export function renderPlaceholders(el: HTMLElement, _ctx: MarkdownPostProcessorContext): void {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const targets: Text[] = [];
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    if (node.parentElement?.closest("pre, code, .ev-chip")) continue;
    if (placeholderRegex().test(node.data)) targets.push(node);
  }
  for (const node of targets) {
    const frag = createFragment();
    let last = 0;
    for (const m of node.data.matchAll(placeholderRegex())) {
      const index = m.index ?? 0;
      frag.append(node.data.slice(last, index));
      buildChip(frag, { raw: m[0], kind: m[1], name: m[2], field: m[3] });
      last = index + m[0].length;
    }
    frag.append(node.data.slice(last));
    node.replaceWith(frag);
  }
}

const mark = Decoration.mark({ class: "ev-placeholder" });

/** The chip shown in place of a placeholder in Live Preview. Clicking it moves the cursor in, showing the text. */
class ChipWidget extends WidgetType {
  constructor(
    private readonly src: ChipSource,
    private readonly missing: boolean,
  ) {
    super();
  }

  eq(other: ChipWidget): boolean {
    return other.src.raw === this.src.raw && other.missing === this.missing;
  }

  toDOM(): HTMLElement {
    const wrap = createSpan({ cls: "ev-chip-widget" });
    buildChip(wrap, this.src, this.missing);
    return wrap;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

/** True inside inline code or a code block: placeholders there stay as text. */
function inCode(view: EditorView, pos: number): boolean {
  const node = syntaxTree(view.state).resolveInner(pos, 1);
  return /code/i.test(node.type.name) || /code/i.test(node.parent?.type.name ?? "");
}

function build(view: EditorView, known: KnownNames): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const livePreview = view.state.field(editorLivePreviewField, false) === true;
  const names = livePreview ? known() : null;
  const selection = view.state.selection.ranges;
  for (const { from, to } of view.visibleRanges) {
    const text = view.state.doc.sliceString(from, to);
    for (const m of text.matchAll(placeholderRegex())) {
      const start = from + (m.index ?? 0);
      const end = start + m[0].length;
      const editing = selection.some((r) => r.from <= end && r.to >= start);
      if (!livePreview || editing || inCode(view, start)) {
        builder.add(start, end, mark);
        continue;
      }
      const src: ChipSource = { raw: m[0], kind: m[1], name: m[2], field: m[3] };
      builder.add(start, end, Decoration.replace({ widget: new ChipWidget(src, names !== null && !names.has(src.name)) }));
    }
  }
  return builder.finish();
}

/**
 * Editor extension. Source mode: highlights placeholders. Live Preview: shows them as chips,
 * except where the cursor is, so they can still be edited. `known` gives the variable names
 * (null when unknown, then no chip is marked as missing).
 */
export function placeholderExtension(known: KnownNames) {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = build(view, known);
      }
      update(update: ViewUpdate) {
        const modeChanged = update.startState.field(editorLivePreviewField, false) !== update.state.field(editorLivePreviewField, false);
        if (update.docChanged || update.viewportChanged || update.selectionSet || modeChanged || update.transactions.some((tr) => tr.reconfigured)) {
          this.decorations = build(update.view, known);
        }
      }
    },
    { decorations: (v) => v.decorations },
  );
}
