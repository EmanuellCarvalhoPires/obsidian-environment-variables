import { App, Modal, Notice, Setting, SuggestModal } from "obsidian";
import { ApprovalRequest } from "../engine/broker";
import { isValidPattern, parsePattern, wildcardRisk } from "../engine/hosts";
import { ClientAccess } from "../server/clients";
import { t } from "../i18n";
import { SecretInput, SecretStore } from "../store/secretStore";
import { ApprovalPolicy, SecretRecord, SecretType } from "../store/types";

const TYPES: SecretType[] = ["token", "basic", "bearer", "header", "env"];
const APPROVALS: ApprovalPolicy[] = ["never", "writes", "always"];

export function referenceFor(secret: Pick<SecretRecord, "name" | "type">): string {
  if (secret.type === "basic") return `{{basic:${secret.name}}}`;
  if (secret.type === "bearer") return `{{bearer:${secret.name}}}`;
  return `{{secret:${secret.name}}}`;
}

/** Create or edit a variable. The current value is never shown. */
export class SecretModal extends Modal {
  private draft: SecretInput;

  constructor(
    app: App,
    private readonly store: SecretStore,
    private readonly existing: SecretRecord | null,
    private readonly onSaved: (secret: SecretRecord) => void = () => undefined,
    prefillValue = "",
  ) {
    super(app);
    const base = existing ?? {
      name: "",
      type: "token" as SecretType,
      username: "",
      value: "",
      description: "",
      allowedHosts: [],
      allowHttpLocalhost: false,
      placement: { headers: true as const, url: false, body: false },
      approval: "writes" as ApprovalPolicy,
    };
    this.draft = {
      name: base.name,
      type: base.type,
      username: base.username ?? "",
      value: existing ? "" : prefillValue,
      description: base.description,
      allowedHosts: [...base.allowedHosts],
      allowHttpLocalhost: base.allowHttpLocalhost,
      placement: { ...base.placement },
      approval: base.approval,
    };
  }

  onOpen(): void {
    this.titleEl.setText(this.existing ? t("modal.secret.edit", { name: this.existing.name }) : t("modal.secret.new"));
    this.render();
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("ev-secret-modal");

    new Setting(contentEl)
      .setName(t("modal.secret.name"))
      .setDesc(t("modal.secret.nameDesc"))
      .addText((txt) =>
        txt
          .setPlaceholder("JIRA_ACME")
          .setValue(this.draft.name)
          .onChange((v) => (this.draft.name = v.trim())),
      );

    new Setting(contentEl).setName(t("modal.secret.type")).addDropdown((dd) => {
      for (const type of TYPES) dd.addOption(type, t(`type.${type}`));
      dd.setValue(this.draft.type).onChange((v) => {
        this.draft.type = v as SecretType;
        this.render();
      });
    });

    if (this.draft.type === "basic") {
      new Setting(contentEl).setName(t("modal.secret.username")).addText((txt) =>
        txt
          .setPlaceholder("bot@acme.com")
          .setValue(this.draft.username ?? "")
          .onChange((v) => (this.draft.username = v.trim())),
      );
    }

    new Setting(contentEl).setName(t("modal.secret.value")).addText((txt) => {
      txt.inputEl.type = "password";
      txt.inputEl.autocomplete = "off";
      txt.setPlaceholder(this.existing ? t("modal.secret.valueKeep") : "••••••••");
      txt.setValue(this.draft.value).onChange((v) => (this.draft.value = v));
    });

    new Setting(contentEl).setName(t("modal.secret.description")).addText((txt) =>
      txt.setValue(this.draft.description).onChange((v) => (this.draft.description = v)),
    );

    new Setting(contentEl)
      .setName(t("modal.secret.hosts"))
      .setDesc(t("modal.secret.hostsDesc"))
      .addTextArea((ta) => {
        ta.inputEl.rows = 3;
        ta.setPlaceholder("acme.atlassian.net")
          .setValue(this.draft.allowedHosts.join("\n"))
          .onChange((v) => (this.draft.allowedHosts = v.split(/[\n,]/).map((h) => h.trim()).filter(Boolean)));
      });

    new Setting(contentEl).setName(t("modal.secret.approval")).addDropdown((dd) => {
      for (const a of APPROVALS) dd.addOption(a, t(`approval.${a}`));
      dd.setValue(this.draft.approval).onChange((v) => (this.draft.approval = v as ApprovalPolicy));
    });

    new Setting(contentEl)
      .setName(t("modal.secret.inUrl"))
      .setDesc(t("modal.secret.inUrlDesc"))
      .addToggle((tg) => tg.setValue(this.draft.placement.url).onChange((v) => (this.draft.placement.url = v)));
    new Setting(contentEl)
      .setName(t("modal.secret.inBody"))
      .setDesc(t("modal.secret.inBodyDesc"))
      .addToggle((tg) => tg.setValue(this.draft.placement.body).onChange((v) => (this.draft.placement.body = v)));
    new Setting(contentEl)
      .setName(t("modal.secret.localhost"))
      .addToggle((tg) => tg.setValue(this.draft.allowHttpLocalhost).onChange((v) => (this.draft.allowHttpLocalhost = v)));

    new Setting(contentEl)
      .addButton((b) => b.setButtonText(t("modal.secret.cancel")).onClick(() => this.close()))
      .addButton((b) =>
        b
          .setButtonText(t("modal.secret.save"))
          .setCta()
          .onClick(() => void this.save()),
      );
  }

