// Properties panel: a text property whose whole value is a placeholder is shown as a chip.
// Clicking the chip shows the original field again for editing. Only the DOM is touched:
// the property value itself never changes.

import { findPlaceholders } from "../engine/placeholders";
import { buildChip } from "./chip";

const FIELD_SELECTOR = ".metadata-property-value .metadata-input-longtext";
const CHIP_CLASS = "ev-prop-chip";
const HIDDEN_CLASS = "ev-prop-hidden";

/** Names in the unlocked vault, or null while locked (then no name is marked as missing). */
export type KnownNames = () => Set<string> | null;

export function decorateProperties(doc: Document, known: KnownNames): void {
  const names = known();
  for (const field of Array.from(doc.querySelectorAll<HTMLElement>(FIELD_SELECTOR))) decorate(field, names);
}

export function clearProperties(doc: Document): void {
  for (const chip of Array.from(doc.querySelectorAll(`.${CHIP_CLASS}`))) chip.remove();
  for (const field of Array.from(doc.querySelectorAll(`.${HIDDEN_CLASS}`))) field.removeClass(HIDDEN_CLASS);
}

function decorate(field: HTMLElement, names: Set<string> | null): void {
  const container = field.parentElement;
  if (!container) return;
  for (const old of Array.from(container.querySelectorAll(`:scope > .${CHIP_CLASS}`))) old.remove();
  field.removeClass(HIDDEN_CLASS);
  if (field.ownerDocument.activeElement === field) return;

  const text = field.textContent ?? "";
  const matches = findPlaceholders(text);
  if (matches.length !== 1 || text.trim() !== matches[0].raw) return;

  const match = matches[0];
  const chip = buildChip(container, match, names !== null && !names.has(match.name));
  chip.addClass(CHIP_CLASS);
  chip.tabIndex = 0;
  chip.setAttr("role", "button");
  const edit = () => {
    chip.remove();
    field.removeClass(HIDDEN_CLASS);
    field.focus();
  };
  chip.addEventListener("click", edit);
  chip.addEventListener("keydown", (evt) => {
    if (evt.key === "Enter" || evt.key === " ") {
      evt.preventDefault();
      edit();
    }
  });
  container.insertBefore(chip, field);
  field.addClass(HIDDEN_CLASS);
}
