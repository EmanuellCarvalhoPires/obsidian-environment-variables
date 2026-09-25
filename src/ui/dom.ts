import { setIcon } from "obsidian";

/** A line of text with an Obsidian icon in front, instead of symbols such as a check mark or a warning sign. */
export function iconLine(parent: HTMLElement, icon: string, text: string, cls: string): HTMLElement {
  const line = parent.createDiv({ cls: `ev-icon-line ${cls}` });
  setIcon(line.createSpan({ cls: "ev-icon-line-icon" }), icon);
  line.createSpan({ text });
  return line;
}
