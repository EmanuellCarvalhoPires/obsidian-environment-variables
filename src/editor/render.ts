import { RangeSetBuilder } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate } from "@codemirror/view";
import { MarkdownPostProcessorContext } from "obsidian";
import { placeholderRegex } from "../engine/placeholders";

/** Reading view: shows {{secret:NAME}} as a "🔒 NAME" chip. */
export function renderPlaceholders(el: HTMLElement, _ctx: MarkdownPostProcessorContext): void {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const targets: Text[] = [];
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    if (node.parentElement?.closest("pre, .ev-chip")) continue;
    if (placeholderRegex().test(node.data)) targets.push(node);
  }
  for (const node of targets) {
    const frag = createFragment();
    let last = 0;
    for (const m of node.data.matchAll(placeholderRegex())) {
      const index = m.index ?? 0;
      frag.append(node.data.slice(last, index));
      const chip = createSpan({ cls: "ev-chip", attr: { "aria-label": m[0], "data-kind": m[1] } });
      chip.setText(`🔒 ${m[2]}${m[3] ? "." + m[3] : ""}`);
      frag.append(chip);
      last = index + m[0].length;
    }
    frag.append(node.data.slice(last));
    node.replaceWith(frag);
  }
}

const mark = Decoration.mark({ class: "ev-placeholder" });

function build(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  for (const { from, to } of view.visibleRanges) {
    const text = view.state.doc.sliceString(from, to);
    for (const m of text.matchAll(placeholderRegex())) {
      const start = from + (m.index ?? 0);
      builder.add(start, start + m[0].length, mark);
    }
  }
  return builder.finish();
}

/** Live Preview / source mode: highlights placeholders so they are easy to spot. */
export const placeholderHighlighter = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = build(view);
    }
    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged) this.decorations = build(update.view);
    }
  },
  { decorations: (v) => v.decorations },
);