  private async save(): Promise<void> {
    const badHost = this.draft.allowedHosts.find((h) => !isValidPattern(h));
    if (badHost) {
      const tooBroad = wildcardRisk(badHost) === "public-suffix";
      new Notice(tooBroad ? t("modal.secret.publicSuffix", { host: badHost }) : t("modal.secret.badHost", { host: badHost }), 8000);
      return;
    }
    // Wildcards on shared platforms (e.g. *.atlassian.net) reach other customers' tenants.
    const shared = this.draft.allowedHosts.filter((h) => wildcardRisk(h) === "multitenant");
    if (shared.length > 0) {
      const tenant = parsePattern(shared[0])?.host ?? "";
      new ConfirmModal(this.app, t("modal.secret.multitenant", { hosts: shared.join(", "), example: `acme.${tenant}` }), () => this.commit()).open();
      return;
    }
    await this.commit();
  }

  private async commit(): Promise<void> {
    const input: SecretInput = { ...this.draft, username: this.draft.type === "basic" ? this.draft.username : undefined };
    try {
      let saved: SecretRecord;
      if (this.existing) {
        const patch: Partial<SecretInput> = { ...input, value: input.value ? input.value : undefined };
        saved = await this.store.update(this.existing.id, patch);
      } else {
        saved = await this.store.add(input);
      }
      this.draft.value = "";
      this.close();
      this.onSaved(saved);
    } catch (err) {
      new Notice(err instanceof Error ? err.message : String(err));
    }
  }

  onClose(): void {
    this.draft.value = "";
    this.contentEl.empty();
  }
}

/** Shown when a request needs the user's approval. Resolves false on deny, close or timeout. */
export class ApprovalModal extends Modal {
  private decided = false;
  private timer: number | undefined;

  constructor(
    app: App,
    private readonly request: ApprovalRequest,
    private readonly timeoutSeconds: number,
    private readonly resolve: (approved: boolean) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    this.titleEl.setText(t("modal.approval.title"));
    contentEl.createEl("p", { text: t("modal.approval.body", { client: this.request.client, secrets: this.request.secrets.join(", ") }) });
    const pre = contentEl.createEl("pre", { cls: "ev-approval-target" });
    pre.setText(`${this.request.method} ${this.request.url}`);
    const countdown = contentEl.createEl("p", { cls: "ev-muted" });
    let remaining = this.timeoutSeconds;
    const tick = () => {
      countdown.setText(t("modal.approval.timeout", { s: remaining }));
      if (remaining-- <= 0) this.finish(false);
    };
    tick();
    this.timer = window.setInterval(tick, 1000);
    new Setting(contentEl)
      .addButton((b) => b.setButtonText(t("modal.approval.deny")).onClick(() => this.finish(false)))
      .addButton((b) =>
        b
          .setButtonText(t("modal.approval.allow"))
          .setDestructive()
          .onClick(() => this.finish(true)),
      );
  }

  private finish(approved: boolean): void {
    if (!this.decided) {
      this.decided = true;
      this.resolve(approved);
    }
    this.close();
  }

  onClose(): void {
    if (this.timer !== undefined) window.clearInterval(this.timer);
    if (!this.decided) {
      this.decided = true;
      this.resolve(false);
    }
    this.contentEl.empty();
  }
}

export class ConfirmModal extends Modal {
  constructor(
    app: App,
    private readonly message: string,
    private readonly onConfirm: () => void | Promise<void>,
  ) {
    super(app);
  }

