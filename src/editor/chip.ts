import { setIcon, setTooltip } from "obsidian";
import { t } from "../i18n";

/** Lucide icon shown before a variable name (reading view, properties, autocomplete). */
export const CHIP_ICON = "lock-keyhole";

export interface ChipSource {
  raw: string;
  kind: string;
  name: string;
  field?: string;
}

/** Appends the lock icon and the variable name to `el`. Never shows a value. */
export function fillChip(el: HTMLElement, name: string, field?: string): void {
  setIcon(el.createSpan({ cls: "ev-chip-icon" }), CHIP_ICON);
  el.createSpan({ cls: "ev-chip-name", text: field ? `${name}.${field}` : name });
}

/** A "[lock] NAME" chip for a placeholder. `missing` marks a name that is not in the unlocked vault. */
export function buildChip(parent: HTMLElement | DocumentFragment, src: ChipSource, missing = false): HTMLElement {
  const chip = parent.createSpan({ cls: missing ? "ev-chip ev-chip-missing" : "ev-chip", attr: { "data-kind": src.kind } });
  fillChip(chip, src.name, src.field);
  setTooltip(chip, missing ? t("chip.missing", { name: src.name }) : src.raw);
  return chip;
}
