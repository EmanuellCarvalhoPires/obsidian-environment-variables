import { ItemView, Notice, setIcon, setTooltip, WorkspaceLeaf } from "obsidian";
import { ActivityEvent, ActivityLevel, ActivityLine, ActivitySession, ActivityStatus } from "../activity/activityLog";
import { t } from "../i18n";
import type EnvironmentVariablesPlugin from "../main";

export const ACTIVITY_VIEW_TYPE = "environment-variables-activity";

type Filter = "all" | "running" | "problems";
const FILTERS: Filter[] = ["all", "running", "problems"];

/** Short labels of the terminal lines. Words, not colors alone, tell the levels apart. */
const TAGS: Record<ActivityLevel, string> = { info: "info", step: "step", ok: "ok", warn: "warn", error: "error" };

interface Row {
  session: ActivitySession;
  el: HTMLDetailsElement;
  summary: HTMLElement;
  term: HTMLElement;
  prompt: HTMLElement;
}

/**
 * Every tool call of the AI clients as a dropdown, with the terminal of what the plugin did inside:
 * the request received, the placeholders found, the replacement (values hidden), the approval and the
 * response. It updates line by line while a call runs.
 */
export class ActivityView extends ItemView {
  private rows = new Map<string, Row>();
  private filter: Filter = "all";
  private autoOpen = true;
  private list!: HTMLElement;
  private emptyEl!: HTMLElement;
  private liveDot!: HTMLElement;
  private liveLabel!: HTMLElement;
  private filterButtons = new Map<Filter, HTMLButtonElement>();
  private unsubscribers: Array<() => void> = [];

  constructor(
    leaf: WorkspaceLeaf,
    private readonly plugin: EnvironmentVariablesPlugin,
  ) {
    super(leaf);
  }

  getViewType(): string {
    return ACTIVITY_VIEW_TYPE;
  }

  getDisplayText(): string {
    return t("view.act.title");
  }

  getIcon(): string {
    return "activity";
  }

  onOpen(): Promise<void> {
    const root = this.contentEl;
    root.empty();
    root.addClass("ev-act-view");
    this.buildHeader(root);
    this.buildToolbar(root);
    this.list = root.createDiv({ cls: "ev-act-list" });
    this.emptyEl = root.createDiv({ cls: "ev-act-empty" });
    this.emptyEl.createDiv({ text: t("view.act.empty"), cls: "ev-act-empty-title" });
    this.emptyEl.createDiv({ text: t("view.act.emptyDesc"), cls: "ev-muted" });

    // Oldest first, because every row is added at the top.
    for (const s of this.plugin.activity.list().reverse()) this.addRow(s, false);
    this.refreshVisibility();

    this.unsubscribers.push(
      this.plugin.activity.onEvent((e) => this.handle(e)),
      this.plugin.onServerChange(() => this.refreshLive()),
    );
    this.registerInterval(window.setInterval(() => this.tick(), 250));
    this.refreshLive();
    return Promise.resolve();
  }

  onClose(): Promise<void> {
    for (const u of this.unsubscribers) u();
    this.unsubscribers = [];
    this.rows.clear();
    return Promise.resolve();
  }

  // ---------- layout ----------

  private buildHeader(root: HTMLElement): void {
    const header = root.createDiv({ cls: "ev-act-header" });
    const top = header.createDiv({ cls: "ev-act-header-top" });
    top.createEl("h2", { text: t("view.act.title"), cls: "ev-act-heading" });
    const live = top.createDiv({ cls: "ev-act-live" });
    this.liveDot = live.createSpan({ cls: "ev-dot" });
    this.liveLabel = live.createSpan();
    header.createDiv({ text: t("view.act.subtitle"), cls: "ev-muted" });
    header.createDiv({ text: t("view.act.memory"), cls: "ev-muted" });
  }

  private buildToolbar(root: HTMLElement): void {
    const bar = root.createDiv({ cls: "ev-act-toolbar" });

    const filters = bar.createDiv({ cls: "ev-act-filters", attr: { role: "group" } });
    for (const f of FILTERS) {
      const b = filters.createEl("button", { text: t(`view.act.filter.${f}`), cls: "ev-act-btn", attr: { "aria-pressed": String(f === this.filter) } });
      this.registerDomEvent(b, "click", () => this.setFilter(f));
      this.filterButtons.set(f, b);
    }

    const auto = bar.createEl("label", { cls: "ev-act-auto" });
    const check = auto.createEl("input", { type: "checkbox" });
    check.checked = this.autoOpen;
    auto.createSpan({ text: t("view.act.autoOpen") });
    setTooltip(auto, t("view.act.autoOpenTip"));
    this.registerDomEvent(check, "change", () => (this.autoOpen = check.checked));

    const spacer = bar.createDiv({ cls: "ev-act-spacer" });
    spacer.setAttr("aria-hidden", "true");

    this.iconButton(bar, "chevrons-down", t("view.act.expandAll"), () => this.setAllOpen(true));
    this.iconButton(bar, "chevrons-up", t("view.act.collapseAll"), () => this.setAllOpen(false));
    const clear = bar.createEl("button", { text: t("view.act.clear"), cls: "ev-act-btn", attr: { "aria-label": t("view.act.clearTip") } });
    setTooltip(clear, t("view.act.clearTip"));
    this.registerDomEvent(clear, "click", () => this.plugin.activity.clear());
  }

