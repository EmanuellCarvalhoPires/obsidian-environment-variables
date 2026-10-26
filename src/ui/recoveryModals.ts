import { App, Modal, Notice, Setting } from "obsidian";
import { t } from "../i18n";
import { MIN_PASSWORD_LENGTH, SecretStore } from "../store/secretStore";

export class ShowRecoveryKeyModal extends Modal {
  constructor(
    app: App,
    private readonly recoveryKey: string,
    private readonly onDone?: () => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("ev-recovery-modal");

    this.titleEl.setText(t("view.recovery.showTitle"));
    contentEl.createEl("p", { text: t("view.recovery.showBody"), cls: "ev-muted" });

    const keyBox = contentEl.createDiv({ cls: "ev-recovery-key-box" });
    keyBox.setText(this.recoveryKey);

    new Setting(contentEl)
      .addButton((b) =>
        b
          .setButtonText(t("view.recovery.copy"))
          .setIcon("copy")
          .onClick(() => {
            void navigator.clipboard.writeText(this.recoveryKey);
            new Notice(t("view.recovery.copied"));
          }),
      )
      .addButton((b) =>
        b
          .setButtonText(t("view.recovery.savedConfirmation"))
          .setCta()
          .onClick(() => {
            this.close();
            this.onDone?.();
          }),
      );
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

export class ForgotPasswordModal extends Modal {
  private activeTab: "recover" | "reset" = "recover";

  constructor(
    app: App,
    private readonly store: SecretStore,
    private readonly onComplete: () => void,
  ) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText(t("view.forgot.title"));
    this.render();
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("ev-forgot-modal");

    const tabsRow = contentEl.createDiv({ cls: "ev-tabs" });

    const recoverTabBtn = tabsRow.createEl("button", { text: t("view.forgot.recoverTab") });
    if (this.activeTab === "recover") recoverTabBtn.addClass("mod-cta");
    recoverTabBtn.onclick = () => {
      this.activeTab = "recover";
      this.render();
    };

    const resetTabBtn = tabsRow.createEl("button", { text: t("view.forgot.resetTab") });
    if (this.activeTab === "reset") resetTabBtn.addClass("mod-warning");
    resetTabBtn.onclick = () => {
      this.activeTab = "reset";
      this.render();
    };

    if (this.activeTab === "recover") {
      this.renderRecoverForm(contentEl);
    } else {
      this.renderResetForm(contentEl);
    }
  }

  private renderRecoverForm(container: HTMLElement): void {
    container.createEl("p", { text: t("view.forgot.recoverDesc"), cls: "ev-muted" });

    let codeVal = "";
    let passVal = "";
    let confirmVal = "";
    let errorEl = container.createDiv({ cls: "ev-error" });
    errorEl.addClass("ev-hidden");

    new Setting(container).setName(t("view.forgot.recoveryCode")).addText((txt) => {
      txt.setPlaceholder("XXXX-XXXX-XXXX-XXXX-...");
      txt.onChange((v) => (codeVal = v));
    });

    new Setting(container).setName(t("view.forgot.newPassword")).addText((txt) => {
      txt.inputEl.type = "password";
      txt.onChange((v) => (passVal = v));
    });

    new Setting(container).setName(t("view.forgot.confirmPassword")).addText((txt) => {
      txt.inputEl.type = "password";
      txt.onChange((v) => (confirmVal = v));
    });

    new Setting(container)
      .addButton((b) => b.setButtonText(t("modal.secret.cancel")).onClick(() => this.close()))
      .addButton((b) =>
        b
          .setButtonText(t("view.forgot.recoverButton"))
          .setCta()
          .onClick(() => {
            void (async () => {
              errorEl.addClass("ev-hidden");
              if (passVal !== confirmVal) {
                errorEl.setText(t("view.create.mismatch"));
                errorEl.removeClass("ev-hidden");
                return;
              }
              if (passVal.length < MIN_PASSWORD_LENGTH) {
                errorEl.setText(t("strength.0"));
                errorEl.removeClass("ev-hidden");
                return;
              }
              b.setDisabled(true);
              try {
                const newRec = await this.store.recoverWithCode(codeVal, passVal);
                this.close();
                new ShowRecoveryKeyModal(this.app, newRec, this.onComplete).open();
              } catch (err) {
                errorEl.setText(err instanceof Error ? err.message : String(err));
                errorEl.removeClass("ev-hidden");
                b.setDisabled(false);
              }
            })();
          }),
      );
  }

  private renderResetForm(container: HTMLElement): void {
    container.createEl("p", { text: t("view.forgot.resetDesc"), cls: "ev-muted" });
    container.createEl("p", { text: t("view.forgot.resetWarning"), cls: "ev-warning" });

    let confirmInput = "";
    new Setting(container).addText((txt) => {
      txt.setPlaceholder("RESET / RESETAR");
      txt.onChange((v) => (confirmInput = v.trim().toUpperCase()));
    });

    new Setting(container)
      .addButton((b) => b.setButtonText(t("modal.secret.cancel")).onClick(() => this.close()))
      .addButton((b) =>
        b
          .setButtonText(t("view.forgot.resetButton"))
          .setDestructive()
          .onClick(() => {
            if (confirmInput !== "RESET" && confirmInput !== "RESETAR") {
              new Notice("Confirma??o incorreta. Digite RESET ou RESETAR.");
              return;
            }
            void (async () => {
              b.setDisabled(true);
              try {
                await this.store.resetVault();
                new Notice(t("view.forgot.resetSuccess"));
                this.close();
                this.onComplete();
              } catch (err) {
                new Notice(err instanceof Error ? err.message : String(err));
                b.setDisabled(false);
              }
            })();
          }),
      );
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

export class ChangePasswordModal extends Modal {
  constructor(
    app: App,
    private readonly store: SecretStore,
    private readonly onDone?: () => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("ev-change-password-modal");

    this.titleEl.setText(t("view.changeModal.title"));

    let currentVal = "";
    let nextVal = "";
    let confirmVal = "";
    const errorEl = contentEl.createDiv({ cls: "ev-error" });
    errorEl.addClass("ev-hidden");

    new Setting(contentEl).setName(t("view.changeModal.current")).addText((txt) => {
      txt.inputEl.type = "password";
      txt.onChange((v) => (currentVal = v));
    });

    new Setting(contentEl).setName(t("view.changeModal.new")).addText((txt) => {
      txt.inputEl.type = "password";
      txt.onChange((v) => (nextVal = v));
    });

    new Setting(contentEl).setName(t("view.changeModal.confirm")).addText((txt) => {
      txt.inputEl.type = "password";
      txt.onChange((v) => (confirmVal = v));
    });

    new Setting(contentEl)
      .addButton((b) => b.setButtonText(t("modal.secret.cancel")).onClick(() => this.close()))
      .addButton((b) =>
        b
          .setButtonText(t("view.changeModal.button"))
          .setCta()
          .onClick(() => {
            void (async () => {
              errorEl.addClass("ev-hidden");
              if (nextVal !== confirmVal) {
                errorEl.setText(t("view.create.mismatch"));
                errorEl.removeClass("ev-hidden");
                return;
              }
              if (nextVal.length < MIN_PASSWORD_LENGTH) {
                errorEl.setText(t("strength.0"));
                errorEl.removeClass("ev-hidden");
                return;
              }
              b.setDisabled(true);
              try {
                const newRec = await this.store.changePassword(currentVal, nextVal);
                new Notice(t("view.changeModal.success"));
                this.close();
                new ShowRecoveryKeyModal(this.app, newRec, this.onDone).open();
              } catch (err) {
                errorEl.setText(err instanceof Error ? err.message : String(err));
                errorEl.removeClass("ev-hidden");
                b.setDisabled(false);
              }
            })();
          }),
      );
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
