import { Setting } from "obsidian";
import { t } from "../i18n";

const LOGO_TYPES = "image/png,image/svg+xml,image/jpeg,image/webp";
const MAX_LOGO_BYTES = 200 * 1024;

/**
 * A Setting with an image preview and a "Choose image" button that reads the picked
 * file as a data URI. Shared by the MCP and app modals.
 */
export function addLogoSetting(contentEl: HTMLElement, initial: string, onError: (message: string) => void, onChange: (dataUri: string) => void): void {
  const setting = new Setting(contentEl).setName(t("modal.logoPicker.label")).setDesc(t("modal.logoPicker.desc"));
  const preview = setting.controlEl.createEl("img", { cls: "ev-mcp-logo-preview" });
  preview.toggleClass("is-empty", !initial);
  if (initial) preview.src = initial;

  const fileInput = contentEl.createEl("input", { cls: "ev-hidden-file-input", attr: { type: "file", accept: LOGO_TYPES } });
  fileInput.addEventListener("change", () => {
    const file = fileInput.files?.[0];
    fileInput.value = "";
    if (!file) return;
    if (file.size > MAX_LOGO_BYTES) return onError(t("modal.logoPicker.tooBig"));
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result !== "string") return;
      preview.src = reader.result;
      preview.toggleClass("is-empty", false);
      onError("");
      onChange(reader.result);
    };
    reader.readAsDataURL(file);
  });
  setting.addButton((b) => b.setButtonText(t("modal.logoPicker.choose")).onClick(() => fileInput.click()));
}