  private iconButton(parent: HTMLElement, icon: string, label: string, onClick: () => void): HTMLButtonElement {
    const b = parent.createEl("button", { cls: "ev-act-btn ev-act-icon-btn clickable-icon", attr: { "aria-label": label } });
    setIcon(b, icon);
    setTooltip(b, label);
    this.registerDomEvent(b, "click", onClick);
    return b;
  }

  private refreshLive(): void {
    const on = this.plugin.server?.running ?? false;
    this.liveDot.toggleClass("is-on", on);
    this.liveDot.toggleClass("is-off", !on);
    this.liveLabel.setText(on ? t("view.act.live") : t("view.server.off"));
  }

  // ---------- events ----------

  private handle(e: ActivityEvent): void {
    switch (e.type) {
      case "begin":
        this.addRow(e.session, this.autoOpen);
        break;
      case "line": {
        const row = this.rows.get(e.session.id);
        if (row) this.appendLine(row, e.line);
        break;
      }
      case "update":
      case "end": {
        const row = this.rows.get(e.session.id);
        if (!row) break;
        this.renderSummary(row);
        if (e.type === "end" && e.session.droppedLines > 0) {
          row.term.createDiv({ text: t("view.act.linesDropped", { n: e.session.droppedLines }), cls: "ev-act-omitted" });
        }
        break;
      }
      case "remove":
        for (const id of e.ids) {
          this.rows.get(id)?.el.remove();
          this.rows.delete(id);
        }
        break;
    }
    this.refreshVisibility();
  }

  private setFilter(filter: Filter): void {
    this.filter = filter;
    for (const [f, b] of this.filterButtons) b.setAttr("aria-pressed", String(f === filter));
    this.refreshVisibility();
  }

  private setAllOpen(open: boolean): void {
    for (const row of this.rows.values()) row.el.open = open;
  }

  /** Applies the filter to every row, and shows the empty message when nothing is visible. */
  private refreshVisibility(): void {
    let visible = 0;
    for (const row of this.rows.values()) {
      const show = matches(row.session, this.filter);
      row.el.toggleClass("ev-hidden", !show);
      if (show) visible++;
    }
    this.emptyEl.toggleClass("ev-hidden", visible > 0);
    this.emptyEl.querySelector(".ev-act-empty-title")?.setText(this.rows.size > 0 ? t("view.act.noMatch") : t("view.act.empty"));
    this.emptyEl.querySelector(".ev-muted")?.toggleClass("ev-hidden", this.rows.size > 0);
  }

  /** Keeps the duration of the running calls moving. */
  private tick(): void {
    for (const row of this.rows.values()) {
      if (row.session.status !== "running") continue;
      row.summary.querySelector(".ev-act-duration")?.setText(duration(Date.now() - row.session.startedAt));
    }
  }

  // ---------- rows ----------

  private addRow(session: ActivitySession, open: boolean): void {
    const el = this.list.createEl("details", { cls: "ev-act" });
    this.list.prepend(el);
    el.open = open;
    const summary = el.createEl("summary", { cls: "ev-act-summary" });
    const body = el.createDiv({ cls: "ev-act-body" });
    const term = body.createDiv({ cls: "ev-act-term", attr: { role: "log", "aria-live": "off", tabindex: "0" } });
    const prompt = term.createDiv({ cls: "ev-act-prompt" });
    const row: Row = { session, el, summary, term, prompt };
    this.rows.set(session.id, row);

    const copy = body.createEl("button", { cls: "ev-act-btn ev-act-copy", text: t("view.act.copy") });
    this.registerDomEvent(copy, "click", () => {
      void navigator.clipboard.writeText(plainText(row.session));
      new Notice(t("view.act.copied"));
    });

    this.renderSummary(row);
    for (const line of session.lines) this.appendLine(row, line);
  }

