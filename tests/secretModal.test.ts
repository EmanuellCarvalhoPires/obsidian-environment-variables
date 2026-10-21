import { beforeEach, describe, expect, it, vi } from "vitest";

// A tiny stand-in for the parts of Obsidian the two forms use: enough to type into them and press their buttons.
const fake = vi.hoisted(() => {
  const shown: string[] = [];
  const notices: string[] = [];

  /** Any element: every method returns another element, and the text passed to it is recorded. */
  function makeEl(): any {
    return new Proxy(function () {}, {
      get(_target, prop) {
        if (prop === "then") return undefined;
        if (prop === "style") return {};
        return (...args: unknown[]) => {
          for (const arg of args) {
            if (typeof arg === "object" && arg !== null && typeof (arg as { text?: unknown }).text === "string") shown.push((arg as { text: string }).text);
          }
          if (prop === "setText" && typeof args[0] === "string") shown.push(args[0]);
          return makeEl();
        };
      },
      set: () => true,
    });
  }

  class TextC {
    value = "";
    handler: ((v: string) => void) | undefined;
    inputEl = makeEl();
    setValue(v: string) {
      this.value = v;
      return this;
    }
    setPlaceholder() {
      return this;
    }
    onChange(h: (v: string) => void) {
      this.handler = h;
      return this;
    }
    /** The user types. */
    type(v: string) {
      this.value = v;
      this.handler?.(v);
    }
  }
  class ButtonC {
    text = "";
    disabled = false;
    handler: (() => void) | undefined;
    setButtonText(t: string) {
      this.text = t;
      return this;
    }
    setCta() {
      return this;
    }
    setDestructive() {
      return this;
    }
    setDisabled(d: boolean) {
      this.disabled = d;
      return this;
    }
    onClick(h: () => void) {
      this.handler = h;
      return this;
    }
    click() {
      if (!this.disabled) this.handler?.();
    }
  }
  class ChoiceC {
    handler: ((v: string) => void) | undefined;
    addOption() {
      return this;
    }
    setValue() {
      return this;
    }
    onChange(h: (v: string) => void) {
      this.handler = h;
      return this;
    }
  }
  class Setting {
    static all: Setting[] = [];
    name = "";
    desc = "";
    nameEl = makeEl();
    descEl = makeEl();
    settingEl = makeEl();
    texts: TextC[] = [];
    buttons: ButtonC[] = [];
    dropdowns: ChoiceC[] = [];
    constructor(_parent: unknown) {
      Setting.all.push(this);
    }
    setName(n: string) {
      this.name = n;
      return this;
    }
    setDesc(d: string) {
      this.desc = d;
      return this;
    }
    setClass() {
      return this;
    }
    setHeading() {
      return this;
    }
    addText(cb: (c: TextC) => void) {
      const c = new TextC();
      this.texts.push(c);
      cb(c);
      return this;
    }
    addTextArea(cb: (c: TextC) => void) {
      return this.addText(cb);
    }
    addToggle(cb: (c: ChoiceC) => void) {
      cb(new ChoiceC());
      return this;
    }
    addDropdown(cb: (c: ChoiceC) => void) {
      const c = new ChoiceC();
      this.dropdowns.push(c);
      cb(c);
      return this;
    }
    addButton(cb: (c: ButtonC) => void) {
      const c = new ButtonC();
      this.buttons.push(c);
      cb(c);
      return this;
    }
  }
  class Modal {
    titleEl = makeEl();
    contentEl = makeEl();
    private opened = false;
    constructor(public app: unknown) {}
    open() {
      this.opened = true;
      (this as unknown as { onOpen?: () => void }).onOpen?.();
    }
    close() {
      if (!this.opened) return;
      this.opened = false;
      (this as unknown as { onClose?: () => void }).onClose?.();
    }
  }
  class Notice {
    constructor(message: unknown) {
      notices.push(String(message));
    }
  }
  class SuggestModal extends Modal {}
  class ButtonComponent {}
  return { shown, notices, Setting, Modal, Notice, SuggestModal, ButtonComponent, TextC, ButtonC };
});

vi.mock("obsidian", () => ({
  Modal: fake.Modal,
  Notice: fake.Notice,
  Setting: fake.Setting,
  SuggestModal: fake.SuggestModal,
  ButtonComponent: fake.ButtonComponent,
  setIcon: () => undefined,
  getLanguage: () => "en",
}));

const { SecretModal, ValueModal } = await import("../src/ui/modals");
const { secretInput, unlockedStore } = await import("./helpers");
type Store = Awaited<ReturnType<typeof unlockedStore>>["store"];

const A_VALUE = "text-typed-by-the-user-5521";

/** The last control with this label, like the form on screen. */
function field(name: string) {
  const found = [...fake.Setting.all].reverse().find((s) => s.name === name);
  if (!found) throw new Error(`No field ${name}`);
  return found;
}
const nameField = () => field("Name").texts[0];
const valueField = () => field("Value").texts[0];
const saveButton = () => [...fake.Setting.all].reverse().find((s) => s.buttons.length === 2)!.buttons[1];

beforeEach(() => {
  fake.shown.length = 0;
  fake.notices.length = 0;
  fake.Setting.all.length = 0;
});

async function storeWithNames(): Promise<Store> {
  const { store } = await unlockedStore();
  await store.add(secretInput({ name: "JIRA_ACME", type: "token", username: undefined }));
  await store.addValue({ name: "PROJECT_KEY", kind: "texto", value: "ACME-1234", description: "", allowedHosts: [] });
  return store;
}

