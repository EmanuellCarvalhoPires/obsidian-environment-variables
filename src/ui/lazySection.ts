import { setIcon } from "obsidian";

/** A section that opens and closes, mounting its body only on the first open and retaining it. */
export function lazySection(
  parent: HTMLElement,
  title: string,
  open: boolean,
  onToggle: (open: boolean) => void,
  renderBody: (body: HTMLElement) => void,
): HTMLElement {
  const details = parent.createEl("details", { cls: "ev-group" });
  details.open = open;
  const summary = details.createEl("summary", { cls: "ev-group-title" });
  setIcon(summary.createSpan({ cls: "ev-group-chevron" }), "chevron-right");
  summary.createSpan({ text: title });

  const body = details.createDiv({ cls: "ev-group-body" });
  let rendered = false;

  const ensureRendered = () => {
    if (!rendered && details.open) {
      rendered = true;
      renderBody(body);
    }
  };

  if (open) {
    ensureRendered();
  }

  details.addEventListener("toggle", () => {
    ensureRendered();
    onToggle(details.open);
  });

  return body;
}