  private renderSummary(row: Row): void {
    const s = row.session;
    const el = row.summary;
    el.empty();
    el.toggleClass("is-running", s.status === "running");
    setIcon(el.createSpan({ cls: "ev-act-chevron" }), "chevron-right");

    const title = el.createSpan({ cls: "ev-act-title" });
    const [before, after] = t("view.act.used", { tool: "\u0001" }).split("\u0001");
    title.createSpan({ text: before });
    title.createEl("code", { text: s.tool, cls: "ev-act-tool" });
    title.createSpan({ text: after });
    if (s.via) title.createSpan({ text: ` ${t("view.act.via", { tool: s.via })}`, cls: "ev-muted" });

    const target = [s.method, s.target].filter(Boolean).join(" ");
    const extra = s.requests > 1 ? ` (${t("view.act.requests", { n: s.requests })})` : "";
    el.createSpan({ text: target + extra, cls: "ev-act-target", attr: { title: target } });

    if (s.secrets.length > 0) {
      const chips = el.createSpan({ cls: "ev-act-chips", attr: { "aria-label": t("view.act.variables") } });
      for (const name of s.secrets) {
        const chip = chips.createSpan({ cls: "ev-act-chip" });
        setIcon(chip.createSpan({ cls: "ev-act-chip-icon" }), "key-round");
        chip.createSpan({ text: name });
      }
    }

    const meta = el.createSpan({ cls: "ev-act-meta" });
    const status = meta.createSpan({ cls: `ev-act-status ev-act-status-${s.status}${s.httpStatus !== undefined && s.httpStatus >= 400 ? " is-warn" : ""}` });
    if (s.status === "running") status.createSpan({ cls: "ev-act-spinner" });
    status.createSpan({ text: statusText(s.status, s.httpStatus) });
    meta.createSpan({ text: duration((s.endedAt ?? Date.now()) - s.startedAt), cls: "ev-act-duration ev-muted" });
    meta.createSpan({ text: clock(s.startedAt), cls: "ev-act-clock ev-muted", attr: { title: `${new Date(s.startedAt).toLocaleString()} · ${s.client}` } });

    // The first line of the terminal: who ran what. Redrawn because the tool can be learned later (run_vault_tool).
    row.prompt.empty();
    row.prompt.createSpan({ text: "$ ", cls: "ev-act-prompt-sign" });
    row.prompt.createSpan({ text: s.tool });
    row.prompt.createSpan({ text: `  [${s.client}]`, cls: "ev-act-prompt-client" });
  }

  private appendLine(row: Row, line: ActivityLine): void {
    const term = row.term;
    const stick = term.scrollHeight - term.scrollTop - term.clientHeight < 40;
    const div = term.createDiv({ cls: `ev-act-line ev-act-${line.level}` });
    div.createSpan({ text: clock(line.time, true), cls: "ev-act-time" });
    div.createSpan({ text: TAGS[line.level], cls: "ev-act-tag" });
    div.createSpan({ text: t(line.key, line.params ?? {}), cls: "ev-act-msg" });
    if (line.data) term.createEl("pre", { text: line.data, cls: "ev-act-data" });
    if (line.omitted) term.createDiv({ text: t("view.act.dataOmitted", { n: line.omitted }), cls: "ev-act-omitted" });
    if (stick) term.scrollTop = term.scrollHeight;
  }
}

// ---------- helpers ----------

function matches(s: ActivitySession, filter: Filter): boolean {
  if (filter === "running") return s.status === "running";
  if (filter === "problems") return s.status !== "running" && (s.status !== "ok" || (s.httpStatus !== undefined && s.httpStatus >= 400));
  return true;
}

function statusText(status: ActivityStatus, httpStatus?: number): string {
  const label = t(`view.act.status.${status}`);
  return status === "ok" && httpStatus !== undefined ? `${label} ${httpStatus}` : label;
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, "0");
}

/** HH:MM:SS, or HH:MM:SS.mmm inside the terminal. */
function clock(ms: number, millis = false): string {
  const d = new Date(ms);
  const base = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  return millis ? `${base}.${pad(d.getMilliseconds(), 3)}` : base;
}

function duration(ms: number): string {
  return ms < 1000 ? `${Math.max(0, Math.round(ms))} ms` : `${(ms / 1000).toFixed(1)} s`;
}

/** The terminal as plain text, to paste into a ticket or a chat. Same masked content as the panel. */
function plainText(s: ActivitySession): string {
  const out = [`$ ${s.tool}  [${s.client}]`];
  for (const line of s.lines) {
    out.push(`${clock(line.time, true)} ${TAGS[line.level].padEnd(5)} ${t(line.key, line.params ?? {})}`);
    if (line.data) out.push(...line.data.split("\n").map((l) => `    ${l}`));
    if (line.omitted) out.push(`    ${t("view.act.dataOmitted", { n: line.omitted })}`);
  }
  return out.join("\n");
}
