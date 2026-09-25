import { App, Modal, Setting } from "obsidian";
import { iconLine } from "./dom";
import { t } from "../i18n";
import { ToolEntry } from "../tools/types";

function display(v: unknown): string {
  return typeof v === "string" ? v : typeof v === "number" || typeof v === "boolean" ? String(v) : JSON.stringify(v);
}

/** Runs a tool from the panel with a form built from its parameters. */
export class ToolRunModal extends Modal {
  private values: Record<string, string | boolean> = {};

  constructor(
    app: App,
    private readonly tool: ToolEntry,
    private readonly run: (args: Record<string, unknown>) => Promise<unknown>,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl, tool } = this;
    this.titleEl.setText(t("modal.toolRun.title", { name: tool.name }));
    contentEl.addClass("ev-tool-modal");
    contentEl.createEl("p", { text: tool.description, cls: "ev-muted" });
    contentEl.createEl("p", { text: t("modal.toolRun.body"), cls: "ev-muted" });
    if (tool.writes) iconLine(contentEl, "alert-triangle", t("modal.toolRun.writes"), "ev-warning ev-modal-warning");

    for (const [name, spec] of Object.entries(tool.params)) {
      const setting = new Setting(contentEl).setName(spec.required ? `${name} *` : name).setDesc(spec.description ?? spec.type);
      if (spec.type === "boolean") {
        const initial = spec.default === true;
        this.values[name] = initial;
        setting.addToggle((tg) => tg.setValue(initial).onChange((v) => (this.values[name] = v)));
      } else if (spec.enum) {
        setting.addDropdown((dd) => {
          dd.addOption("", "");
          for (const option of spec.enum ?? []) dd.addOption(String(option), String(option));
          if (spec.default !== undefined) {
            dd.setValue(display(spec.default));
            this.values[name] = display(spec.default);
          }
          dd.onChange((v) => (this.values[name] = v));
        });
      } else if (spec.type === "object" || spec.type === "array") {
        setting.addTextArea((ta) => {
          ta.setPlaceholder(spec.type === "array" ? "[]" : "{}").onChange((v) => (this.values[name] = v));
          if (spec.default !== undefined) ta.setValue(JSON.stringify(spec.default));
        });
      } else {
        setting.addText((txt) => {
          if (spec.default !== undefined) txt.setPlaceholder(display(spec.default));
          txt.onChange((v) => (this.values[name] = v));
        });
      }
    }

    const error = contentEl.createDiv({ cls: "ev-error" });
    const output = contentEl.createDiv();
    new Setting(contentEl).addButton((b) =>
      b
        .setButtonText(t("modal.toolRun.run"))
        .setCta()
        .onClick(() => {
          error.setText("");
          const args = this.collect(error);
          if (!args) return;
          b.setDisabled(true).setButtonText(t("modal.toolRun.running"));
          output.empty();
          void this.run(args)
            .then((value) => {
              output.createEl("h6", { text: t("modal.toolRun.result") });
              output.createEl("pre", { text: typeof value === "string" ? value : JSON.stringify(value, null, 2), cls: "ev-tool-code" });
            })
            .catch((err: unknown) => error.setText(err instanceof Error ? err.message : String(err)))
            .finally(() => b.setDisabled(false).setButtonText(t("modal.toolRun.run")));
        }),
    );
  }

  /** Converts the form values to typed arguments. Empty fields are left out so defaults apply. */
  private collect(error: HTMLElement): Record<string, unknown> | null {
    const out: Record<string, unknown> = {};
    for (const [name, spec] of Object.entries(this.tool.params)) {
      const raw = this.values[name];
      if (raw === undefined || raw === "") continue;
      if (spec.type === "boolean") out[name] = raw === true;
      else if (spec.type === "number" || spec.type === "integer") {
        const n = Number(raw);
        if (!Number.isFinite(n)) {
          error.setText(t("modal.toolRun.badNumber", { name }));
          return null;
        }
        out[name] = n;
      } else if (spec.type === "object" || spec.type === "array") {
        try {
          out[name] = JSON.parse(String(raw));
        } catch {
          error.setText(t("modal.toolRun.badJson", { name }));
          return null;
        }
      } else out[name] = String(raw);
    }
    return out;
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