  onOpen(): void {
    this.contentEl.createEl("p", { text: this.message });
    new Setting(this.contentEl)
      .addButton((b) => b.setButtonText(t("modal.secret.cancel")).onClick(() => this.close()))
      .addButton((b) =>
        b
          .setButtonText(t("modal.confirm.ok"))
          .setDestructive()
          .onClick(() => {
            this.close();
            void this.onConfirm();
          }),
      );
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

export class PromptModal extends Modal {
  private value = "";

  constructor(
    app: App,
    private readonly label: string,
    private readonly onSubmit: (value: string) => void | Promise<void>,
  ) {
    super(app);
  }

  onOpen(): void {
    new Setting(this.contentEl).setName(this.label).addText((txt) => {
      txt.onChange((v) => (this.value = v));
      txt.inputEl.addEventListener("keydown", (e) => {
        if (e.key === "Enter") this.submit();
      });
      window.setTimeout(() => txt.inputEl.focus(), 0);
    });
    new Setting(this.contentEl).addButton((b) =>
      b
        .setButtonText(t("modal.confirm.ok"))
        .setCta()
        .onClick(() => this.submit()),
    );
  }

  private submit(): void {
    this.close();
    void this.onSubmit(this.value);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/** Shows a new client token once, with the Claude Code command ready to copy. */
export class ClientTokenModal extends Modal {
  constructor(
    app: App,
    private readonly token: string,
    private readonly port: number,
    private readonly serverRunning: boolean,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    this.titleEl.setText(t("modal.client.title"));
    contentEl.createEl("p", { text: t("modal.client.body") });
    this.codeRow(this.token, t("modal.client.copy"));
    contentEl.createEl("p", { text: t("modal.client.claude") });
    const command = `claude mcp add --transport http environment-variables http://127.0.0.1:${this.port}/mcp --header "Authorization: Bearer ${this.token}"`;
    this.codeRow(command, t("modal.client.copyCommand"));
    if (!this.serverRunning) contentEl.createEl("p", { text: t("modal.client.serverOff"), cls: "ev-warning" });
  }

  private codeRow(text: string, label: string): void {
    const row = this.contentEl.createDiv({ cls: "ev-code-row" });
    row.createEl("code", { text });
    const btn = row.createEl("button", { text: label });
    btn.addEventListener("click", () => {
      void navigator.clipboard.writeText(text);
      new Notice(t("view.copied", { key: label }));
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

export class SecretPickerModal extends SuggestModal<string> {
  constructor(
    app: App,
    private readonly store: SecretStore,
    private readonly onPick: (secret: SecretRecord) => void,
  ) {
    super(app);
    this.setPlaceholder(t("modal.pick.placeholder"));
  }

  getSuggestions(query: string): string[] {
    const q = query.toLowerCase();
    return this.store.names().filter((n) => n.toLowerCase().includes(q));
  }

  renderSuggestion(name: string, el: HTMLElement): void {
    const secret = this.store.get(name);
    el.createDiv({ text: name });
    if (secret) el.createEl("small", { text: `${t(`type.${secret.type}`)} · ${secret.allowedHosts.join(", ")}`, cls: "ev-muted" });
  }

  onChooseSuggestion(name: string): void {
    const secret = this.store.get(name);
    if (secret) this.onPick(secret);
  }
}

/** Chooses which variables an AI client may use. "All" also covers variables created later. */
export class AccessModal extends Modal {
  private mode: ClientAccess["mode"];
  private selected: Set<string>;

  constructor(
    app: App,
    private readonly store: SecretStore,
    private readonly clientName: string,
    current: ClientAccess | null,
    private readonly onSave: (access: ClientAccess) => void | Promise<void>,
  ) {
    super(app);
    this.mode = current?.mode ?? "some";
    this.selected = new Set(current?.mode === "some" ? current.secretIds : []);
  }

  onOpen(): void {
    this.titleEl.setText(t("modal.access.title", { client: this.clientName }));
    this.render();
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("p", { text: t("modal.access.body"), cls: "ev-muted" });

    const secrets = this.store.list();
    new Setting(contentEl)
      .setName(t("modal.access.all"))
      .setDesc(t("modal.access.allDesc"))
      .addToggle((tg) =>
        tg.setValue(this.mode === "all").onChange((v) => {
          this.mode = v ? "all" : "some";
          this.render();
        }),
      );

    if (this.mode === "some") {
      if (secrets.length === 0) contentEl.createDiv({ text: t("view.empty"), cls: "ev-muted" });
      for (const s of secrets) {
        new Setting(contentEl)
          .setName(s.name)
          .setDesc(s.allowedHosts.join(", "))
          .addToggle((tg) =>
            tg.setValue(this.selected.has(s.id)).onChange((v) => {
              if (v) this.selected.add(s.id);
              else this.selected.delete(s.id);
            }),
          );
      }
    }

    new Setting(contentEl)
      .addButton((b) => b.setButtonText(t("modal.secret.cancel")).onClick(() => this.close()))
      .addButton((b) =>
        b
          .setButtonText(t("modal.secret.save"))
          .setCta()
          .onClick(() => {
            const access: ClientAccess = this.mode === "all" ? { mode: "all" } : { mode: "some", secretIds: [...this.selected] };
            this.close();
            void this.onSave(access);
          }),
      );
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