describe("create-only secret form (opened by env_criar_secret)", () => {
  it("starts with the agent's suggestions, says an agent asked, and keeps full access and any host off", async () => {
    const store = await storeWithNames();
    const onSaved = vi.fn();
    const onClosed = vi.fn();
    new SecretModal(
      {} as never,
      store,
      null,
      onSaved,
      "",
      { createOnly: true, fromAgent: true, prefill: { name: "GITHUB_API", type: "bearer", description: "GitHub", allowedHosts: ["api.github.com"] }, onClosed },
    ).open();

    expect(nameField().value).toBe("GITHUB_API");
    expect(fake.shown.some((s) => /AI agent asked for this variable/.test(s))).toBe(true);
    expect(saveButton().disabled).toBe(false);

    valueField().type(A_VALUE);
    saveButton().click();
    await vi.waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));

    const created = store.get("GITHUB_API")!;
    expect(created).toMatchObject({ type: "bearer", description: "GitHub", allowedHosts: ["api.github.com"], value: A_VALUE });
    expect(created.fullAccess).toBe(false);
    expect(created.allowAnyHost).toBe(false);
    expect(onSaved.mock.calls[0][0].name).toBe("GITHUB_API");
    expect(onClosed).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("disables Create when the name is a secret that already exists, with the message, and never overwrites it", async () => {
    const store = await storeWithNames();
    const before = store.get("JIRA_ACME")!.value;
    const onSaved = vi.fn();
    new SecretModal({} as never, store, null, onSaved, "", { createOnly: true, prefill: { name: "JIRA_ACME" } }).open();

    expect(saveButton().disabled).toBe(true);
    expect(fake.shown.some((s) => /JIRA_ACME already exists\. It cannot be changed from here/.test(s))).toBe(true);

    valueField().type(A_VALUE);
    saveButton().click(); // a disabled button does nothing
    await new Promise((r) => setTimeout(r, 10));
    expect(onSaved).not.toHaveBeenCalled();
    expect(store.get("JIRA_ACME")!.value).toBe(before);
    expect(store.list()).toHaveLength(1);
  });

  it("disables Create when the name is already a value, and enables it again with a free name", async () => {
    const store = await storeWithNames();
    new SecretModal({} as never, store, null, () => undefined, "", { createOnly: true }).open();
    expect(saveButton().disabled).toBe(false); // nothing typed yet

    nameField().type("PROJECT_KEY");
    expect(saveButton().disabled).toBe(true);
    expect(fake.shown.some((s) => /PROJECT_KEY already exists/.test(s))).toBe(true);

    nameField().type("FREE_NAME");
    expect(saveButton().disabled).toBe(false);
    nameField().type("JIRA_ACME");
    expect(saveButton().disabled).toBe(true);
  });

  it("answers closed-without-saving when the form is closed", async () => {
    const store = await storeWithNames();
    const onClosed = vi.fn();
    const modal = new SecretModal({} as never, store, null, () => undefined, "", { createOnly: true, onClosed });
    modal.open();
    modal.close();
    expect(onClosed).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("the usual New variable form also refuses a name used by a value", async () => {
    const store = await storeWithNames();
    new SecretModal({} as never, store, null).open();
    nameField().type("PROJECT_KEY");
    expect(saveButton().disabled).toBe(true);
  });
});

describe("Values form", () => {
  it("creates a value and shares the namespace with secrets", async () => {
    const store = await storeWithNames();
    const onSaved = vi.fn();
    new ValueModal({} as never, store, onSaved).open();

    nameField().type("JIRA_ACME"); // a secret
    expect(saveButton().disabled).toBe(true);
    nameField().type("BOARD_ID");
    expect(saveButton().disabled).toBe(false);

    valueField().type("1234567");
    saveButton().click();
    await vi.waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(store.getValue("BOARD_ID")).toMatchObject({ kind: "texto", value: "1234567", createdBy: "obsidian", allowedHosts: [] });
  });

  it("warns that a value shorter than 6 characters will not be masked, and asks before creating it", async () => {
    const store = await storeWithNames();
    const onSaved = vi.fn();
    new ValueModal({} as never, store, onSaved).open();
    nameField().type("SHORT_ONE");
    valueField().type("abc");
    expect(fake.shown.some((s) => /Shorter than 6 characters.*will not be masked/.test(s))).toBe(true);

    saveButton().click();
    await new Promise((r) => setTimeout(r, 10));
    expect(onSaved).not.toHaveBeenCalled(); // waiting for the confirmation
    const confirm = [...fake.Setting.all].reverse().find((s) => s.buttons.some((b) => b.text === "Confirm"))!;
    confirm.buttons.find((b) => b.text === "Confirm")!.click();
    await vi.waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(store.getValue("SHORT_ONE")?.value).toBe("abc");
  });

  it("refuses text that does not fit the kind", async () => {
    const store = await storeWithNames();
    new ValueModal({} as never, store).open();
    nameField().type("NUMBER_ONE");
    field("Kind").dropdowns[0].handler!("numero"); // re-renders the form
    nameField().type("NUMBER_ONE");
    valueField().type("twelve");
    saveButton().click();
    await new Promise((r) => setTimeout(r, 10));
    expect(fake.notices.some((n) => /not valid for the kind Number/.test(n))).toBe(true);
    expect(store.getValue("NUMBER_ONE")).toBeUndefined();
  });
});
